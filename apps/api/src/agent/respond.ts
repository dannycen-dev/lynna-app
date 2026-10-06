import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { aiAuditLog, conversations, MESSAGE_STATUS_RANK, messages, prospects, tenants, waAccounts } from "../db/schema";
import { log } from "../lib/log";
import { isWithinServiceWindow, markReadWithTyping, sendText } from "../whatsapp/client";
import { fakeLlm } from "./fake-llm";
import { withFallback, workersAiClient, type LlmClient } from "./llm";
import { PROMPT_VERSION } from "./prompt";
import { runAgent, type AgentResult } from "./runner";

/** ¿Hay credenciales reales de WhatsApp en este entorno? */
export function canSendWhatsApp(env: Env): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN) && env.WHATSAPP_ACCESS_TOKEN !== "PENDIENTE";
}

export function defaultLlm(env: Env, model?: string, thinkingOverride?: boolean): LlmClient {
  const chosen = model || env.AI_MODEL;
  const thinking = thinkingOverride ?? (env.AI_THINKING === "off" ? false : env.AI_THINKING === "on" ? true : undefined);
  // El modelo falso solo existe en local (pruebas E2E sin red ni neuronas).
  if (chosen === "fake" && env.ENVIRONMENT === "local") return fakeLlm;
  const gateway = env.AI_GATEWAY_ID || undefined;
  // Con modelo explícito (evaluación) no hay respaldo: se mide ese modelo y nada más.
  const fallback = !model && env.AI_MODEL_FALLBACK ? workersAiClient(env.AI, env.AI_MODEL_FALLBACK, gateway) : null;
  return withFallback(workersAiClient(env.AI, chosen, gateway, thinking === undefined ? {} : { thinking }), fallback, (err) =>
    log("warn", "agent.model_fallback", { primary: chosen, fallback: env.AI_MODEL_FALLBACK, error: err instanceof Error ? err.message : String(err) }),
  );
}

/** WhatsApp usa *negritas* y _cursivas_ con un solo símbolo y no soporta encabezados Markdown. */
export function toWhatsAppFormat(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type RespondOutcome = AgentResult & { sent: "whatsapp" | "simulated" | "skipped"; model: string };

/**
 * Responde una conversación con el agente: arma el contexto, corre la IA, guarda el mensaje de salida
 * y la bitácora (ai_audit_log) y, si se puede, lo envía por WhatsApp. Lo usan el Durable Object
 * (mensajes reales) y el simulador del panel (mismo código, sin Meta).
 */
export async function respondToConversation(
  env: Env,
  conversationId: string,
  pendingMessageIds: string[],
  options: { llm?: LlmClient } = {},
): Promise<RespondOutcome | null> {
  const db = getDb(env.DB);
  const row = await db
    .select({ conversation: conversations, prospect: prospects, account: waAccounts, tenant: tenants })
    .from(conversations)
    .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
    .innerJoin(waAccounts, eq(waAccounts.id, conversations.waAccountId))
    .innerJoin(tenants, eq(tenants.id, conversations.tenantId))
    .where(eq(conversations.id, conversationId))
    .get();
  if (!row) return null;
  const { conversation, prospect, account, tenant } = row;

  if (conversation.aiPaused || prospect.optedOutAt) {
    log("info", "agent.skip", { conversationId, reason: conversation.aiPaused ? "ai_paused" : "opted_out" });
    return null;
  }

  const all = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt));
  const pending = new Set(pendingMessageIds);
  const incoming = all.filter((m) => pending.has(m.id));
  if (incoming.length === 0) return null;
  const history = all.filter((m) => !pending.has(m.id) && m.status !== "failed");

  // Conversación real con credenciales: leído + "escribiendo…" mientras la IA trabaja (~10 s).
  const realConversation = prospect.source === "whatsapp" && canSendWhatsApp(env);
  const waConfig = { accessToken: env.WHATSAPP_ACCESS_TOKEN, graphVersion: env.WHATSAPP_GRAPH_VERSION };
  const lastIncoming = incoming.at(-1)!;
  if (realConversation && isWithinServiceWindow(conversation.lastInboundAt) && !lastIncoming.wamid.startsWith("sim.")) {
    await markReadWithTyping(waConfig, account.phoneNumberId, lastIncoming.wamid);
  }

  const llm = options.llm ?? defaultLlm(env);
  const agentResult = await runAgent({
    db,
    llm,
    tenant: { id: tenant.id, name: tenant.name },
    conversationId,
    prospect,
    history: history.map((m) => ({ direction: m.direction, body: m.body, type: m.type })),
    incoming: incoming.map((m) => ({ type: m.type, body: m.body })),
  });
  const result = { ...agentResult, reply: toWhatsAppFormat(agentResult.reply) };

  // Envío: real solo con credenciales, dentro de la ventana de 24 h y si no es el simulador.
  let sent: RespondOutcome["sent"] = "simulated";
  let wamid = `sim.${crypto.randomUUID()}`;
  if (realConversation) {
    if (isWithinServiceWindow(conversation.lastInboundAt)) {
      try {
        ({ wamid } = await sendText(
          waConfig,
          account.phoneNumberId,
          prospect.phone,
          result.reply,
        ));
        sent = "whatsapp";
      } catch (err) {
        log("error", "agent.send_failed", { conversationId, error: err instanceof Error ? err.message : String(err) });
        sent = "skipped";
      }
    } else {
      sent = "skipped"; // fuera de las 24 h solo se puede con plantilla (Fase 2)
    }
  }

  const now = Date.now();
  await db.batch([
    db.insert(messages).values({
      tenantId: tenant.id,
      conversationId,
      wamid,
      direction: "out",
      author: "ai",
      type: "text",
      body: result.reply,
      status: sent === "whatsapp" ? "accepted" : sent === "simulated" ? "simulated" : "failed",
      statusRank: sent === "skipped" ? MESSAGE_STATUS_RANK.failed : MESSAGE_STATUS_RANK.accepted,
      ...(sent === "skipped" ? { error: "No enviado: sin credenciales o fuera de la ventana de 24 h" } : {}),
      createdAt: now,
    }),
    db.update(conversations).set({ lastOutboundAt: now }).where(eq(conversations.id, conversationId)),
    db.insert(aiAuditLog).values({
      tenantId: tenant.id,
      conversationId,
      model: result.deterministic ? "ninguno" : result.modelsUsed.join(" + ") || llm.model,
      promptVersion: PROMPT_VERSION,
      input: incoming.map((m) => m.body ?? `[${m.type}]`).join("\n"),
      toolCalls: result.toolTrace,
      draft: result.draft,
      reply: result.reply,
      blocked: result.blocked,
      escalation: result.escalation,
      fallback: result.fallback,
      neurons: result.neurons,
      latencyMs: result.latencyMs,
      createdAt: now,
    }),
  ]);

  log("info", "agent.replied", {
    conversationId,
    model: llm.model,
    tools: result.toolTrace.map((t) => t.name),
    blocked: result.blocked.length,
    escalation: result.escalation,
    fallback: result.fallback,
    neurons: Math.round(result.neurons),
    latencyMs: result.latencyMs,
    sent,
  });
  return { ...result, sent, model: llm.model };
}

