import { Hono } from "hono";
import { log } from "./lib/log";
import { devCatalog } from "./routes/dev-catalog";
import type { InboundEvent } from "./whatsapp/payload";
import { handleInboundBatch } from "./whatsapp/inbound";
import { whatsappWebhook } from "./whatsapp/webhook";

export { ConversationDO } from "./conversation/conversation-do";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, env: c.env.ENVIRONMENT }));
app.route("/whatsapp", whatsappWebhook);
app.route("/api/dev", devCatalog);

app.onError((err, c) => {
  log("error", "http.unhandled", { path: c.req.path, error: err.message });
  return c.json({ error: "internal_error" }, 500);
});

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    await handleInboundBatch(batch, env);
  },
} satisfies ExportedHandler<Env, InboundEvent>;
