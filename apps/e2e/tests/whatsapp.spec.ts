import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminHeaders, LOCAL_SECRETS } from "../lib/env";
import { inboundText, randomMxPhone, signMeta, statusUpdate } from "../lib/meta";

const TENANT = "/api/admin/tenants/demo";

async function postSigned(request: APIRequestContext, body: string) {
  return request.post("/whatsapp/webhook", {
    headers: { "content-type": "application/json", "x-hub-signature-256": signMeta(body) },
    data: body,
  });
}

async function prospectByPhone(request: APIRequestContext, phone: string) {
  const rows = (await (await request.get(`${TENANT}/prospects`, { headers: adminHeaders })).json()) as {
    phone: string;
    profileName: string | null;
    stage: string;
    conversationId: string;
    messageCount: number;
  }[];
  return rows.find((r) => r.phone === phone);
}

test("verificación del webhook con el verify token correcto", async ({ request }) => {
  const res = await request.get("/whatsapp/webhook", {
    params: { "hub.mode": "subscribe", "hub.verify_token": LOCAL_SECRETS.WHATSAPP_VERIFY_TOKEN, "hub.challenge": "reto-123" },
  });
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe("reto-123");
});

test("un mensaje entrante crea el prospecto y su conversación (vía cola + Durable Object)", async ({ request }) => {
  const phone = randomMxPhone();
  const first = inboundText(phone, "Hola, ¿qué lotes tienen disponibles?");
  expect((await postSigned(request, first.body)).status()).toBe(200);

  await expect.poll(async () => (await prospectByPhone(request, phone))?.messageCount, { timeout: 15_000 }).toBe(1);
  const prospect = (await prospectByPhone(request, phone))!;
  expect(prospect).toMatchObject({ profileName: "Prospecto E2E", stage: "new" });

  await test.step("un reintento de Meta (mismo wamid) no duplica", async () => {
    expect((await postSigned(request, first.body)).status()).toBe(200);
    const second = inboundText(phone, "Busco algo de 250 m²");
    expect((await postSigned(request, second.body)).status()).toBe(200);
    // Cuando llega el segundo mensaje, el reintento ya se procesó (la cola es FIFO por lote).
    await expect.poll(async () => (await prospectByPhone(request, phone))?.messageCount, { timeout: 15_000 }).toBe(2);
  });

  await test.step("los acuses de entrega no retroceden", async () => {
    await postSigned(request, statusUpdate(first.wamid, phone, "read"));
    await postSigned(request, statusUpdate(first.wamid, phone, "sent"));
    const messagesUrl = `${TENANT}/conversations/${prospect.conversationId}/messages`;
    await expect
      .poll(async () => {
        const msgs = (await (await request.get(messagesUrl, { headers: adminHeaders })).json()) as { wamid: string; status: string }[];
        return msgs.find((m) => m.wamid === first.wamid)?.status;
      }, { timeout: 15_000 })
      .toBe("read");
  });
});

test("un evento con firma de otro secreto se rechaza y no se guarda", async ({ request }) => {
  const phone = randomMxPhone();
  const { body } = inboundText(phone, "intento falso");
  const res = await request.post("/whatsapp/webhook", {
    headers: { "content-type": "application/json", "x-hub-signature-256": signMeta(body, "otro-secreto") },
    data: body,
  });
  expect(res.status()).toBe(403);
  await new Promise((r) => setTimeout(r, 1500));
  expect(await prospectByPhone(request, phone)).toBeUndefined();
});
