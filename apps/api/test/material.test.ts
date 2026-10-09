import { env } from "cloudflare:workers";
import { PDFDocument } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import { lotCarousel, newFacts, runTool, type ToolContext } from "../src/agent/tools";
import { getDb } from "../src/db/client";
import { buildQuotePdf } from "../src/docs/quote-pdf";
import { simulatePlan } from "../src/financing";
import { extractEvents, webhookPayload } from "../src/whatsapp/payload";
import { makeQuote } from "../src/whatsapp/outbound";
import { metaPayload, PROSPECT_PHONE } from "./fixtures";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const ctx = (): ToolContext => ({ db: getDb(env.DB), tenantId: "tnt-demo", prospectId: "p1", conversationId: "c1", facts: newFacts(), escalation: null });

async function media(id: string, kind: string, lotId: string | null = null, mime = "image/jpeg") {
  await env.DB.prepare("INSERT INTO lot_media (id, tenant_id, development_id, lot_id, kind, r2_key, mime, caption, sort) VALUES (?, 'tnt-demo', 'dev-almendros', ?, ?, ?, ?, ?, 0)")
    .bind(id, lotId, kind, `t/tnt-demo/${id}`, mime, `Foto ${id}`)
    .run();
}

beforeEach(async () => {
  await env.DB.batch(["lot_media", "messages", "conversations", "prospects"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
});

describe("enviar_material", () => {
  it("fotos del lote primero, luego las del desarrollo; máximo 4 y sin repetir lo ya enviado", async () => {
    for (const id of ["g1", "g2", "g3", "g4"]) await media(id, "photo");
    await media("own", "photo", "lot-A-1");
    const c = ctx();
    const res = JSON.parse(await runTool(c, "enviar_material", { tipo: "fotos", manzana: "A", lote: "1" }));
    expect(res).toMatchObject({ ok: true, enviados: 4 });
    expect(c.attachments!.map((a) => (a.kind === "image" ? a.mediaId : a.kind))).toEqual(["own", "g1", "g2", "g3"]);

    // Lo que ya está en la conversación no se repite.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, created_at, updated_at) VALUES ('p1', 'tnt-demo', '5219990000000', 'new', 0, 'whatsapp', 0, 0)"),
      env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('c1', 'tnt-demo', 'p1', 'wa-demo', 0, 0)"),
    ]);
    await env.DB.prepare(
      "INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, media_id, status, status_rank, created_at) VALUES ('m1', 'tnt-demo', 'c1', 'w1', 'out', 'ai', 'image', NULL, 'g1', 'accepted', 1, 0)",
    ).run();
    const again = ctx();
    await runTool(again, "enviar_material", { tipo: "fotos" });
    expect(again.attachments!.map((a) => (a.kind === "image" ? a.mediaId : a.kind))).toEqual(["g2", "g3", "g4"]);
  });

  it("plano en PDF como documento y ubicación como pin", async () => {
    await media("plano", "plan", null, "application/pdf");
    const c = ctx();
    await runTool(c, "enviar_material", { tipo: "plano" });
    await runTool(c, "enviar_material", { tipo: "ubicacion" });
    expect(c.attachments![0]).toMatchObject({ kind: "document", mediaId: "plano", filename: "Plano Residencial Los Almendros.pdf" });
    expect(c.attachments![1]).toMatchObject({ kind: "location", name: "Residencial Los Almendros", latitude: 21.1205 });
  });

  it("sin material cargado lo dice para que la IA ofrezca un asesor", async () => {
    const res = JSON.parse(await runTool(ctx(), "enviar_material", { tipo: "fotos" }));
    expect(res.error).toMatch(/No hay fotos/);
  });
});

