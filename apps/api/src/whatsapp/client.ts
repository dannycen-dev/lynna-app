import { z } from "zod";

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Dentro de las 24 h desde el último mensaje del cliente se puede escribir texto libre; fuera, solo plantillas. */
export function isWithinServiceWindow(lastInboundAt: number | null | undefined, now = Date.now()): boolean {
  return lastInboundAt != null && now - lastInboundAt < SERVICE_WINDOW_MS;
}

const sendResponse = z.looseObject({ messages: z.array(z.looseObject({ id: z.string() })).min(1) });

export class WhatsAppApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`WhatsApp Cloud API ${status}: ${body.slice(0, 300)}`);
  }
}

type ClientConfig = { accessToken: string; graphVersion: string };

export async function sendText(
  cfg: ClientConfig,
  phoneNumberId: string,
  to: string,
  body: string,
): Promise<{ wamid: string }> {
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new WhatsAppApiError(res.status, text);
  const parsed = sendResponse.parse(JSON.parse(text));
  return { wamid: parsed.messages[0]!.id };
}

/**
 * Marca el mensaje como leído y muestra "escribiendo…" al prospecto (se quita al responder o a los ~25 s).
 * Es cortesía: si falla no debe impedir la respuesta, por eso nunca lanza.
 */
export async function markReadWithTyping(cfg: ClientConfig, phoneNumberId: string, wamid: string): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: wamid, typing_indicator: { type: "text" } }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
