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

async function send(cfg: ClientConfig, phoneNumberId: string, to: string, message: Record<string, unknown>): Promise<{ wamid: string }> {
  const res = await fetch(`https://graph.facebook.com/${cfg.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...message }),
  });
  const text = await res.text();
  if (!res.ok) throw new WhatsAppApiError(res.status, text);
  const parsed = sendResponse.parse(JSON.parse(text));
  return { wamid: parsed.messages[0]!.id };
}

export function sendText(cfg: ClientConfig, phoneNumberId: string, to: string, body: string): Promise<{ wamid: string }> {
  return send(cfg, phoneNumberId, to, { type: "text", text: { preview_url: false, body } });
}

/** Imagen o PDF por URL pública (Meta la descarga). `filename` solo aplica a documentos. */
export function sendMedia(
  cfg: ClientConfig,
  phoneNumberId: string,
  to: string,
  media: { type: "image" | "document"; link: string; caption?: string | null; filename?: string },
): Promise<{ wamid: string }> {
  const payload: Record<string, unknown> = { link: media.link };
  if (media.caption) payload.caption = media.caption;
  if (media.type === "document" && media.filename) payload.filename = media.filename;
  return send(cfg, phoneNumberId, to, { type: media.type, [media.type]: payload });
}

/** Pin en el mapa (se abre en Google Maps / Apple Maps desde el chat). */
export function sendLocation(
  cfg: ClientConfig,
  phoneNumberId: string,
  to: string,
  location: { latitude: number; longitude: number; name?: string | null; address?: string | null },
): Promise<{ wamid: string }> {
  return send(cfg, phoneNumberId, to, { type: "location", location });
}

/** Plantilla aprobada por Meta: lo único que se puede mandar fuera de la ventana de 24 h. */
export function sendTemplate(
  cfg: ClientConfig,
  phoneNumberId: string,
  to: string,
  template: { name: string; language: string; bodyParams: string[]; quickReplyPayloads?: string[] },
): Promise<{ wamid: string }> {
  const components: Record<string, unknown>[] = [];
  if (template.bodyParams.length) components.push({ type: "body", parameters: template.bodyParams.map((text) => ({ type: "text", text })) });
  (template.quickReplyPayloads ?? []).forEach((payload, i) =>
    components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }] }),
  );
  return send(cfg, phoneNumberId, to, {
    type: "template",
    template: { name: template.name, language: { code: template.language }, ...(components.length ? { components } : {}) },
  });
}

/** Código de error de la Cloud API (131049 tope de marketing, 131050 el usuario dejó de recibir marketing, …). */
export function whatsAppErrorCode(err: unknown): number | null {
  if (!(err instanceof WhatsAppApiError)) return null;
  try {
    return (JSON.parse(err.body) as { error?: { code?: number } }).error?.code ?? null;
  } catch {
    return null;
  }
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

/** Las respuestas a botones llevan este prefijo en el id: lo que sigue es el texto que "dijo" el prospecto. */
export const REPLY_ID_PREFIX = "lynna:";
export const replyId = (text: string) => `${REPLY_ID_PREFIX}${text}`.slice(0, 256);

export type CarouselCard = { imageLink: string; text: string; buttons: { id: string; title: string }[] };

/**
 * Carrusel interactivo (2 a 10 tarjetas con imagen y botones de respuesta rápida). Solo dentro de la
 * ventana de 24 h. Todas las tarjetas deben tener la misma cantidad de botones.
 */
export function sendCarousel(cfg: ClientConfig, phoneNumberId: string, to: string, carousel: { body: string; cards: CarouselCard[] }) {
  return send(cfg, phoneNumberId, to, {
    type: "interactive",
    interactive: {
      type: "carousel",
      body: { text: carousel.body.slice(0, 1024) },
      action: {
        cards: carousel.cards.slice(0, 10).map((card, i) => ({
          card_index: i,
          type: "cta_url",
          header: { type: "image", image: { link: card.imageLink } },
          body: { text: card.text.slice(0, 160) },
          action: { buttons: card.buttons.map((b) => ({ type: "quick_reply", quick_reply: { id: b.id, title: b.title.slice(0, 20) } })) },
        })),
      },
    },
  });
}

/** Mensaje con hasta 3 botones de respuesta rápida. */
export function sendButtons(cfg: ClientConfig, phoneNumberId: string, to: string, message: { body: string; buttons: { id: string; title: string }[] }) {
  return send(cfg, phoneNumberId, to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: message.body.slice(0, 1024) },
      action: { buttons: message.buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  });
}
