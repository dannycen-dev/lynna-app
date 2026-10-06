import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminHeaders } from "../lib/env";

// Flujo completo de inventario como lo operaría un administrador.
const TENANT = "/api/admin/tenants/demo";

async function createDevelopment(request: APIRequestContext) {
  const slug = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const res = await request.post(`${TENANT}/developments`, {
    headers: adminHeaders,
    data: { name: `Desarrollo ${slug}`, slug, city: "Mérida", state: "Yucatán", amenities: ["Alberca", "Casa club"] },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; slug: string };
}

const CSV = [
  "Manzana;Lote;Superficie m2;Frente;Fondo;Precio por m²;Estado;Características",
  'A;1;200;10;20;"$3,000.00";Disponible;Esquina',
  "A;2;250;10;25;3000;Disponible;",
  "A;3;300;12;25;2900;Vendido;",
].join("\r\n");

test("inventario: importar, apartar, simular y liberar", async ({ request }) => {
  const dev = await createDevelopment(request);
  const importUrl = `${TENANT}/developments/${dev.slug}/lots/import`;

  await test.step("dryRun valida sin escribir", async () => {
    const dry = await request.post(`${importUrl}?dryRun=true`, { headers: { ...adminHeaders, "content-type": "text/csv" }, data: CSV });
    expect(await dry.json()).toMatchObject({ dryRun: true, valid: true, created: 3 });
    const lots = await (await request.get(`${TENANT}/developments/${dev.slug}/lots`, { headers: adminHeaders })).json();
    expect(lots).toHaveLength(0);
  });

  await test.step("un CSV con errores se rechaza completo", async () => {
    const bad = await request.post(importUrl, {
      headers: { ...adminHeaders, "content-type": "text/csv" },
      data: "manzana,lote,superficie_m2,precio_m2\nZ,1,100,1000\nZ,2,cero,1000",
    });
    expect(bad.status()).toBe(422);
    expect((await bad.json()).errors[0]).toMatchObject({ line: 3, field: "superficie_m2" });
  });

  const lots = await test.step("importación real", async () => {
    const res = await request.post(importUrl, { headers: { ...adminHeaders, "content-type": "text/csv" }, data: CSV });
    expect(await res.json()).toMatchObject({ valid: true, created: 3, updated: 0 });
    const all = (await (await request.get(`${TENANT}/developments/${dev.slug}/lots`, { headers: adminHeaders })).json()) as {
      id: string;
      number: string;
      status: string;
      totalPriceCents: number;
    }[];
    expect(all.map((l) => [l.number, l.status, l.totalPriceCents])).toEqual([
      ["1", "available", 60_000_000],
      ["2", "available", 75_000_000],
      ["3", "sold", 87_000_000],
    ]);
    return Object.fromEntries(all.map((l) => [l.number, l]));
  });

  const plan = await test.step("crear plan y simular", async () => {
    const res = await request.post(`${TENANT}/payment-plans`, {
      headers: adminHeaders,
      data: { name: "E2E 24 meses", developmentId: dev.id, calculationType: "with_interest", downPaymentBp: 2000, months: 24, annualInterestBp: 1000, reservationCents: 500_000 },
    });
    expect(res.status()).toBe(201);
    const created = (await res.json()) as { id: string };

    const sim = await request.post(`${TENANT}/simulate`, { headers: adminHeaders, data: { lotId: lots["1"]!.id, planId: created.id, quoteDate: "2026-10-06" } });
    expect(sim.ok()).toBeTruthy();
    const body = await sim.json();
    expect(body.breakdown).toMatchObject({ salePriceCents: 60_000_000, downPaymentTotalCents: 12_000_000, financedCents: 48_000_000 });
    const installments = body.lines.filter((l: { lineType: string }) => l.lineType === "installment");
    expect(installments).toHaveLength(24);
    expect(installments.at(-1).balanceCents).toBe(0);
    return created;
  });

  await test.step("un lote vendido no se puede simular", async () => {
    const sim = await request.post(`${TENANT}/simulate`, { headers: adminHeaders, data: { lotId: lots["3"]!.id, planId: plan.id } });
    expect(sim.status()).toBe(409);
  });

  await test.step("apartar un lote lo saca de la oferta", async () => {
    const until = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const res = await request.patch(`${TENANT}/lots/${lots["1"]!.id}/status`, {
      headers: adminHeaders,
      data: { status: "reserved", reason: "Apartado E2E", reservedUntil: until },
    });
    expect(res.ok()).toBeTruthy();
    const available = await (await request.get(`${TENANT}/developments/${dev.slug}/lots?status=available`, { headers: adminHeaders })).json();
    expect(available.map((l: { number: string }) => l.number)).toEqual(["2"]);
    const sim = await request.post(`${TENANT}/simulate`, { headers: adminHeaders, data: { lotId: lots["1"]!.id, planId: plan.id } });
    expect(sim.status()).toBe(409);
  });

  await test.step("liberar el apartado", async () => {
    const res = await request.patch(`${TENANT}/lots/${lots["1"]!.id}/status`, {
      headers: adminHeaders,
      data: { status: "available", reason: "Cliente desistió" },
    });
    expect(await res.json()).toMatchObject({ status: "available", reservedUntil: null });
  });
});

test("fotos y planos: subir, servir públicamente y borrar", async ({ request }) => {
  const dev = await createDevelopment(request);
  const pdf = Buffer.from("%PDF-1.4\n% plano E2E\n%%EOF\n");

  const up = await request.post(`${TENANT}/developments/${dev.slug}/media?kind=plan&caption=Plano`, {
    headers: { ...adminHeaders, "content-type": "application/pdf" },
    data: pdf,
  });
  expect(up.status()).toBe(201);
  const media = await up.json();

  const served = await request.get(media.url);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("application/pdf");
  expect(Buffer.from(await served.body())).toEqual(pdf);

  const listed = await (await request.get(`${TENANT}/developments/${dev.slug}/media`, { headers: adminHeaders })).json();
  expect(listed.map((m: { id: string }) => m.id)).toContain(media.id);

  expect((await request.delete(`${TENANT}/media/${media.id}`, { headers: adminHeaders })).status()).toBe(204);
  expect((await request.get(media.url)).status()).toBe(404);
});

test("el catálogo de demo trae planes y lotes listos para la IA", async ({ request }) => {
  const plans = await (await request.get(`${TENANT}/developments/los-almendros/payment-plans`, { headers: adminHeaders })).json();
  expect(plans.map((p: { name: string }) => p.name)).toEqual(
    expect.arrayContaining(["Contado (10 % de descuento)", "12 meses sin intereses", "36 meses (12 % anual)", "Preventa 30/50/20"]),
  );
  const available = await (await request.get(`${TENANT}/developments/los-almendros/lots?status=available`, { headers: adminHeaders })).json();
  expect(available.length).toBeGreaterThanOrEqual(25);

  for (const plan of plans) {
    const sim = await request.post(`${TENANT}/simulate`, { headers: adminHeaders, data: { lotId: available[0].id, planId: plan.id } });
    expect(sim.ok(), plan.name).toBeTruthy();
  }
});
