import { describe, expect, it } from "vitest";
import { extractEvents, webhookPayload } from "../src/whatsapp/payload";
import { metaPayload, PHONE_NUMBER_ID, PROSPECT_PHONE, textMessage } from "./fixtures";

describe("extractEvents", () => {
  it("convierte un mensaje de texto con nombre de perfil", () => {
    const events = extractEvents(webhookPayload.parse(textMessage("wamid.1", "Hola, ¿tienen lotes?")));
    expect(events).toEqual([
      {
        kind: "message",
        phoneNumberId: PHONE_NUMBER_ID,
        from: PROSPECT_PHONE,
        profileName: "Ana Prospecto",
        wamid: "wamid.1",
        timestamp: 1759750000000,
        type: "text",
        text: "Hola, ¿tienen lotes?",
      },
    ]);
  });

  it("extrae medios, ubicación y acuses de entrega", () => {
    const payload = metaPayload({
      messages: [
        { from: PROSPECT_PHONE, id: "w.img", timestamp: "1", type: "image", image: { id: "MEDIA1", mime_type: "image/jpeg", caption: "mi INE" } },
        { from: PROSPECT_PHONE, id: "w.loc", timestamp: "2", type: "location", location: { latitude: 21.1, longitude: -89.6 } },
      ],
      statuses: [
        { id: "w.out", status: "failed", timestamp: "3", recipient_id: PROSPECT_PHONE, errors: [{ code: 131047, title: "Re-engagement message" }] },
      ],
    });
    const events = extractEvents(webhookPayload.parse(payload));
    expect(events[0]).toMatchObject({ type: "image", mediaId: "MEDIA1", mediaMime: "image/jpeg", text: "mi INE" });
    expect(events[1]).toMatchObject({ type: "location", text: "[ubicación] 21.1,-89.6" });
    expect(events[2]).toEqual({
      kind: "status",
      phoneNumberId: PHONE_NUMBER_ID,
      wamid: "w.out",
      status: "failed",
      timestamp: 3000,
      error: "131047 Re-engagement message",
    });
  });

  it("ignora cambios que no son del campo messages", () => {
    const payload = metaPayload({});
    payload.entry[0]!.changes[0]!.field = "account_update";
    expect(extractEvents(webhookPayload.parse(payload))).toEqual([]);
  });
});
