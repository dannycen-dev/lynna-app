import { env } from "cloudflare:workers";

export const PHONE_NUMBER_ID = "111222333";
export const PROSPECT_PHONE = "5219991234567";

/** El almacenamiento de D1 persiste entre tests del mismo archivo: se limpia y se vuelve a sembrar. */
export async function resetAndSeedTenant(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM conversations"),
    env.DB.prepare("DELETE FROM prospects"),
    env.DB.prepare("INSERT OR IGNORE INTO tenants (id, name, slug, created_at) VALUES ('tnt-test', 'Test', 'test', 0)"),
    env.DB.prepare(
      "INSERT OR IGNORE INTO wa_accounts (id, tenant_id, phone_number_id, created_at) VALUES ('wa-test', 'tnt-test', ?, 0)",
    ).bind(PHONE_NUMBER_ID),
  ]);
}

/** Payload con la forma real que envía Meta. */
export function metaPayload(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "529990000000", phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function textMessage(wamid: string, body: string, timestampSec = 1759750000) {
  return metaPayload({
    contacts: [{ profile: { name: "Ana Prospecto" }, wa_id: PROSPECT_PHONE }],
    messages: [{ from: PROSPECT_PHONE, id: wamid, timestamp: String(timestampSec), type: "text", text: { body } }],
  });
}
