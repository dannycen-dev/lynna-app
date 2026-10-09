import { and, asc, eq, inArray } from "drizzle-orm";
import { lotCardsBody } from "../whatsapp/outbound";
import type { Db } from "../db/client";
import { slotLabel, upcomingAppointment } from "../crm/agenda";
import { developments, messages, prospects, tenants } from "../db/schema";
import { todayIn } from "../financing";
import { auditInsert } from "../lib/audit";
import { log } from "../lib/log";
import { extractAmounts, validateReply } from "./guard";
import { claimsMaterialSent, detectEscalation, isOptOut, mentionsMoneyTransfer, requestedMaterial } from "./intent";
import type { ChatMessage, LlmClient } from "./llm";
import { buildSystemPrompt, fallbackReply, mediaReply, OPT_OUT_REPLY } from "./prompt";
import { advisorEta } from "../crm/business-hours";
import { officeClosedDates } from "../crm/time-off";
import { CONSENT_QUESTION, isAffirmative, isNegative, mentionsFinancialData, privacyNotice, recordConsent } from "../privacy/consent";
import { escalate, lotCarousel, lotList, newFacts, rememberSlot, runTool, TOOL_SPECS, type Attachment, type EscalationReason, type LotCards, type ToolContext } from "./tools";

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
  /** Cómo mostrar los lotes encontrados (por omisión, lista: se ve en todos los clientes de WhatsApp). */
  lotCards?: LotCards;
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
  /** Material para mandar después del texto (fotos, plano, ubicación, carrusel de lotes). */
  attachments: Attachment[];
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
  let prospect = input.prospect;
  const tenantRow = await input.db
    .select({
      timezone: tenants.timezone,
      name: tenants.name,
      privacyNoticeUrl: tenants.privacyNoticeUrl,
      privacyNoticeText: tenants.privacyNoticeText,
      assistantName: tenants.assistantName,
      businessHours: tenants.businessHours,
    })
    .from(tenants)
    .where(eq(tenants.id, input.tenant.id))
    .get();

  // Horario de atención: qué se le promete al prospecto cuando se turna a un asesor. Esa hora y fecha
  // salen del sistema, así que cuentan como datos verificados para el validador.
  const tz = tenantRow?.timezone ?? "America/Mexico_City";
  const closed = tenantRow?.businessHours?.length ? await officeClosedDates(input.db, input.tenant.id, tz) : undefined;
  const eta = advisorEta(tenantRow?.businessHours, tz, Date.now(), closed);
  ctx.advisorEta = eta;
  rememberSlot(ctx.facts, eta.replace(/(\d{1,2}):(\d{2})$/, (_, h: string, m: string) => `${h.padStart(2, "0")}:${m}`));

  /**
   * Privacidad, agregada por el sistema (no por el modelo) al final de la respuesta:
   * - la pregunta de consentimiento si el prospecto dio datos financieros sin haberlos autorizado;
   * - el aviso de privacidad en la primera respuesta.
   */
  async function withPrivacy(reply: string): Promise<string> {
    const now = Date.now();
    const parts = [reply];
    const set: Partial<typeof prospects.$inferInsert> = {};
    const askAgain = !prospect.consentRequestedAt || now - prospect.consentRequestedAt > 24 * 60 * 60 * 1000;
    if (!prospect.consentAt && !prospect.consentDeniedAt && askAgain && (ctx.financialPending || mentionsFinancialData(incomingText))) {
      parts.push(CONSENT_QUESTION);
      set.consentRequestedAt = now;
    }
    if (!prospect.privacyNoticeAt && tenantRow) {
      parts.push(privacyNotice({ ...tenantRow, name: tenantRow.name ?? input.tenant.name }));
      set.privacyNoticeAt = now;
    }
    if (Object.keys(set).length > 0) await input.db.update(prospects).set(set).where(eq(prospects.id, prospect.id));
    return parts.join("\n\n");
  }

  const done = async (r: Omit<AgentResult, "latencyMs" | "escalation" | "attachments">, privacy = true): Promise<AgentResult> => ({
    ...r,
    attachments: [],
    reply: privacy ? await withPrivacy(r.reply) : r.reply,
    escalation: ctx.escalation?.reason ?? null,
    latencyMs: Date.now() - started,
  });

  // 1. Archivos (INE, comprobantes, fotos): nunca pasan por el modelo.
  if (input.incoming.some((m) => MEDIA_TYPES.has(m.type))) {
    await escalate(ctx, "documentos", `El prospecto envió ${input.incoming.filter((m) => MEDIA_TYPES.has(m.type)).length} archivo(s).`);
    return done({ ...base, reply: mediaReply(eta), fallback: false, deterministic: true });
  }

  // 2. Baja: se respeta sin pasar por el modelo.
  if (isOptOut(incomingText)) {
    await input.db.batch([
      input.db.update(prospects).set({ optedOutAt: Date.now(), updatedAt: Date.now() }).where(eq(prospects.id, input.prospect.id)),
      auditInsert(input.db, { tenantId: input.tenant.id, actor: "ai", entity: "prospect", entityId: input.prospect.id, action: "opted_out" }),
    ]);
    return done({ ...base, reply: OPT_OUT_REPLY, fallback: false, deterministic: true }, false);
  }

  // 3. Respuesta a la pregunta de consentimiento ("Sí" / "No"): se registra con su texto como evidencia.
  let consentNote: string | null = null;
  if (prospect.consentRequestedAt && !prospect.consentAt && !prospect.consentDeniedAt) {
    const granted = isAffirmative(incomingText);
    if (granted || isNegative(incomingText)) {
      prospect = await recordConsent(input.db, { tenantId: input.tenant.id, prospect, granted, text: incomingText });
      consentNote = granted
        ? "El prospecto acaba de AUTORIZAR que guardemos sus datos financieros: agradécelo en una frase y sigue ayudándole."
        : "El prospecto NO autorizó guardar sus datos financieros: respétalo, no se los vuelvas a pedir y sigue ayudándole.";
    }
  }
  ctx.facts.financialConsent = Boolean(prospect.consentAt);

  const devs = await input.db
    .select({ name: developments.name, city: developments.city })
    .from(developments)
    .where(and(eq(developments.tenantId, input.tenant.id), eq(developments.status, "active")))
    .orderBy(asc(developments.name));

  // Cita vigente: el modelo la conoce para reagendar o recordarla, y su hora cuenta como dato verificado.
  const current = await upcomingAppointment(input.db, input.prospect.id);
  const timezone = tenantRow?.timezone ?? "America/Mexico_City";
  if (current) {
    rememberSlot(ctx.facts, slotLabel(current.startsAt, timezone));
    ctx.facts.existing = true;
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        assistantName: tenantRow?.assistantName || "Lynna",
        advisorEta: eta,
        companyName: input.tenant.name,
        today: todayIn(),
        prospectName: prospect.name ?? prospect.profileName,
        developments: devs,
        handedOff: Boolean(prospect.handoffAt),
        financialConsent: Boolean(prospect.consentAt),
        consentNote,
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
        const text = stripModelTokens(completion.content ?? "") || null;
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
      !text
        ? ({ ok: false, reasons: ["respuesta vacía"] } as const)
        : truncated
          ? ({ ok: false, reasons: ["respuesta incompleta (límite de tokens)"] } as const)
          : validateReply(withoutNames(text, [tenantRow?.name ?? input.tenant.name, ...devs.map((d) => d.name)]), ctx.facts);

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
        }${
          check.reasons.some((r) => /financieros|consultar después/.test(r))
            ? " No preguntes presupuesto ni enganche: si el prospecto ya dijo cuánto tiene, úsalo en buscar_lotes ahora mismo y muéstrale opciones en esta misma respuesta."
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
    reply = fallbackReply(eta);
    await escalate(ctx, "otro", `Respuesta de la IA no disponible o bloqueada: ${blocked.join("; ") || "sin texto"}.`);
  }

  // 3. Red de seguridad del material: si pidió fotos, plano o ubicación y el modelo no llamó enviar_material,
  //    lo llama el sistema; y la respuesta nunca dice que se envió algo que no va adjunto.
  if (!fallback) {
    for (const tipo of requestedMaterial(incomingText)) {
      if (toolTrace.some((t) => t.name === "enviar_material" && t.args.tipo === tipo)) continue;
      const result = await runTool(ctx, "enviar_material", { tipo });
      toolTrace.push({ name: "enviar_material", args: { tipo, red_de_seguridad: true }, result });
    }
    if (claimsMaterialSent(reply) && !(ctx.attachments ?? []).some((a) => a.kind !== "quote" && a.kind !== "carousel")) {
      blocked.push("dijo que envió material que no se adjuntó");
      reply = `${reply.split(/\n\n/).filter((p) => !claimsMaterialSent(p)).join("\n\n")}\n\nPor ahora no tengo ese material a la mano; un asesor te lo puede compartir.`.trim();
    }
  }

  // 4. Red de seguridad: lo que el cliente pidió turnar a un humano se turna aunque el modelo no lo haya hecho.
  const detected = detectEscalation(incomingText);
  if (detected && !ctx.escalation) {
    await escalate(ctx, detected, `Detectado por reglas en: "${incomingText.slice(0, 200)}"`);
  }
  // Ya se turnó: ofrecer "¿quieres que un asesor te contacte?" confunde (ya va a pasar). Se quita la oferta y,
  // si no queda ninguna mención del asesor, se dice cuándo lo contactarán.
  if (ctx.escalation) {
    reply = withoutAdvisorOffer(reply);
    if (!/asesor/i.test(reply)) reply = `${reply}\n\nUn asesor te contactará ${eta} para ayudarte con eso.`.trim();
  }
  // Seguridad del cliente: si habla de transferir o depositar, el sistema recuerda a qué cuentas pagar.
  if (mentionsMoneyTransfer(incomingText) && !/cuentas? (oficial|a nombre)/i.test(reply)) {
    reply = `${reply}\n\n${paymentSafetyNote(tenantRow?.name ?? input.tenant.name)}`;
  }

  const result = await done({ reply, draft: drafts.length ? drafts.join("\n\n--- reintento ---\n\n") : null, toolTrace, blocked: [...new Set(blocked)], fallback, deterministic: false, neurons, modelsUsed: [...modelsUsed] });
  // Material solo si la respuesta salió del modelo (no si se bloqueó y quedó la de respaldo).
  if (fallback) return result;
  const attachments = [...(ctx.attachments ?? [])];
  // El carrusel es para mostrar opciones. Si en este turno se habló de un lote concreto (detalle, cotización,
  // cita), la búsqueda fue solo para encontrarlo: no se manda. Tampoco se repite el mismo carrusel.
  const focusedOnOneLot = toolTrace.some((t) => ["detalle_lote", "simular_plan", "agendar_visita"].includes(t.name));
  if (ctx.foundLots?.length && !focusedOnOneLot) {
    const cards =
      input.lotCards === "carousel"
        ? await lotCarousel(input.db, input.tenant.id, ctx.foundLots).catch(() => null)
        : await lotList(input.db, input.tenant.id, input.conversationId, ctx.foundLots).catch(() => null);
    if (cards && !(await cardsAlreadySent(input.db, input.conversationId, cards))) attachments.unshift(cards);
  }
  // Después de fotos, plano o ubicación: botones para el siguiente paso de la venta (se ven en todos los clientes).
  const sentMaterial = attachments.some((a) => a.kind === "image" || a.kind === "document" || a.kind === "location");
  const showsLots = attachments.some((a) => a.kind === "lot_list" || a.kind === "carousel");
  if (sentMaterial && !showsLots && !ctx.escalation && !prospect.handoffAt) attachments.push(NEXT_STEP_BUTTONS);
  return { ...result, attachments };
}

