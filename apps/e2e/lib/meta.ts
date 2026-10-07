import { createHmac, randomInt, randomUUID } from "node:crypto";
import { LOCAL_SECRETS } from "./env";

/** phone_number_id del número de demo que crea seed/demo.sql. */
export const DEMO_PHONE_NUMBER_ID = "DEMO_PHONE_NUMBER_ID";

export function randomMxPhone(): string {
  return `521999${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
}

export function signMeta(body: string, secret: string = LOCAL_SECRETS.WHATSAPP_APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "E2E_WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "520000000000", phone_number_id: DEMO_PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

export function inboundText(from: string, text: string, wamid = `wamid.E2E.${randomUUID()}`, profileName = "Prospecto E2E") {
  const body = JSON.stringify(
    envelope({
      contacts: [{ profile: { name: profileName }, wa_id: from }],
      messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
    }),
  );
  return { body, wamid };
}

export function statusUpdate(wamid: string, recipient: string, status: "sent" | "delivered" | "read") {
  return JSON.stringify(
    envelope({ statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: recipient }] }),
  );
}
