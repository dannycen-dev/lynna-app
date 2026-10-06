import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signMetaBody } from "../src/whatsapp/signature";
import { textMessage } from "./fixtures";

const BASE = "https://lynna.test/whatsapp/webhook";

describe("GET /whatsapp/webhook (verificación)", () => {
  it("devuelve el challenge con el verify token correcto", async () => {
    const res = await exports.default.fetch(
      `${BASE}?hub.mode=subscribe&hub.verify_token=${env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=12345`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("12345");
  });

  it("responde 403 con token incorrecto", async () => {
    const res = await exports.default.fetch(`${BASE}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    expect(res.status).toBe(403);
  });
});

describe("POST /whatsapp/webhook", () => {
  const body = JSON.stringify(textMessage("wamid.http", "Hola"));

  it("rechaza sin firma válida", async () => {
    const res = await exports.default.fetch(BASE, { method: "POST", body });
    expect(res.status).toBe(403);
    const forged = await exports.default.fetch(BASE, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": await signMetaBody(body, "otro-secreto") },
    });
    expect(forged.status).toBe(403);
  });

  it("acepta un evento firmado", async () => {
    const res = await exports.default.fetch(BASE, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": await signMetaBody(body, env.WHATSAPP_APP_SECRET) },
    });
    expect(res.status).toBe(200);
  });
});
