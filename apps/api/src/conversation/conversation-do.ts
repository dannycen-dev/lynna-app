import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { conversations, MESSAGE_STATUS_RANK, messages, prospects, waAccounts } from "../db/schema";
import { log } from "../lib/log";
import { respondToConversation } from "../agent/respond";
import { isWithinServiceWindow, sendText } from "../whatsapp/client";

// Tope para que una ráfaga larga no retrase la respuesta indefinidamente.
const MAX_BURST_MS = 15_000;
const PHASE0_ACK =
  "¡Gracias por escribirnos! Recibimos tu mensaje y en breve te atendemos. (Lynna — entorno de pruebas)";

export type InboundNotice = { conversationId: string; messageId: string };

/**
 * Una instancia por conversación (prospecto + número). Serializa los mensajes del mismo
 * prospecto y agrupa ráfagas antes de responder. En la Fase 3 aquí se conecta el agente de IA.
 */
export class ConversationDO extends DurableObject<Env> {
  async notifyInbound({ conversationId, messageId }: InboundNotice): Promise<void> {
    const seenKey = `seen:${messageId}`;
    if (await this.ctx.storage.get(seenKey)) return;

    const pending = (await this.ctx.storage.get<string[]>("pending")) ?? [];
    const now = Date.now();
    const burstStart = (await this.ctx.storage.get<number>("burstStart")) ?? now;

    await this.ctx.storage.put({
      [seenKey]: true,
      conversationId,
      pending: [...pending, messageId],
      burstStart,
    });

    // Debounce deslizante con tope.
    const debounce = Number(this.env.DEBOUNCE_MS) || 3000;
    await this.ctx.storage.setAlarm(Math.min(now + debounce, burstStart + MAX_BURST_MS));
  }

  override async alarm(): Promise<void> {
    const pending = (await this.ctx.storage.get<string[]>("pending")) ?? [];
    const conversationId = await this.ctx.storage.get<string>("conversationId");
    await this.ctx.storage.delete(["pending", "burstStart"]);
    if (!conversationId || pending.length === 0) return;

    await this.respond(conversationId, pending);
  }

  private async respond(conversationId: string, messageIds: string[]): Promise<void> {
    const db = getDb(this.env.DB);
    const row = await db
      .select({ conversation: conversations, prospect: prospects, account: waAccounts })
      .from(conversations)
      .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
      .innerJoin(waAccounts, eq(waAccounts.id, conversations.waAccountId))
      .where(eq(conversations.id, conversationId))
      .get();
    if (!row) return;

    const { conversation, prospect, account } = row;
    if (conversation.aiPaused || prospect.optedOutAt) {
      log("info", "conversation.skip", { conversationId, reason: conversation.aiPaused ? "ai_paused" : "opted_out" });
      return;
    }

    if (this.env.AUTO_REPLY_MODE === "ai") {
      // La extracción de datos corre después de enviar la respuesta (no retrasa al prospecto).
      await respondToConversation(this.env, conversationId, messageIds, { defer: (work) => this.ctx.waitUntil(work) });
      return;
    }
    if (this.env.AUTO_REPLY_MODE !== "ack") {
      log("info", "conversation.auto_reply_off", { conversationId, messages: messageIds.length });
      return;
    }
    if (!isWithinServiceWindow(conversation.lastInboundAt)) return;

    const { wamid } = await sendText(
      { accessToken: this.env.WHATSAPP_ACCESS_TOKEN, graphVersion: this.env.WHATSAPP_GRAPH_VERSION },
      account.phoneNumberId,
      prospect.phone,
      PHASE0_ACK,
    );
    const now = Date.now();
    await db.batch([
      db.insert(messages).values({
        tenantId: conversation.tenantId,
        conversationId,
        wamid,
        direction: "out",
        author: "system",
        type: "text",
        body: PHASE0_ACK,
        status: "accepted",
        statusRank: MESSAGE_STATUS_RANK.accepted,
      }),
      db.update(conversations).set({ lastOutboundAt: now }).where(eq(conversations.id, conversationId)),
    ]);
  }
}
