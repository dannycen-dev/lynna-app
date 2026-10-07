import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { slotLabel, upcomingAppointment } from "../crm/agenda";
import { developments, prospects, tenants } from "../db/schema";
import { todayIn } from "../financing";
import { auditInsert } from "../lib/audit";
import { log } from "../lib/log";
import { extractAmounts, validateReply } from "./guard";
import { detectEscalation, isOptOut } from "./intent";
import type { ChatMessage, LlmClient } from "./llm";
import { buildSystemPrompt, FALLBACK_REPLY, MEDIA_REPLY, OPT_OUT_REPLY } from "./prompt";
import { escalate, newFacts, rememberSlot, runTool, TOOL_SPECS, type EscalationReason, type ToolContext } from "./tools";

const MAX_TOOL_ROUNDS = 5;
const HISTORY_LIMIT = 16;
const MEDIA_TYPES = new Set(["image", "document", "audio", "video", "sticker"]);

export type HistoryMessage = { direction: "in" | "out"; body: string | null; type: string };

export type AgentInput = {
  db: Db;
  llm: LlmClient;
  tenant: { id: string; name: string };
  conversationId: string;
  prospect: typeof prospects.$inferSelect;
  /** Mensajes previos (sin los nuevos), del más antiguo al más reciente. */
  history: HistoryMessage[];
  /** Mensajes del prospecto que disparan esta respuesta. */
  incoming: { type: string; body: string | null }[];
};

export type ToolTrace = { name: string; args: Record<string, unknown>; result: string };

