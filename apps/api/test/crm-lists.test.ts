import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";
import { toCsv } from "../src/lib/csv";

const ORIGIN = "https://lynna.test";
const T = `${ORIGIN}/api/admin/tenants/demo`;
const PASSWORD = "Contraseña-CRM-Listas-2026";
const NOW = Date.now();
const H = 3_600_000;

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function login(email: string) {
  const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return (path: string) => exports.default.fetch(`${T}${path}`, { headers: { cookie } });
}

type Row = { id: string; name: string; phone: string; stage: string; score: number; dev?: string | null; owner?: string | null; source?: string; created?: number; handoffAt?: number | null; reason?: string | null };
const prospect = (r: Row) =>
  env.DB.prepare(
    `INSERT INTO prospects (id, tenant_id, phone, name, stage, score, interest_development_id, assigned_user_id, source, handoff_at, handoff_reason, created_at, updated_at)
     VALUES (?, 'tnt-demo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(r.id, r.phone, r.name, r.stage, r.score, r.dev ?? null, r.owner ?? null, r.source ?? "whatsapp", r.handoffAt ?? null, r.reason ?? null, r.created ?? NOW - H, r.created ?? NOW - H);

beforeEach(async () => {
  await env.DB.batch(
    ["appointments", "notification_reads", "notifications", "prospect_notes", "sessions", "login_attempts", "ai_audit_log", "audit_log", "messages", "conversations", "prospects", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  const hash = await hashPassword(PASSWORD);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-laura', 'tnt-demo', 'laura@x.mx', 'Laura', ?, 'manager', 1, 0)").bind(hash),
    env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-miguel', 'tnt-demo', 'miguel@x.mx', 'Miguel', ?, 'seller', 1, 0)").bind(hash),
    env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-ana', 'tnt-demo', 'ana@x.mx', 'Ana', ?, 'seller', 1, 0)").bind(hash),
    prospect({ id: "p1", name: "Roberto Chan", phone: "5219991110001", stage: "won", score: 100, dev: "dev-almendros", owner: "u-miguel" }),
    prospect({ id: "p2", name: "Fernanda Ruiz", phone: "5219991110002", stage: "lost", score: 70, dev: "dev-almendros", owner: "u-miguel", handoffAt: NOW - 50 * 60_000, reason: "descuento" }),
    prospect({ id: "p3", name: "=HYPERLINK(\"http://x\")", phone: "5219991110003", stage: "qualified", score: 35, owner: "u-ana" }),
    prospect({ id: "p4", name: "Jorge Pech", phone: "5219991110004", stage: "new", score: 0, owner: null, source: "simulator" }),
    prospect({ id: "p5", name: "Antiguo", phone: "5219991110005", stage: "new", score: 0, created: NOW - 60 * 24 * H }),
  ]);
});

describe("CRM: filtros del listado", () => {
  it("búsqueda, calificación, desarrollo, vendedor, etapa, origen y fechas", async () => {
    const laura = await login("laura@x.mx");
    const ids = async (qs: string) => ((await (await laura(`/prospects?${qs}`)).json()) as { id: string }[]).map((p) => p.id).sort();
    expect(await ids("q=fernanda")).toEqual(["p2"]);
    expect(await ids("q=999111-0004")).toEqual(["p4"]); // por teléfono, aunque traiga guiones
    expect(await ids("temperature=caliente")).toEqual(["p2"]);
    expect(await ids("temperature=listo")).toEqual(["p1"]);
    expect(await ids("development=dev-almendros")).toEqual(["p1", "p2"]);
    expect(await ids("owner=none")).toEqual(["p4", "p5"]);
    expect(await ids("stage=lost")).toEqual(["p2"]);
    expect(await ids("source=simulator")).toEqual(["p4"]);
    const yesterday = new Date(NOW - 30 * 24 * H).toISOString().slice(0, 10);
    expect(await ids(`from=${yesterday}`)).toEqual(["p1", "p2", "p3", "p4"]);
    const res = await laura("/prospects?owner=u-miguel");
    expect(res.headers.get("x-total-count")).toBe("2");
    expect((await laura("/prospects?temperature=hirviendo")).status).toBe(400);
  });

  it("un vendedor solo ve los suyos, aunque filtre por otro", async () => {
    const miguel = await login("miguel@x.mx");
    const rows = (await (await miguel("/prospects?owner=u-ana")).json()) as unknown[];
    expect(rows).toEqual([]);
    expect(((await (await miguel("/prospects")).json()) as { id: string }[]).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
});

describe("CRM: exportar CSV", () => {
  it("escapa comas, comillas y fórmulas (inyección CSV)", () => {
    expect(toCsv([["a,b", 'di "hola"', "=1+1", "-5", 7, null]])).toBe('﻿"a,b","di ""hola""",\'=1+1,\'-5,7,\r\n');
  });

  it("solo gerente; respeta los filtros y queda en el historial", async () => {
    const miguel = await login("miguel@x.mx");
    expect((await miguel("/exports/prospects.csv")).status).toBe(403);
    const laura = await login("laura@x.mx");
    const res = await laura("/exports/prospects.csv?development=dev-almendros");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/prospectos-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await res.text();
    const lines = text.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toContain("Nombre,Teléfono,Correo,Etapa");
    expect(lines).toHaveLength(3);
    expect(text).toContain("Roberto Chan,52 1 999 111 0001");
    expect(text).toContain(",Vendido,");

    const all = await (await laura("/exports/prospects.csv")).text();
    expect(all).toContain(`"'=HYPERLINK(""http://x"")"`);
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'prospects_exported'").all();
    expect(audit.results).toHaveLength(2);
  });
});

describe("CRM: métricas", () => {
  it("embudo con la etapa más avanzada, tiempos de respuesta, citas y por vendedor", async () => {
    await env.DB.batch([
      // Fernanda llegó a "Negociación" antes de perderse.
      env.DB.prepare("INSERT INTO audit_log (id, tenant_id, actor, entity, entity_id, action, data, created_at) VALUES ('a1', 'tnt-demo', 'system', 'prospect', 'p2', 'stage_change', ?, ?)").bind(JSON.stringify({ from: "qualified", to: "negotiation" }), NOW - 40 * 60_000),
      env.DB.prepare("INSERT INTO audit_log (id, tenant_id, actor, entity, entity_id, action, data, created_at) VALUES ('a2', 'tnt-demo', 'system', 'prospect', 'p2', 'stage_change', ?, ?)").bind(JSON.stringify({ from: "negotiation", to: "lost", reason: "Compró en otro desarrollo" }), NOW - 30 * 60_000),
      // Citas: Roberto asistió, Jorge no.
      env.DB.prepare("INSERT INTO appointments (id, tenant_id, prospect_id, user_id, starts_at, ends_at, status, source, created_at, updated_at) VALUES ('ap1', 'tnt-demo', 'p1', 'u-miguel', ?, ?, 'completed', 'ai', ?, 0)").bind(NOW - 3 * H, NOW - 2 * H, NOW - 50 * 60_000),
      env.DB.prepare("INSERT INTO appointments (id, tenant_id, prospect_id, user_id, starts_at, ends_at, status, source, created_at, updated_at) VALUES ('ap2', 'tnt-demo', 'p4', 'u-ana', ?, ?, 'no_show', 'ai', ?, 0)").bind(NOW - 3 * H, NOW - 2 * H, NOW - 50 * 60_000),
      // Conversación de Fernanda: la IA contesta en 4 s; un asesor escribe 20 min después de turnar.
      env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('c2', 'tnt-demo', 'p2', 'wa-demo', 0, ?)").bind(NOW - 55 * 60_000),
      env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES ('m1', 'tnt-demo', 'c2', 'w1', 'in', 'prospect', 'text', 'hola', 'received', 0, ?)").bind(NOW - 55 * 60_000),
      env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES ('m2', 'tnt-demo', 'c2', 'w2', 'out', 'ai', 'text', 'hola!', 'simulated', 0, ?)").bind(NOW - 55 * 60_000 + 4000),
      env.DB.prepare("INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES ('m3', 'tnt-demo', 'c2', 'w3', 'out', 'user', 'text', 'soy tu asesor', 'simulated', 0, ?)").bind(NOW - 30 * 60_000),
    ]);
    const laura = await login("laura@x.mx");
    const m = (await (await laura("/metrics?days=30")).json()) as any;
    expect(m.prospects).toMatchObject({ total: 4, whatsapp: 3, simulator: 1, won: 1, lost: 1 });
    const reached = Object.fromEntries(m.funnel.map((f: { stage: string; count: number }) => [f.stage, f.count]));
    // p4 tuvo cita (aunque no asistió): llegó a "Cita agendada", así que también cuenta como calificado.
    expect(reached).toMatchObject({ new: 4, qualified: 4, appointment: 3, visited: 2, negotiation: 2, won: 1 });
    expect(m.lostReasons).toEqual([{ reason: "Compró en otro desarrollo", count: 1 }]);
    expect(m.response).toMatchObject({ aiMedianSeconds: 4, aiSamples: 1, advisorMedianMinutes: 20, advisorWithin30Min: 1, handoffs: 1, handoffsPending: 0 });
    expect(m.appointments).toMatchObject({ total: 2, completed: 1, noShow: 1, showRate: 0.5 });
    expect(m.sellers.find((s: { name: string }) => s.name === "Miguel")).toMatchObject({ prospects: 2, appointments: 1, won: 1, lost: 1 });

    // El vendedor solo ve lo suyo.
    const miguel = await login("miguel@x.mx");
    const mine = (await (await miguel("/metrics?days=30")).json()) as any;
    expect(mine.prospects.total).toBe(2);
    expect(mine.sellers.map((s: { name: string }) => s.name)).toEqual(["Miguel"]);
    expect((await laura("/metrics?days=12")).status).toBe(400);
  });
});
