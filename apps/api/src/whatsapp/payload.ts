import { z } from "zod";
import { REPLY_ID_PREFIX } from "./client";

// Esquema tolerante del webhook de la Cloud API: validamos lo que usamos y dejamos pasar el resto,
// porque Meta añade campos sin avisar.

const media = z.looseObject({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() });

const inboundMessage = z.looseObject({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.looseObject({ body: z.string() }).optional(),
  image: media.optional(),
  document: media.extend({ filename: z.string().optional() }).optional(),
  audio: media.optional(),
  video: media.optional(),
  location: z
    .looseObject({ latitude: z.number(), longitude: z.number(), name: z.string().optional() })
    .optional(),
  button: z.looseObject({ text: z.string(), payload: z.string().optional() }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
});

const status = z.looseObject({
  id: z.string(),
  status: z.enum(["sent", "delivered", "read", "failed"]),
  timestamp: z.string(),
  recipient_id: z.string(),
  errors: z.array(z.looseObject({ code: z.number(), title: z.string().optional() })).optional(),
});

export const webhookPayload = z.looseObject({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(
        z.looseObject({
          field: z.string(),
          value: z.looseObject({
            metadata: z.looseObject({ phone_number_id: z.string(), display_phone_number: z.string() }).optional(),
            contacts: z.array(z.looseObject({ wa_id: z.string(), profile: z.looseObject({ name: z.string() }).optional() })).optional(),
            messages: z.array(inboundMessage).optional(),
            statuses: z.array(status).optional(),
          }),
        }),
      ),
    }),
  ),
});

export type InboundMessageEvent = {
  kind: "message";
  phoneNumberId: string;
  from: string;
  profileName?: string;
  wamid: string;
  timestamp: number; // epoch ms
  type: string;
  text?: string;
  mediaId?: string;
  mediaMime?: string;
};

export type StatusEvent = {
  kind: "status";
  phoneNumberId: string;
  wamid: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: number;
  error?: string;
};

export type InboundEvent = InboundMessageEvent | StatusEvent;

/** Aplana el payload de Meta a eventos independientes para la cola. */
export function extractEvents(payload: z.infer<typeof webhookPayload>): InboundEvent[] {
  const events: InboundEvent[] = [];
  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      for (const m of value.messages ?? []) {
        const profileName = value.contacts?.find((c) => c.wa_id === m.from)?.profile?.name;
        const mediaPart = m.image ?? m.document ?? m.audio ?? m.video;
        // Botones de Lynna: el id trae la frase completa ("lynna:Quiero agendar una visita al lote C-2"),
        // así la IA recibe el contexto que no cabe en los 20 caracteres del título.
        const fromButton = [m.interactive?.button_reply?.id, m.button?.payload].find((id) => id?.startsWith(REPLY_ID_PREFIX));
        const text =
          (fromButton ? fromButton.slice(REPLY_ID_PREFIX.length) : undefined) ??
          m.text?.body ??
          m.button?.text ??
          m.interactive?.button_reply?.title ??
          m.interactive?.list_reply?.title ??
          mediaPart?.caption ??
          (m.location
            ? `[ubicación] ${m.location.latitude},${m.location.longitude}${m.location.name ? ` ${m.location.name}` : ""}`
            : undefined);

        events.push({
          kind: "message",
          phoneNumberId,
          from: m.from,
          ...(profileName ? { profileName } : {}),
          wamid: m.id,
          timestamp: Number(m.timestamp) * 1000,
          type: m.type,
          ...(text !== undefined ? { text } : {}),
          ...(mediaPart ? { mediaId: mediaPart.id, ...(mediaPart.mime_type ? { mediaMime: mediaPart.mime_type } : {}) } : {}),
        });
      }

      for (const s of value.statuses ?? []) {
        const error = s.errors?.map((e) => `${e.code} ${e.title ?? ""}`.trim()).join("; ");
        events.push({
          kind: "status",
          phoneNumberId,
          wamid: s.id,
          status: s.status,
          timestamp: Number(s.timestamp) * 1000,
          ...(error ? { error } : {}),
        });
      }
    }
  }
  return events;
}
