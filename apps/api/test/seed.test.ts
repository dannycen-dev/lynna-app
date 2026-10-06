import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { plansForDevelopment, searchAvailableLots } from "../src/catalog/service";
import { getDb } from "../src/db/client";
import { simulatePlan, totalPaidCents } from "../src/financing";

/** Separa el seed en sentencias: quita comentarios de línea y corta en ";" de fin de línea. */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

it("el seed de demo aplica sobre las migraciones y todos sus planes simulan y cuadran", async () => {
  // Dos veces: el seed debe ser idempotente.
  for (let i = 0; i < 2; i++) await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));

  const db = getDb(env.DB);
  const lots = await searchAvailableLots(db, "tnt-demo", { developmentId: "dev-almendros", limit: 100 });
  expect(lots).toHaveLength(31);

  const plans = await plansForDevelopment(db, "tnt-demo", "dev-almendros");
  expect(plans.map((p) => p.id).sort()).toEqual(["plan-12msi", "plan-36", "plan-contado", "plan-preventa"]);

  for (const plan of plans) {
    for (const lot of lots) {
      const sim = simulatePlan(plan, lot, "2026-10-06");
      expect(totalPaidCents(sim), `${plan.id} × ${lot.id}`).toBe(sim.breakdown.salePriceCents + sim.breakdown.totalInterestCents + sim.breakdown.openingFeeCents);
    }
  }
});

it("la búsqueda respeta presupuesto y superficie mínima", async () => {
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  const db = getDb(env.DB);
  const lots = await searchAvailableLots(db, "tnt-demo", { maxPriceCents: 70_000_000, minAreaM2: 230 });
  expect(lots.length).toBeGreaterThan(0);
  for (const lot of lots) {
    expect(lot.status).toBe("available");
    expect(lot.totalPriceCents).toBeLessThanOrEqual(70_000_000);
    expect(lot.areaM2).toBeGreaterThanOrEqual(230);
  }
  // Ordenados del más barato al más caro.
  expect(lots.map((l) => l.totalPriceCents)).toEqual([...lots.map((l) => l.totalPriceCents)].sort((a, b) => a - b));
});
