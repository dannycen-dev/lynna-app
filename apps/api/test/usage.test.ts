import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { computeUsage, monthRange } from "../src/crm/usage";
import { getDb } from "../src/db/client";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const OCT = Date.UTC(2026, 9, 15, 18); // 15 de octubre

beforeEach(async () => {
  await env.DB.batch(
    ["notification_reads", "notifications", "sessions", "audit_log", "appointments", "ai_audit_log", "messages", "conversations", "prospects", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  const stmts = [
    // Prospecto real (WhatsApp) y uno del simulador (no se cobra).
    env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, created_at, updated_at) VALUES ('p-real', 'tnt-demo', '5219990001', 'new', 0, 'whatsapp', 0, 0)"),
    env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, created_at, updated_at) VALUES ('p-sim', 'tnt-demo', 'sim-x', 'new', 0, 'simulator', 0, 0)"),
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('c-real', 'tnt-demo', 'p-real', 'wa-demo', 0, 0)"),
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('c-sim', 'tnt-demo', 'p-sim', 'wa-demo', 0, 0)"),
  ];
  for (const [conv, n] of [["c-real", 3], ["c-sim", 5]] as const) {
    for (let i = 0; i < n; i++) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO ai_audit_log (id, tenant_id, conversation_id, model, prompt_version, input, tool_calls, reply, blocked, neurons, latency_ms, created_at) VALUES (?, 'tnt-demo', ?, 'm', 'v', 'x', '[]', 'y', '[]', 2000, 1, ?)",
        ).bind(`${conv}-ai-${i}`, conv, OCT),
        env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES (?, 'tnt-demo', ?, ?, 'in', 'prospect', 'text', 'hola', 'received', 0, ?)").bind(
          `${conv}-in-${i}`,
          conv,
          `${conv}-win-${i}`,
          OCT,
        ),
        env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES (?, 'tnt-demo', ?, ?, 'out', 'ai', 'text', 'hola', 'simulated', 0, ?)").bind(
          `${conv}-out-${i}`,
          conv,
          `${conv}-wout-${i}`,
          OCT,
        ),
      );
    }
  }
  stmts.push(
    env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES ('t1', 'tnt-demo', 'c-real', 'wt1', 'out', 'system', 'template', 'seguimiento', 'simulated', 0, ?)").bind(OCT),
    // Septiembre: no cuenta en octubre.
    env.DB.prepare(
      "INSERT INTO ai_audit_log (id, tenant_id, conversation_id, model, prompt_version, input, tool_calls, reply, blocked, neurons, latency_ms, created_at) VALUES ('sep', 'tnt-demo', 'c-real', 'm', 'v', 'x', '[]', 'y', '[]', 9999, 1, ?)",
    ).bind(Date.UTC(2026, 8, 20)),
  );
  await env.DB.batch(stmts);
});

describe("consumo por desarrolladora", () => {
  it("rango del mes en hora local", () => {
    const [from, to] = monthRange("2026-12", "America/Mexico_City");
    expect(from).toBe(Date.UTC(2026, 11, 1, 6));
    expect(to).toBe(Date.UTC(2027, 0, 1, 6));
  });

  it("cuenta IA y mensajes reales del mes, sin el simulador", async () => {
    const [u] = await computeUsage(getDb(env.DB), "2026-10", "tnt-demo");
    expect(u).toMatchObject({ aiReplies: 3, neurons: 6000, aiUsd: 0.07, conversations: 1, inbound: 3, outboundReplies: 3, templates: 1 });
    // 1 plantilla de marketing; las 3 respuestas caben en las 1,000 gratis.
    expect(u!.whatsappMxnEstimate).toBe(0.73);
  });

  it("Ignia ve el consumo de todas las desarrolladoras; el mes se valida", async () => {
    const all = await exports.default.fetch("https://lynna.test/api/admin/usage?month=2026-10", { headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` } });
    expect(all.status).toBe(200);
    const body = (await all.json()) as { tenants: { slug: string; neurons: number }[] };
    expect(body.tenants.find((t) => t.slug === "demo")!.neurons).toBe(6000);
    const bad = await exports.default.fetch("https://lynna.test/api/admin/usage?month=octubre", { headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}` } });
    expect(bad.status).toBe(400);
  });
});
