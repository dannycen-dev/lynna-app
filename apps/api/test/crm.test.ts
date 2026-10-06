import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";

const ORIGIN = "https://lynna.test";
const T = `${ORIGIN}/api/admin/tenants/demo`;
const PASSWORD = "Contraseña-CRM-2026";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createUser(id: string, email: string, role: string, name: string) {
  await env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES (?, 'tnt-demo', ?, ?, ?, ?, 1, 0)")
    .bind(id, email, name, await hashPassword(PASSWORD), role)
    .run();
}

async function login(email: string) {
  const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const call = (path: string, method = "GET", body?: unknown) =>
    exports.default.fetch(`${T}${path}`, {
      method,
      headers: { cookie, ...(method !== "GET" ? { origin: ORIGIN, "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { call, json: async (path: string, method = "GET", body?: unknown) => (await call(path, method, body)).json() as Promise<any> };
}

beforeEach(async () => {
  await env.DB.batch(
    [
      "notification_reads",
      "notifications",
      "prospect_notes",
      "sessions",
      "login_attempts",
      "ai_audit_log",
      "audit_log",
      "messages",
      "conversations",
      "prospects",
      "users",
      "lot_media",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await createUser("u-laura", "laura@demo.mx", "manager", "Laura González");
  await createUser("u-miguel", "miguel@demo.mx", "seller", "Miguel Torres");
});

describe("CRM", () => {
  it("escalamiento: el aviso va al vendedor asignado; si no hay, al equipo (gerentes)", async () => {
    const laura = await login("laura@demo.mx");
    const miguel = await login("miguel@demo.mx");

    // Prospecto de Miguel (su simulador): solo Miguel recibe el aviso.
    const own = await miguel.json("/agent/simulator", "POST", { message: "Quiero comprar" });
    expect(own.escalation).toBe("compra");
    const forMiguel = await miguel.json("/notifications");
    expect(forMiguel.unread).toBe(1);
    expect(forMiguel.items[0]).toMatchObject({ kind: "handoff", title: "Miguel Torres quiere comprar", readAt: null });
    expect((await laura.json("/notifications")).unread).toBe(0);

    // Prospecto sin vendedor (simulador vía automatización, no se asigna): aviso de equipo,
    // lo ve el gerente y no el vendedor.
    await exports.default.fetch(`${T}/agent/simulator`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}`, "x-simulator-session": "equipo", "content-type": "application/json" },
      body: JSON.stringify({ message: "¿Me haces un descuento?" }),
    });
    expect((await laura.json("/notifications")).items[0]).toMatchObject({ title: "Simulador pide un descuento" });

    expect((await miguel.call("/notifications/read", "POST", {})).status).toBe(204);
    expect((await miguel.json("/notifications")).unread).toBe(0);
    expect((await laura.json("/notifications")).unread).toBe(1);
  });

  it("ficha: conversación, historial, etapa (perdido exige motivo) y notas", async () => {
    const laura = await login("laura@demo.mx");
    const turn = await laura.json("/agent/simulator", "POST", { message: "¿Qué lotes tienen?" });
    const id = turn.prospect.id;

    expect((await laura.call(`/prospects/${id}/stage`, "PATCH", { stage: "lost" })).status).toBe(400);
    const moved = await laura.json(`/prospects/${id}/stage`, "PATCH", { stage: "negotiation", reason: "Pidió segunda visita" });
    expect(moved.stage).toBe("negotiation");
    expect((await laura.call(`/prospects/${id}/notes`, "POST", { body: "Le interesa la Manzana C." })).status).toBe(201);

    const ficha = await laura.json(`/prospects/${id}`);
    expect(ficha.messages.map((m: { direction: string }) => m.direction)).toEqual(["in", "out"]);
    expect(ficha.notes[0]).toMatchObject({ body: "Le interesa la Manzana C.", authorName: "Laura González" });
    expect(ficha.history[0]).toMatchObject({ action: "stage_change", actorName: "Laura González", data: { from: "new", to: "negotiation", reason: "Pidió segunda visita" } });
    expect(ficha.lastAi).toMatchObject({ model: "fake" });
  });

  it("tomar la conversación: la IA se calla, el asesor responde y luego la devuelve", async () => {
    const laura = await login("laura@demo.mx");
    const first = await laura.json("/agent/simulator", "POST", { message: "Hola" });
    const conversationId = first.conversationId;

    const taken = await laura.json(`/conversations/${conversationId}/takeover`, "POST", {});
    expect(taken).toMatchObject({ aiPaused: true, takenByUserId: "u-laura" });

    const silent = await laura.json("/agent/simulator", "POST", { message: "¿Sigues ahí?" });
    expect(silent.reply).toBeNull();
    expect(silent.skippedReason).toContain("pausada");

    const sent = await laura.call(`/conversations/${conversationId}/messages`, "POST", { body: "Hola, soy Laura, tu asesora." });
    expect(sent.status).toBe(201);
    expect(await sent.json()).toMatchObject({ author: "user", direction: "out", status: "simulated" });

    await laura.call(`/conversations/${conversationId}/release`, "POST", {});
    const back = await laura.json("/agent/simulator", "POST", { message: "¿Qué lotes tienen?" });
    expect(back.reply).toContain("Manzana C, lote 2");

    const ficha = await laura.json(`/prospects/${first.prospect.id}`);
    expect(ficha.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(["taken_over", "returned_to_ai"]));
  });

  it("escribir como asesor toma la conversación automáticamente", async () => {
    const laura = await login("laura@demo.mx");
    const first = await laura.json("/agent/simulator", "POST", { message: "Hola" });
    await laura.call(`/conversations/${first.conversationId}/messages`, "POST", { body: "Te atiendo yo." });
    const ficha = await laura.json(`/prospects/${first.prospect.id}`);
    expect(ficha.conversation).toMatchObject({ aiPaused: true, takenByUserId: "u-laura", takenByName: "Laura González" });
  });

  it("vendedor: puede trabajar sus prospectos pero no el inventario", async () => {
    const miguel = await login("miguel@demo.mx");
    const turn = await miguel.json("/agent/simulator", "POST", { message: "Hola" });
    expect((await miguel.call(`/prospects/${turn.prospect.id}/stage`, "PATCH", { stage: "qualified" })).status).toBe(200);
    expect((await miguel.call(`/prospects/${turn.prospect.id}/notes`, "POST", { body: "Llamar mañana" })).status).toBe(201);
    expect((await miguel.call("/developments", "POST", { name: "X", slug: "x" })).status).toBe(403);
  });

  it("no se ve el prospecto de otra desarrolladora", async () => {
    await env.DB.prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES ('tnt-otra', 'Otra', 'otra', 0)").run();
    await env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, created_at, updated_at) VALUES ('p-otra', 'tnt-otra', '1', 'new', 0, 'whatsapp', 0, 0)").run();
    const laura = await login("laura@demo.mx");
    expect((await laura.call("/prospects/p-otra")).status).toBe(404);
  });
});

describe("asignación y permisos", () => {
  async function prospect(id: string, assigned: string | null, extra = "") {
    await env.DB.prepare(
      `INSERT INTO prospects (id, tenant_id, phone, name, stage, score, source, assigned_user_id, created_at, updated_at${extra ? ", " + extra.split("=")[0] : ""}) VALUES (?, 'tnt-demo', ?, ?, 'new', 0, 'whatsapp', ?, 0, 0${extra ? ", " + extra.split("=")[1] : ""})`,
    )
      .bind(id, `52199900${id.slice(-3)}`, `Prospecto ${id}`, assigned)
      .run();
  }

  it("el vendedor solo ve sus prospectos; el gerente ve todos", async () => {
    await createUser("u-ana", "ana@demo.mx", "seller", "Ana Hernández");
    await prospect("p-001", "u-miguel");
    await prospect("p-002", "u-ana");
    await prospect("p-003", null);
    const miguel = await login("miguel@demo.mx");
    const laura = await login("laura@demo.mx");

    expect((await miguel.json("/prospects")).map((p: { id: string }) => p.id)).toEqual(["p-001"]);
    expect((await laura.json("/prospects")).map((p: { id: string }) => p.id).sort()).toEqual(["p-001", "p-002", "p-003"]);
    expect((await miguel.call("/prospects/p-002")).status).toBe(404);
    expect((await miguel.call("/prospects/p-002/stage", "PATCH", { stage: "qualified" })).status).toBe(404);
    expect((await laura.json("/prospects/p-001")).prospect.assignedName).toBe("Miguel Torres");
  });

  it("reparto en turno al llegar un prospecto por WhatsApp (round-robin entre vendedores)", async () => {
    await createUser("u-ana", "ana@demo.mx", "seller", "Ana Hernández");
    const { processInboundEvent } = await import("../src/whatsapp/inbound");
    const message = (from: string, wamid: string) => ({
      kind: "message" as const,
      phoneNumberId: "DEMO_PHONE_NUMBER_ID",
      from,
      wamid,
      timestamp: Date.now(),
      type: "text",
      text: "Hola",
    });
    for (const [i, phone] of ["5219990000001", "5219990000002", "5219990000003"].entries()) {
      await processInboundEvent(message(phone, `w-rr-${i}`), { ...env, AUTO_REPLY_MODE: "off" });
    }
    const rows = await env.DB.prepare("SELECT phone, assigned_user_id FROM prospects ORDER BY phone").all<{ phone: string; assigned_user_id: string }>();
    const owners = rows.results.map((r) => r.assigned_user_id);
    // Se alternan: nadie recibe dos seguidos mientras el otro tiene menos.
    expect(new Set(owners.slice(0, 2)).size).toBe(2);
    expect(owners.every(Boolean)).toBe(true);
    const assignedNotifications = await env.DB.prepare("SELECT count(*) n FROM notifications WHERE kind = 'assignment'").first<{ n: number }>();
    expect(assignedNotifications!.n).toBe(3);
  });

  it("modo manual y vendedor que no recibe prospectos", async () => {
    const laura = await login("laura@demo.mx");
    const { processInboundEvent } = await import("../src/whatsapp/inbound");
    const msg = (from: string) => ({ kind: "message" as const, phoneNumberId: "DEMO_PHONE_NUMBER_ID", from, wamid: `w-${from}`, timestamp: Date.now(), type: "text", text: "Hola" });

    // Miguel no recibe prospectos → queda sin asignar (para el gerente).
    expect((await laura.call("/team/u-miguel", "PATCH", { receivesLeads: false })).status).toBe(200);
    await processInboundEvent(msg("5219991111111"), env);
    expect((await env.DB.prepare("SELECT assigned_user_id a FROM prospects").first<{ a: string | null }>())!.a).toBeNull();

    // Modo manual: no se reparte aunque haya vendedores disponibles.
    await laura.call("/team/u-miguel", "PATCH", { receivesLeads: true });
    expect(await laura.json("/settings/assignment", "PATCH", { assignmentMode: "manual" })).toMatchObject({ assignmentMode: "manual" });
    await processInboundEvent(msg("5219992222222"), env);
    expect((await env.DB.prepare("SELECT count(*) n FROM prospects WHERE assigned_user_id IS NOT NULL").first<{ n: number }>())!.n).toBe(0);

    // El gerente asigna a mano; el vendedor no puede.
    const id = (await env.DB.prepare("SELECT id FROM prospects LIMIT 1").first<{ id: string }>())!.id;
    expect(await laura.json(`/prospects/${id}/assign`, "PATCH", { userId: "u-miguel" })).toMatchObject({ assignedUserId: "u-miguel" });
    const miguel = await login("miguel@demo.mx");
    expect((await miguel.call(`/prospects/${id}/assign`, "PATCH", { userId: null })).status).toBe(403);
    expect((await miguel.call("/settings/assignment", "PATCH", { assignmentMode: "round_robin" })).status).toBe(403);
  });

  it("reasignación automática si el vendedor no atiende a tiempo (máximo 2)", async () => {
    await createUser("u-ana", "ana@demo.mx", "seller", "Ana Hernández");
    const old = Date.now() - 60 * 60_000;
    await prospect("p-100", "u-miguel", `handoff_at, assigned_at=${old}, ${old}`);
    await env.DB.prepare("UPDATE prospects SET handoff_at = ?, assigned_at = ? WHERE id = 'p-100'").bind(old, old).run();
    const { reassignStale } = await import("../src/crm/assignment");
    const { getDb } = await import("../src/db/client");

    const first = await reassignStale(getDb(env.DB));
    expect(first).toEqual([{ prospectId: "p-100", from: "u-miguel", to: "u-ana" }]);
    // Recién reasignado: no se mueve de nuevo hasta que pase otra vez el plazo.
    expect(await reassignStale(getDb(env.DB))).toEqual([]);
    // Si el nuevo vendedor toma la conversación, ya no se reasigna.
    await env.DB.prepare("UPDATE prospects SET assigned_at = ? WHERE id = 'p-100'").bind(old).run();
    await env.DB.prepare(
      "INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, taken_by_user_id, taken_at, created_at) VALUES ('c-100', 'tnt-demo', 'p-100', 'wa-demo', 1, 'u-ana', ?, 0)",
    )
      .bind(Date.now())
      .run();
    expect(await reassignStale(getDb(env.DB))).toEqual([]);
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE entity_id = 'p-100'").all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toContain("reassigned");
  });
});
