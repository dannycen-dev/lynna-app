import { Hono } from "hono";
import { releaseExpiredReservations } from "./catalog/service";
import { getDb } from "./db/client";
import { log } from "./lib/log";
import { purgeExpiredSessions } from "./auth/session";
import { admin } from "./routes/admin";
import { auth } from "./routes/auth";
import { publicMedia } from "./routes/media";
import type { InboundEvent } from "./whatsapp/payload";
import { handleInboundBatch } from "./whatsapp/inbound";
import { whatsappWebhook } from "./whatsapp/webhook";

export { ConversationDO } from "./conversation/conversation-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
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
    await purgeExpiredSessions(db);
  },
} satisfies ExportedHandler<Env, InboundEvent>;