describe("carrusel de lotes", () => {
  it("una tarjeta por lote con foto, precio y botones que traen el lote en el texto", async () => {
    await media("g1", "photo");
    const lots = (await env.DB.prepare("SELECT * FROM lots WHERE status = 'available' ORDER BY total_price_cents LIMIT 3").all()).results.map((l) => ({
      id: l.id,
      developmentId: l.development_id,
      block: l.block,
      number: l.number,
      areaM2: l.area_m2,
      frontM: l.front_m,
      depthM: l.depth_m,
      totalPriceCents: l.total_price_cents,
    })) as never;
    const carousel = await lotCarousel(getDb(env.DB), "tnt-demo", lots);
    expect(carousel?.kind).toBe("carousel");
    if (carousel?.kind !== "carousel") return;
    expect(carousel.cards).toHaveLength(3);
    expect(carousel.cards[0]!.text).toMatch(/^\*Manzana [A-D], lote \d+\*\n\d+ m² .* · \$[\d,]+ MXN$/);
    expect(carousel.cards[0]!.buttons.map((b) => b.title)).toEqual(["Ver detalle", "Agendar visita"]);
    expect(carousel.cards[0]!.buttons[1]!.reply).toMatch(/^Quiero agendar una visita para ver el lote [A-D]-\d+$/);
  });

  it("sin fotos no hay carrusel", async () => {
    const lots = [{ id: "lot-A-1", developmentId: "dev-almendros" }, { id: "lot-A-2", developmentId: "dev-almendros" }] as never;
    expect(await lotCarousel(getDb(env.DB), "tnt-demo", lots)).toBeNull();
  });
});

describe("botones de respuesta", () => {
  it("el id lynna:… se convierte en lo que dijo el prospecto", () => {
    const payload = metaPayload({
      messages: [
        { from: PROSPECT_PHONE, id: "w.b1", timestamp: "1", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "lynna:Quiero agendar una visita para ver el lote B-12", title: "Agendar visita" } } },
        { from: PROSPECT_PHONE, id: "w.b2", timestamp: "2", type: "button", button: { text: "Ya no, gracias", payload: "lynna:Ya no me escriban, gracias" } },
      ],
    });
    const events = extractEvents(webhookPayload.parse(payload));
    expect(events.map((e) => (e.kind === "message" ? e.text : null))).toEqual(["Quiero agendar una visita para ver el lote B-12", "Ya no me escriban, gracias"]);
  });
});

describe("cotización en PDF", () => {
  it("genera un PDF con la tabla de pagos y lo guarda en R2", async () => {
    const plan = await env.DB.prepare("SELECT id FROM payment_plans WHERE calculation_type = 'with_interest' LIMIT 1").first<{ id: string }>();
    const lot = await env.DB.prepare("SELECT id FROM lots WHERE status = 'available' LIMIT 1").first<{ id: string }>();
    const doc = await makeQuote({ db: getDb(env.DB), env, tenantId: "tnt-demo", prospectName: "Ana López" }, lot!.id, plan!.id);
    expect(doc).toMatchObject({ kind: "document", mime: "application/pdf" });
    if (doc.kind !== "document") return;
    expect(doc.filename).toMatch(/^Cotización Residencial Los Almendros [A-D]-\d+\.pdf$/);
    const row = await env.DB.prepare("SELECT kind, r2_key FROM lot_media WHERE id = ?").bind(doc.mediaId).first<{ kind: string; r2_key: string }>();
    expect(row!.kind).toBe("quote");
    const obj = await env.MEDIA!.get(row!.r2_key);
    const bytes = new Uint8Array(await obj!.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("varias páginas cuando la tabla no cabe", async () => {
    const sim = simulatePlan(
      { calculationType: "with_interest", listPriceType: "list_price", discountType: "percentage", discountBp: 0, discountFixedCents: 0, reservationCents: 1500000, openingFeeCents: 0, downPaymentType: "percentage", downPaymentBp: 2000, downPaymentFixedCents: 0, downPaymentInstallments: 1, months: 60, annualInterestBp: 1190, monthlyType: "percentage", monthlyBp: 0, monthlyFixedCents: 0, onDeliveryType: "percentage", onDeliveryBp: 0, onDeliveryFixedCents: 0, onDeliveryInstallments: 1, roundingAbsorber: null, deliveryDate: null } as never,
      { areaM2: 240, pricePerM2Cents: 310000, totalPriceCents: 74400000 } as never,
      "2026-10-09",
    );
    const bytes = await buildQuotePdf({
      companyName: "Inmobiliaria Lote 321",
      development: { name: "Sendero 321 Residencial", address: "Carretera Mérida–Progreso km 18", city: "Mérida", state: "Yucatán" },
      lot: { block: "B", number: "12", areaM2: 240, frontM: 12, depthM: 20, pricePerM2Cents: 310000 },
      planName: "60 meses",
      simulation: sim,
      quoteDate: "2026-10-09",
      folio: "T-1",
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
  });
});
