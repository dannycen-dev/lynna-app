import { and, eq, lt, sql } from "drizzle-orm";
import { autoAssignIfNeeded } from "../crm/assignment";
import { getDb } from "../db/client";
import { conversations, MESSAGE_STATUS_RANK, messages, prospects, waAccounts } from "../db/schema";
import { log, maskPhone } from "../lib/log";
import type { InboundEvent, InboundMessageEvent, StatusEvent } from "./payload";

/** Consumidor de la cola `lynna-wa-inbound`. Cada evento se confirma o reintenta por separado. */
export async function handleInboundBatch(batch: MessageBatch<InboundEvent>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processInboundEvent(msg.body, env);
      msg.ack();
    } catch (err) {
      log("error", "whatsapp.inbound.failed", {
        kind: msg.body.kind,
        attempts: msg.attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      msg.retry();
    }
  }
}

export async function processInboundEvent(ev: InboundEvent, env: Env): Promise<void> {
  if (ev.kind === "message") await processMessage(ev, env);
  else await processStatus(ev, env);
}

async function processMessage(ev: InboundMessageEvent, env: Env): Promise<void> {
  const db = getDb(env.DB);

  const account = await db.select().from(waAccounts).where(eq(waAccounts.phoneNumberId, ev.phoneNumberId)).get();
  if (!account) {
    // Número no dado de alta: no tiene caso reintentar.
    log("warn", "whatsapp.inbound.unknown_phone_number_id", { phoneNumberId: ev.phoneNumberId });
    return;
  }
  const tenantId = account.tenantId;

  // Todas las operaciones son idempotentes: un reintento de la cola o de Meta no duplica nada.
  const [prospect] = await db
    .insert(prospects)
    .values({ tenantId, phone: ev.from, profileName: ev.profileName ?? null })
    .onConflictDoUpdate({
      target: [prospects.tenantId, prospects.phone],
      set: { profileName: sql`coalesce(excluded.profile_name, ${prospects.profileName})`, updatedAt: Date.now() },
    })
    .returning({ id: prospects.id });

  // Reparto en turno: el prospecto nuevo queda con un vendedor (idempotente si ya tiene).
  await autoAssignIfNeeded(db, tenantId, prospect!.id);

  const [conversation] = await db
    .insert(conversations)
    .values({ tenantId, prospectId: prospect!.id, waAccountId: account.id, lastInboundAt: ev.timestamp })
    .onConflictDoUpdate({
      target: [conversations.prospectId, conversations.waAccountId],
      set: { lastInboundAt: sql`max(coalesce(${conversations.lastInboundAt}, 0), excluded.last_inbound_at)` },
    })
    .returning({ id: conversations.id });

  const inserted = await db
    .insert(messages)
    .values({
      tenantId,
      conversationId: conversation!.id,
      wamid: ev.wamid,
      direction: "in",
      author: "prospect",
      type: ev.type,
      body: ev.text ?? null,
      mediaId: ev.mediaId ?? null,
      mediaMime: ev.mediaMime ?? null,
      status: "received",
      statusRank: MESSAGE_STATUS_RANK.received,
      waTimestamp: ev.timestamp,
    })
    .onConflictDoNothing({ target: messages.wamid })
    .returning({ id: messages.id });

  const messageId =
    inserted[0]?.id ??
    (await db.select({ id: messages.id }).from(messages).where(eq(messages.wamid, ev.wamid)).get())!.id;

  log("info", "whatsapp.inbound.message", {
    tenantId,
    from: maskPhone(ev.from),
    type: ev.type,
    duplicate: inserted.length === 0,
  });

  // Se avisa al DO aunque el mensaje ya existiera: si un intento previo falló justo aquí,
  // el reintento lo completa. El DO descarta los IDs que ya vio.
  const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conversation!.id));
  await stub.notifyInbound({ conversationId: conversation!.id, messageId, text: ev.text ?? null });
}

async function processStatus(ev: StatusEvent, env: Env): Promise<void> {
  const db = getDb(env.DB);
  const rank = MESSAGE_STATUS_RANK[ev.status];
  // Solo avanza: un "sent" tardío no pisa un "read".
  await db
    .update(messages)
    .set({ status: ev.status, statusRank: rank, ...(ev.error ? { error: ev.error } : {}) })
    .where(and(eq(messages.wamid, ev.wamid), lt(messages.statusRank, rank)));
}
