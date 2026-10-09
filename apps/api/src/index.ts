import { Hono } from "hono";
import { releaseExpiredReservations, warnExpiringReservations } from "./catalog/service";
import { getDb } from "./db/client";
import { schemaStatus } from "./db/schema-version";
import { log } from "./lib/log";
import { purgeExpiredSessions } from "./auth/session";
import { remindSellers } from "./crm/agenda";
import { FOLLOWUP_TEMPLATE_LANGUAGE, processFollowups, type FollowupSender } from "./crm/followups";
import { canSendWhatsApp } from "./agent/respond";
import { replyId, sendButtons, sendTemplate, whatsAppErrorCode } from "./whatsapp/client";
import { reassignStale } from "./crm/assignment";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { publicMedia } from "./routes/media";
import type { InboundEvent } from "./whatsapp/payload";
import { handleInboundBatch } from "./whatsapp/inbound";
import { whatsappWebhook } from "./whatsapp/webhook";

export { ConversationDO } from "./conversation/conversation-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  const schema = await schemaStatus(c.env.DB);
  return c.json({ ok: schema.ok, env: c.env.ENVIRONMENT, schema }, schema.ok ? 200 : 503);
});
app.route("/whatsapp", whatsappWebhook);
app.route("/media", publicMedia);
app.route("/api/auth", auth);
app.route("/api/admin", admin);

app.onError((err, c) => {
  log("error", "http.unhandled", { path: c.req.path, error: err.message });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,

  async queue(batch, env) {
    await handleInboundBatch(batch, env);
  },

  async scheduled(_controller, env) {
    const db = getDb(env.DB);
    const released = await releaseExpiredReservations(db);
    if (released.length > 0) log("info", "cron.reservations_released", { count: released.length });
    const warned = await warnExpiringReservations(db);
    if (warned > 0) log("info", "cron.reservations_warned", { count: warned });
    const reassigned = await reassignStale(db);
    if (reassigned.length > 0) log("info", "cron.prospects_reassigned", { count: reassigned.length });
    const followups = await processFollowups(db, Date.now(), canSendWhatsApp(env) ? followupSender(env) : undefined, whatsAppErrorCode);
    if (followups > 0) log("info", "cron.followups_sent", { count: followups });
    const reminded = await remindSellers(db);
    if (reminded > 0) log("info", "cron.appointment_reminders", { count: reminded });
    await purgeExpiredSessions(db);
  },
} satisfies ExportedHandler<Env, InboundEvent>;

/** Seguimientos reales: texto con botones dentro de la ventana de 24 h; plantilla aprobada fuera. */
function followupSender(env: Env): FollowupSender {
  const cfg = { accessToken: env.WHATSAPP_ACCESS_TOKEN, graphVersion: env.WHATSAPP_GRAPH_VERSION };
  return (msg) =>
    msg.template
      ? sendTemplate(cfg, msg.phoneNumberId, msg.to, {
          name: msg.template.name,
          language: FOLLOWUP_TEMPLATE_LANGUAGE,
          bodyParams: msg.template.params,
          quickReplyPayloads: msg.template.buttons.map((b) => replyId(b.reply)),
        })
      : sendButtons(cfg, msg.phoneNumberId, msg.to, { body: msg.text!.body, buttons: msg.text!.buttons.map((b) => ({ id: replyId(b.reply), title: b.title })) });
}
