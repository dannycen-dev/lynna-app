import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

const BASE = "https://lynna.test/api/admin/tenants/acme";
const auth = { authorization: `Bearer ${env.ADMIN_API_TOKEN}` };

function api(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`${BASE}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
}
function json(path: string, method: string, body: unknown) {
  return api(path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

const CSV = [
  "Manzana,Lote,Superficie m2,Frente,Fondo,Precio por m2,Estado,Características",
  'A,1,200,10,20,"$3,000.00",disponible,Esquina',
  "A,2,250,10,25,3000,disponible,",
  "B,1,300,12,25,2800,vendido,",
].join("\n");

beforeEach(async () => {
  await env.DB.batch(
    ["audit_log", "lot_media", "lots", "payment_plans", "developments", "messages", "conversations", "prospects", "wa_accounts", "tenants"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES ('tnt-acme', 'ACME', 'acme', 0)").run();
});

async function createDevelopment() {
  const res = await json("/developments", "POST", { name: "Bosque Alto", slug: "bosque-alto", city: "Mérida", amenities: ["Alberca"] });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}
async function importCsv(csv = CSV) {
  return api("/developments/bosque-alto/lots/import", { method: "POST", body: csv, headers: { "content-type": "text/csv" } });
}
async function lotsByKey() {
  const rows = (await (await api("/developments/bosque-alto/lots")).json()) as { id: string; block: string; number: string; status: string; totalPriceCents: number }[];
  return Object.fromEntries(rows.map((r) => [`${r.block}-${r.number}`, r]));
}

describe("autenticación", () => {
  it("rechaza sin token o con token incorrecto", async () => {
    expect((await exports.default.fetch(`${BASE}/developments`)).status).toBe(401);
    const bad = await exports.default.fetch(`${BASE}/developments`, { headers: { authorization: "Bearer nope" } });
    expect(bad.status).toBe(401);
  });
  it("404 para un tenant inexistente", async () => {
    const res = await exports.default.fetch("https://lynna.test/api/admin/tenants/otro/developments", { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("desarrollos e importación de lotes", () => {
  it("valida el cuerpo y evita slugs duplicados", async () => {
    expect((await json("/developments", "POST", { name: "X", slug: "Con Espacios" })).status).toBe(400);
    await createDevelopment();
    expect((await json("/developments", "POST", { name: "Otro", slug: "bosque-alto" })).status).toBe(409);
  });

  it("dryRun no escribe; la importación real crea y audita", async () => {
    await createDevelopment();
    const dry = await api("/developments/bosque-alto/lots/import?dryRun=true", { method: "POST", body: CSV });
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dryRun: true, valid: true, created: 3, updated: 0 });
    expect(Object.keys(await lotsByKey())).toHaveLength(0);

    expect(await (await importCsv()).json()).toMatchObject({ dryRun: false, created: 3 });
    const lots = await lotsByKey();
    expect(Object.keys(lots).sort()).toEqual(["A-1", "A-2", "B-1"]);
    expect(lots["A-1"]).toMatchObject({ totalPriceCents: 60_000_000, status: "available" });
    expect(lots["B-1"]!.status).toBe("sold");

    const audits = await env.DB.prepare("SELECT count(*) n FROM audit_log WHERE action = 'created_import'").first<{ n: number }>();
    expect(audits!.n).toBe(3);
  });

  it("reimportar actualiza precios, cambia estado solo si viene y lo audita", async () => {
    await createDevelopment();
    await importCsv();
    const res = await importCsv("manzana,lote,superficie_m2,precio_m2,estado\nA,1,200,3500,apartado\nA,2,250,3100,");
    expect(await res.json()).toMatchObject({ created: 0, updated: 2, statusChanges: 1 });
    const lots = await lotsByKey();
    expect(lots["A-1"]).toMatchObject({ status: "reserved", totalPriceCents: 70_000_000 });
    expect(lots["A-2"]).toMatchObject({ status: "available", totalPriceCents: 77_500_000 });
    const audit = await env.DB.prepare("SELECT data FROM audit_log WHERE action = 'status_import'").first<{ data: string }>();
    expect(JSON.parse(audit!.data)).toEqual({ from: "available", to: "reserved" });
  });

  it("un CSV con errores no escribe nada (todo o nada)", async () => {
    await createDevelopment();
    const res = await importCsv("manzana,lote,superficie_m2,precio_m2\nC,1,100,1000\nC,2,0,1000");
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ valid: false, errors: [expect.objectContaining({ line: 3, field: "superficie_m2" })] });
    expect(Object.keys(await lotsByKey())).toHaveLength(0);
  });
});

describe("estado de lotes", () => {
  it("apartar exige fecha futura y motivo; queda auditado", async () => {
    await createDevelopment();
    await importCsv();
    const lot = (await lotsByKey())["A-1"]!;

    expect((await json(`/lots/${lot.id}/status`, "PATCH", { status: "reserved", reason: "Pago de apartado" })).status).toBe(409);
    expect((await json(`/lots/${lot.id}/status`, "PATCH", { status: "reserved" })).status).toBe(400);

    const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const ok = await json(`/lots/${lot.id}/status`, "PATCH", { status: "reserved", reason: "Pago de apartado", reservedUntil: until });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ status: "reserved", reservedUntil: Date.parse(until) });

    const audit = await env.DB.prepare("SELECT actor, data FROM audit_log WHERE action = 'status_change'").first<{ actor: string; data: string }>();
    expect(audit!.actor).toBe("admin-token");
    expect(JSON.parse(audit!.data)).toMatchObject({ from: "available", to: "reserved", reason: "Pago de apartado" });
  });

  it("el cron libera apartados vencidos y lo audita como system", async () => {
    await createDevelopment();
    await importCsv();
    const lot = (await lotsByKey())["A-2"]!;
    await env.DB.prepare("UPDATE lots SET status = 'reserved', reserved_until = ? WHERE id = ?").bind(Date.now() - 1000, lot.id).run();

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController, env);

    expect((await lotsByKey())["A-2"]!.status).toBe("available");
    const audit = await env.DB.prepare("SELECT actor FROM audit_log WHERE action = 'reservation_expired'").first();
    expect(audit).toEqual({ actor: "system" });
  });
});

describe("planes de pago y simulación", () => {
  it("rechaza planes inconsistentes y simula solo sobre lotes disponibles", async () => {
    const dev = await createDevelopment();
    await importCsv();

    const bad = await json("/payment-plans", "POST", { name: "Mal", calculationType: "on_delivery", downPaymentBp: 3000, monthlyBp: 3000, months: 10 });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ message: "Enganche, mensualidades y contra entrega deben sumar 100 %." });

    const created = await json("/payment-plans", "POST", {
      name: "12 MSI",
      developmentId: dev.id,
      calculationType: "with_interest",
      downPaymentBp: 2000,
      months: 12,
      reservationCents: 1_000_000,
    });
    expect(created.status).toBe(201);
    const plan = (await created.json()) as { id: string };

    const lots = await lotsByKey();
    const sim = await json("/simulate", "POST", { lotId: lots["A-1"]!.id, planId: plan.id, quoteDate: "2026-01-31" });
    expect(sim.status).toBe(200);
    const body = (await sim.json()) as { breakdown: { salePriceCents: number; monthlyPaymentCents: number }; lines: unknown[] };
    expect(body.breakdown).toMatchObject({ salePriceCents: 60_000_000, monthlyPaymentCents: 4_000_000 });
    expect(body.lines).toHaveLength(15);

    const sold = await json("/simulate", "POST", { lotId: lots["B-1"]!.id, planId: plan.id });
    expect(sold.status).toBe(409);
  });

  it("los planes no se editan: solo se activan o desactivan", async () => {
    const created = await json("/payment-plans", "POST", { name: "Contado", calculationType: "with_interest", downPaymentBp: 10000, months: 1 });
    const plan = (await created.json()) as { id: string };
    const res = await json(`/payment-plans/${plan.id}`, "PATCH", { active: false });
    expect(await res.json()).toMatchObject({ active: false });
    expect((await json(`/payment-plans/${plan.id}`, "PATCH", { name: "otro" })).status).toBe(400);
  });
});

describe("fotos y planos (R2)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("sube, sirve públicamente con ETag y borra", async () => {
    await createDevelopment();
    const up = await api("/developments/bosque-alto/media?kind=plan&caption=Plano%20general", {
      method: "POST",
      body: PNG,
      headers: { "content-type": "image/png" },
    });
    expect(up.status).toBe(201);
    const media = (await up.json()) as { id: string; url: string; kind: string };
    expect(media.kind).toBe("plan");

    const served = await exports.default.fetch(`https://lynna.test${media.url}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    const etag = served.headers.get("etag")!;
    const cached = await exports.default.fetch(`https://lynna.test${media.url}`, { headers: { "if-none-match": etag } });
    expect(cached.status).toBe(304);

    expect((await api(`/media/${media.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await exports.default.fetch(`https://lynna.test${media.url}`)).status).toBe(404);
  });

  it("rechaza tipos no permitidos y archivos vacíos", async () => {
    await createDevelopment();
    const exe = await api("/developments/bosque-alto/media?kind=photo", { method: "POST", body: "MZ", headers: { "content-type": "application/x-msdownload" } });
    expect(exe.status).toBe(415);
    const empty = await api("/developments/bosque-alto/media?kind=photo", { method: "POST", body: new Uint8Array(), headers: { "content-type": "image/jpeg" } });
    expect(empty.status).toBe(400);
  });
});