export type AgentResult = {
  reply: string;
  draft: string | null;
  toolTrace: ToolTrace[];
  blocked: string[];
  escalation: EscalationReason | null;
  fallback: boolean;
  /** Respuesta sin modelo (archivos, baja): no se consumieron neuronas. */
  deterministic: boolean;
  /** Modelos que realmente respondieron en este turno (incluye el de respaldo si entró). */
  modelsUsed: string[];
  neurons: number;
  latencyMs: number;
};

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const started = Date.now();
  const ctx: ToolContext = {
    db: input.db,
    tenantId: input.tenant.id,
    prospectId: input.prospect.id,
    conversationId: input.conversationId,
    facts: newFacts(),
    escalation: null,
  };
  const incomingText = input.incoming
    .map((m) => m.body?.trim())
    .filter(Boolean)
    .join("\n");
  // Lo que el propio prospecto dijo (su presupuesto, su enganche) se puede repetir: cuenta como dato verificado.
  for (const amount of extractAmounts(incomingText.replace(/(\d[\d,.]*)\s*(pesos|mxn)\b/gi, "$$$1"))) ctx.facts.amounts.add(amount);
  const base = { draft: null, toolTrace: [], blocked: [], neurons: 0, modelsUsed: [] };
  const done = (r: Omit<AgentResult, "latencyMs" | "escalation">): AgentResult => ({
    ...r,
    escalation: ctx.escalation?.reason ?? null,
    latencyMs: Date.now() - started,
  });

  // 1. Archivos (INE, comprobantes, fotos): nunca pasan por el modelo.
  if (input.incoming.some((m) => MEDIA_TYPES.has(m.type))) {
    await escalate(ctx, "documentos", `El prospecto envió ${input.incoming.filter((m) => MEDIA_TYPES.has(m.type)).length} archivo(s).`);
    return done({ ...base, reply: MEDIA_REPLY, fallback: false, deterministic: true });
  }

  // 2. Baja: se respeta sin pasar por el modelo.
  if (isOptOut(incomingText)) {
    await input.db.batch([
      input.db.update(prospects).set({ optedOutAt: Date.now(), updatedAt: Date.now() }).where(eq(prospects.id, input.prospect.id)),
      auditInsert(input.db, { tenantId: input.tenant.id, actor: "ai", entity: "prospect", entityId: input.prospect.id, action: "opted_out" }),
    ]);
    return done({ ...base, reply: OPT_OUT_REPLY, fallback: false, deterministic: true });
  }

  const devs = await input.db
    .select({ name: developments.name, city: developments.city })
    .from(developments)
    .where(and(eq(developments.tenantId, input.tenant.id), eq(developments.status, "active")))
    .orderBy(asc(developments.name));

  // Cita vigente: el modelo la conoce para reagendar o recordarla, y su hora cuenta como dato verificado.
  const [tenantRow, current] = await Promise.all([
    input.db.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, input.tenant.id)).get(),
    upcomingAppointment(input.db, input.prospect.id),
  ]);
  const timezone = tenantRow?.timezone ?? "America/Mexico_City";
  if (current) {
    rememberSlot(ctx.facts, slotLabel(current.startsAt, timezone));
    ctx.facts.existing = true;
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        assistantName: "Lynna",
        companyName: input.tenant.name,
        today: todayIn(),
        prospectName: input.prospect.name ?? input.prospect.profileName,
        developments: devs,
        handedOff: Boolean(input.prospect.handoffAt),
        appointment: current ? slotLabel(current.startsAt, timezone) : null,
      }),
    },
    ...input.history.slice(-HISTORY_LIMIT).map(
      (m): ChatMessage => (m.direction === "in" ? { role: "user", content: m.body ?? `[${m.type}]` } : { role: "assistant", content: m.body ?? "" }),
    ),
    { role: "user", content: incomingText || "[mensaje sin texto]" },
  ];

  const toolTrace: ToolTrace[] = [];
  const modelsUsed = new Set<string>();
  let neurons = 0;

  let truncated = false;

  /** Corre el ciclo modelo ↔ herramientas hasta obtener texto final. */
  async function converse(): Promise<string | null> {
    truncated = false;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const completion = await input.llm.complete({ messages, tools: round < MAX_TOOL_ROUNDS ? TOOL_SPECS : [] });
      neurons += completion.neurons;
      modelsUsed.add(completion.model ?? input.llm.model);
      if (completion.toolCalls.length === 0) {
        truncated = Boolean(completion.truncated);
        const text = completion.content?.trim() || null;
        if (!text) log("warn", "agent.empty_completion", { conversationId: input.conversationId, model: input.llm.model, round, raw: completion.raw });
        return text;
      }

      messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
      });
      for (const tc of completion.toolCalls) {
        const result = await runTool(ctx, tc.name, tc.args);
        toolTrace.push({ name: tc.name, args: tc.args, result });
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: result });
      }
    }
    return null;
  }

  const drafts: string[] = [];
  let draft: string | null = null;
  let reply: string | null = null;
  let blocked: string[] = [];
  let fallback = false;

  try {
    /** Un texto cortado por límite de tokens nunca se envía. */
    const validate = (text: string | null) =>
      !text ? ({ ok: false, reasons: ["respuesta vacía"] } as const) : truncated ? ({ ok: false, reasons: ["respuesta incompleta (límite de tokens)"] } as const) : validateReply(text, ctx.facts);

    draft = await converse();
    if (draft) drafts.push(draft);
    let check = validate(draft);

    if (draft && !check.ok) {
      // Un reintento: se le explica al modelo qué se bloqueó.
      blocked = [...check.reasons];
      messages.push({ role: "assistant", content: draft });
      messages.push({
        role: "user",
        content: `[Revisión interna, no la menciones] Tu respuesta no se envió porque: ${check.reasons.join("; ")}. Reescríbela usando solo datos de las herramientas; si no tienes el dato, ofrece que un asesor lo confirme.${
          check.reasons.some((r) => /cita|agenda/.test(r))
            ? " Si el prospecto pidió agendar, cambiar o cancelar su visita, llama primero a agendar_visita o cancelar_cita y confirma solo lo que la herramienta responda."
            : ""
        }`,
      });
      draft = await converse();
      if (draft) drafts.push(draft);
      check = validate(draft);
      if (!check.ok) blocked.push(...check.reasons);
    }
    if (draft && check.ok) reply = draft;
  } catch (err) {
    log("error", "agent.llm_failed", { conversationId: input.conversationId, model: input.llm.model, error: err instanceof Error ? err.message : String(err) });
    blocked.push("error del modelo");
  }

  if (!reply) {
    fallback = true;
    reply = FALLBACK_REPLY;
    await escalate(ctx, "otro", `Respuesta de la IA no disponible o bloqueada: ${blocked.join("; ") || "sin texto"}.`);
  }

  // 3. Red de seguridad: lo que el cliente pidió turnar a un humano se turna aunque el modelo no lo haya hecho.
  const detected = detectEscalation(incomingText);
  if (detected && !ctx.escalation) {
    await escalate(ctx, detected, `Detectado por reglas en: "${incomingText.slice(0, 200)}"`);
    if (!/asesor/i.test(reply)) reply = `${reply}\n\nUn asesor te contactará en breve para ayudarte con eso.`;
  }

  return done({ reply, draft: drafts.length ? drafts.join("\n\n--- reintento ---\n\n") : null, toolTrace, blocked: [...new Set(blocked)], fallback, deterministic: false, neurons, modelsUsed: [...modelsUsed] });
}