/** Siguiente paso de la venta tras mandar material. */
export const NEXT_STEP_BUTTONS: Attachment = {
  kind: "buttons",
  body: "¿Qué te gustaría hacer ahora? 👇",
  buttons: [
    { title: "Ver lotes", reply: "Quiero ver los lotes disponibles con sus precios" },
    { title: "Cotizar", reply: "Quiero una cotización con mensualidades" },
    { title: "Agendar visita", reply: "Quiero agendar una visita al desarrollo" },
  ],
};

/** Quita las preguntas que ofrecen un asesor ("¿Quieres que un asesor te contacte?", "¿Te gustaría que te llame un asesor?"). */
export function withoutAdvisorOffer(reply: string) {
  return reply
    .replace(/¿[^¿?]*\b(asesor|ejecutivo|vendedor)[^¿?]*\?/giu, (q) => (/\b(quier|gustar|prefier|desea|te parece|puedo pedir)/iu.test(q) ? "" : q))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** ¿Ya se mandó en esta conversación la misma lista o carrusel de lotes? */
async function cardsAlreadySent(db: Db, conversationId: string, cards: Attachment): Promise<boolean> {
  const body = lotCardsBody(cards);
  if (!body) return false;
  const previous = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), inArray(messages.type, ["carousel", "list"]), eq(messages.body, body)))
    .limit(1);
  return previous.length > 0;
}

/** Quita tokens internos del modelo que a veces se filtran al texto ("<channel|>", "<|im_end|>", "<end_of_turn>"). */
export function stripModelTokens(text: string): string {
  return text
    .replace(/<\|?\/?(channel|im_start|im_end|start_of_turn|end_of_turn|eos|bos|think|thinking|tool_call|message|final|analysis|assistant|user|system)[^<>]{0,40}\|?>/gi, "")
    .replace(/^\s*(final|analysis|commentary)\s*\n/i, "")
    .trim();
}

/**
 * Quita los nombres de la desarrolladora y de sus desarrollos antes de validar: "Inmobiliaria Lote 321" o
 * "Sendero 321" no son el lote 321 ni un monto.
 */
export function withoutNames(text: string, names: (string | null | undefined)[]): string {
  let out = text;
  for (const name of names) {
    if (!name || name.length < 4) continue;
    out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out;
}

/** Recordatorio de seguridad cuando el prospecto habla de transferir o depositar dinero. */
export const paymentSafetyNote = (company: string) =>
  `🔐 Por tu seguridad, haz pagos solo a cuentas a nombre de ${company} que te confirme tu asesor; nunca a cuentas personales.`;

