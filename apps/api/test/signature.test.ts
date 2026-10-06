import { describe, expect, it } from "vitest";
import { signMetaBody, verifyMetaSignature } from "../src/whatsapp/signature";

describe("verifyMetaSignature", () => {
  const body = '{"hello":"world"}';

  it("acepta una firma válida", async () => {
    const header = await signMetaBody(body, "secret");
    expect(await verifyMetaSignature(body, header, "secret")).toBe(true);
  });

  it("rechaza cuerpo alterado, secreto distinto o encabezado malformado", async () => {
    const header = await signMetaBody(body, "secret");
    expect(await verifyMetaSignature(`${body} `, header, "secret")).toBe(false);
    expect(await verifyMetaSignature(body, header, "otro")).toBe(false);
    expect(await verifyMetaSignature(body, null, "secret")).toBe(false);
    expect(await verifyMetaSignature(body, "sha256=zz", "secret")).toBe(false);
    expect(await verifyMetaSignature(body, header.replace("sha256=", "sha1="), "secret")).toBe(false);
  });

  it("rechaza todo si no hay app secret configurado", async () => {
    const header = await signMetaBody(body, "secret");
    expect(await verifyMetaSignature(body, header, "")).toBe(false);
  });
});
