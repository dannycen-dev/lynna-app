import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { extractEvents, webhookPayload, type StatusEvent } from "../src/whatsapp/payload";
import { processInboundEvent } from "../src/whatsapp/inbound";
import { PHONE_NUMBER_ID, PROSPECT_PHONE, resetAndSeedTenant, textMessage } from "./fixtures";

const eventsOf = (p: unknown) => extractEvents(webhookPayload.parse(p));
const status = (wamid: string, s: StatusEvent["status"]): StatusEvent => ({
  kind: "status",
  phoneNumberId: PHONE_NUMBER_ID,
  wamid,
  status: s,
  timestamp: 0,
});

describe("processInboundEvent", () => {
  beforeEach(resetAndSeedTenant);

  it("crea prospecto, conversación y mensaje, y avisa al Durable Object", async () => {
    for (const ev of eventsOf(textMessage("wamid.A", "Hola"))) await processInboundEvent(ev, env);

    const prospect = await env.DB.prepare("SELECT * FROM prospects WHERE phone = ?").bind(PROSPECT_PHONE).first();
    expect(prospect).toMatchObject({ tenant_id: "tnt-test", profile_name: "Ana Prospecto", stage: "new" });

    const conv = await env.DB.prepare("SELECT * FROM conversations").first<{ id: string; last_inbound_at: number }>();
    expect(conv?.last_inbound_at).toBe(1759750000000);

    const msg = await env.DB.prepare("SELECT * FROM messages WHERE wamid = 'wamid.A'").first();
    expect(msg).toMatchObject({ direction: "in", author: "prospect", body: "Hola", status: "received" });

    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conv!.id));
    const pending = await runInDurableObject(stub, async (_i, state) => ({
      pending: await state.storage.get<string[]>("pending"),
      alarm: await state.storage.getAlarm(),
    }));
    expect(pending.pending).toEqual([msg!.id]);
    expect(pending.alarm).not.toBeNull();
  });

  it("es idempotente ante reintentos de Meta (mismo wamid)", async () => {
    const [ev] = eventsOf(textMessage("wamid.B", "Hola"));
    await processInboundEvent(ev!, env);
    await processInboundEvent(ev!, env);

    const { n } = (await env.DB.prepare("SELECT count(*) n FROM messages WHERE wamid = 'wamid.B'").first<{ n: number }>())!;
    expect(n).toBe(1);
    const conv = await env.DB.prepare("SELECT id FROM conversations").first<{ id: string }>();
    const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(conv!.id));
    const pending = await runInDurableObject(stub, (_i, state) => state.storage.get<string[]>("pending"));
    expect(pending).toHaveLength(1);
  });

  it("reutiliza prospecto y conversación en mensajes siguientes", async () => {
    for (const ev of eventsOf(textMessage("wamid.C1", "Hola", 1759750000))) await processInboundEvent(ev, env);
    for (const ev of eventsOf(textMessage("wamid.C2", "¿Precio?", 1759750100))) await processInboundEvent(ev, env);

    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM prospects) p, (SELECT count(*) FROM conversations) c, (SELECT max(last_inbound_at) FROM conversations) last",
    ).first();
    expect(counts).toEqual({ p: 1, c: 1, last: 1759750100000 });
  });

  it("los acuses de entrega nunca retroceden", async () => {
    for (const ev of eventsOf(textMessage("wamid.D", "Hola"))) await processInboundEvent(ev, env);

    await processInboundEvent(status("wamid.D", "read"), env);
    await processInboundEvent(status("wamid.D", "sent"), env);
    await processInboundEvent(status("wamid.D", "delivered"), env);

    const row = await env.DB.prepare("SELECT status FROM messages WHERE wamid = 'wamid.D'").first();
    expect(row).toEqual({ status: "read" });
  });

  it("ignora números que no están dados de alta", async () => {
    const [ev] = eventsOf(textMessage("wamid.E", "Hola"));
    await processInboundEvent({ ...ev!, phoneNumberId: "desconocido" } as typeof ev & {}, env);
    const { n } = (await env.DB.prepare("SELECT count(*) n FROM messages").first<{ n: number }>())!;
    expect(n).toBe(0);
  });
});
