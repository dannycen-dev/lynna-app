import { Hono } from "hono";
import { log } from "../lib/log";
import { extractEvents, webhookPayload } from "./payload";
import { verifyMetaSignature } from "./signature";

const QUEUE_BATCH_LIMIT = 100;

export const whatsappWebhook = new Hono<{ Bindings: Env }>();

// Verificación de la suscripción (Meta → Configuración del webhook).
whatsappWebhook.get("/webhook", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");

  if (mode === "subscribe" && challenge && c.env.WHATSAPP_VERIFY_TOKEN && token === c.env.WHATSAPP_VERIFY_TOKEN) {
    return c.text(challenge);
  }
  log("warn", "whatsapp.webhook.verify_rejected", { mode });
  return c.text("Forbidden", 403);
});

// Eventos: responder 200 rápido y procesar en la cola (Meta reintenta si tardamos o fallamos).
whatsappWebhook.post("/webhook", async (c) => {
  const raw = await c.req.text();
  const valid = await verifyMetaSignature(raw, c.req.header("x-hub-signature-256"), c.env.WHATSAPP_APP_SECRET);
  if (!valid) {
    log("warn", "whatsapp.webhook.bad_signature");
    return c.text("Forbidden", 403);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    log("warn", "whatsapp.webhook.invalid_json");
    return c.text("OK");
  }

  const parsed = webhookPayload.safeParse(json);
  if (!parsed.success) {
    // Viene firmado por Meta pero con forma desconocida: lo registramos y no forzamos reintentos.
    log("warn", "whatsapp.webhook.unknown_shape", { issues: parsed.error.issues.slice(0, 3) });
    return c.text("OK");
  }

  const events = extractEvents(parsed.data);
  for (let i = 0; i < events.length; i += QUEUE_BATCH_LIMIT) {
    await c.env.WA_INBOUND.sendBatch(
      events.slice(i, i + QUEUE_BATCH_LIMIT).map((body) => ({ body, contentType: "json" as const })),
    );
  }
  log("info", "whatsapp.webhook.enqueued", { count: events.length });
  return c.text("OK");
});
