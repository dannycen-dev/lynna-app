import { env, exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { EXPECTED_MIGRATION } from "../src/db/schema-version";

it("EXPECTED_MIGRATION es la migración más reciente (actualízala al crear una nueva)", () => {
  const latest = env.TEST_MIGRATIONS.map((m) => m.name).sort().at(-1);
  expect(EXPECTED_MIGRATION).toBe(latest);
});

it("/health reporta el esquema al día", async () => {
  const res = await exports.default.fetch("https://lynna.test/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, schema: { ok: true, applied: EXPECTED_MIGRATION } });
});

it("/health responde 503 si a la base le falta la última migración", async () => {
  await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?").bind(EXPECTED_MIGRATION).run();
  const res = await exports.default.fetch("https://lynna.test/health");
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ ok: false, schema: { ok: false, expected: EXPECTED_MIGRATION } });
});
