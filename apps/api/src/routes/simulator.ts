import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import { z } from "zod";
import { respondToConversation, defaultLlm } from "../agent/respond";
import type { AuthVariables } from "../auth/middleware";
import { getDb } from "../db/client";
import { aiAuditLog, auditLog, conversations, MESSAGE_STATUS_RANK, messages, prospects, tenants, waAccounts } from "../db/schema";

// Simulador de WhatsApp: el panel conversa con el agente por el MISMO código que usan los mensajes
// reales (respondToConversation), sin Meta. Cada usuario tiene su propia conversación de prueba.

type Ctx = Context<{ Bindings: Env; Variables: AuthVariables & { tenant: typeof tenants.$inferSelect } }>;

const body = z.object({
  message: z.string().trim().min(1).max(2000),
  type: z.enum(["text", "image", "document"]).default("text"),
  // Solo automatización (token) o admin: para comparar modelos con `pnpm eval:agent`.
  model: z.string().regex(/^@(cf|hf)\//).optional(),
});

function simIdentity(c: Ctx) {
  const p = c.var.principal;
  const who = p.kind === "user" ? p.user.id : (c.req.header("x-simulator-session") ?? "token").slice(0, 60);
  return { phone: `sim-${who}`, name: p.kind === "user" ? p.user.name : "Simulador" };
}

async function simulatorAccount(c: Ctx) {
  const db = getDb(c.env.DB);
  const phoneNumberId = `sim-${c.var.tenant.id}`;
  const existing = await db.select().from(waAccounts).where(eq(waAccounts.phoneNumberId, phoneNumberId)).get();
  if (existing) return existing;
  const [created] = await db
    .insert(waAccounts)
    .values({ tenantId: c.var.tenant.id, phoneNumberId, displayPhone: "Simulador" })
    .onConflictDoNothing({ target: waAccounts.phoneNumberId })
    .returning();
  return created ?? (await db.select().from(waAccounts).where(eq(waAccounts.phoneNumberId, phoneNumberId)).get())!;
}

async function findSimConversation(c: Ctx) {
  const db = getDb(c.env.DB);
  const { phone } = simIdentity(c);
  return db
    .select({ prospect: prospects, conversation: conversations })
    .from(prospects)
    .leftJoin(conversations, eq(conversations.prospectId, prospects.id))
    .where(and(eq(prospects.tenantId, c.var.tenant.id), eq(prospects.phone, phone)))
    .get();
}

export async function simulatorSend(c: Ctx) {
  const parsed = body.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const p = c.var.principal;
  if (parsed.data.model && !(p.kind === "token" || p.user.role === "admin")) {
    return c.json({ error: "forbidden", message: "Solo un admin puede cambiar el modelo." }, 403);
  }

  const db = getDb(c.env.DB);
  const tenantId = c.var.tenant.id;
  const account = await simulatorAccount(c);
  const { phone, name } = simIdentity(c);
  const now = Date.now();

  const [prospect] = await db
    .insert(prospects)
    .values({ tenantId, phone, profileName: name, source: "simulator" })
    .onConflictDoUpdate({ target: [prospects.tenantId, prospects.phone], set: { updatedAt: now } })
    .returning({ id: prospects.id });
  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, prospectId: prospect!.id, waAccountId: account.id, lastInboundAt: now })
    .onConflictDoUpdate({ target: [conversations.prospectId, conversations.waAccountId], set: { lastInboundAt: now } })
    .returning({ id: conversations.id });
  const [inbound] = await db
    .insert(messages)
    .values({
      tenantId,
      conversationId: conversation!.id,
      wamid: `sim.${crypto.randomUUID()}`,
      direction: "in",
      author: "prospect",
      type: parsed.data.type,
      body: parsed.data.message,
      status: "received",
      statusRank: MESSAGE_STATUS_RANK.received,
      waTimestamp: now,
      createdAt: now,
    })
    .returning({ id: messages.id });

  const outcome = await respondToConversation(c.env, conversation!.id, [inbound!.id], {
    ...(parsed.data.model ? { llm: defaultLlm(c.env, parsed.data.model) } : {}),
  });
  const after = await db.select().from(prospects).where(eq(prospects.id, prospect!.id)).get();

  return c.json({
    conversationId: conversation!.id,
    reply: outcome?.reply ?? null,
    skippedReason: outcome ? null : "La conversación está pausada o el prospecto se dio de baja.",
    model: outcome?.model ?? null,
    tools: outcome?.toolTrace ?? [],
    blocked: outcome?.blocked ?? [],
    escalation: outcome?.escalation ?? null,
    fallback: outcome?.fallback ?? false,
    neurons: outcome?.neurons ?? 0,
    latencyMs: outcome?.latencyMs ?? 0,
    prospect: after,
  });
}

export async function simulatorHistory(c: Ctx) {
  const db = getDb(c.env.DB);
  const found = await findSimConversation(c);
  if (!found?.conversation) return c.json({ conversationId: null, messages: [], audit: [], prospect: found?.prospect ?? null });
  const [msgs, audit] = await Promise.all([
    db.select().from(messages).where(eq(messages.conversationId, found.conversation.id)).orderBy(asc(messages.createdAt)),
    db.select().from(aiAuditLog).where(eq(aiAuditLog.conversationId, found.conversation.id)).orderBy(desc(aiAuditLog.createdAt)).limit(50),
  ]);
  return c.json({ conversationId: found.conversation.id, messages: msgs, audit, prospect: found.prospect });
}

/** Borra la conversación de prueba del usuario (empezar de cero). */
export async function simulatorReset(c: Ctx) {
  const db = getDb(c.env.DB);
  const found = await findSimConversation(c);
  if (!found) return c.body(null, 204);
  const convIds = found.conversation ? [found.conversation.id] : [];
  const deleteConversation = convIds.length
    ? [
        db.delete(aiAuditLog).where(inArray(aiAuditLog.conversationId, convIds)),
        db.delete(messages).where(inArray(messages.conversationId, convIds)),
        db.delete(conversations).where(inArray(conversations.id, convIds)),
      ]
    : [];
  await db.batch([
    db.delete(auditLog).where(and(eq(auditLog.entity, "prospect"), eq(auditLog.entityId, found.prospect.id))),
    ...deleteConversation,
    db.delete(prospects).where(eq(prospects.id, found.prospect.id)),
  ]);
  return c.body(null, 204);
}
