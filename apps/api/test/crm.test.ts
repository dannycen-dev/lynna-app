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
  it("escalamiento → aviso al equipo, lectura independiente por usuario", async () => {
    const laura = await login("laura@demo.mx");
    const miguel = await login("miguel@demo.mx");
    const turn = await laura.json("/agent/simulator", "POST", { message: "Quiero comprar" });
    expect(turn.escalation).toBe("compra");

    const n = await laura.json("/notifications");
    expect(n.unread).toBe(1);
    expect(n.items[0]).toMatchObject({ kind: "handoff", title: "Laura González quiere comprar", prospectId: turn.prospect.id, readAt: null });

    expect((await laura.call("/notifications/read", "POST", {})).status).toBe(204);
    expect((await laura.json("/notifications")).unread).toBe(0);
    // El aviso es de equipo: Miguel lo sigue teniendo sin leer.
    expect((await miguel.json("/notifications")).unread).toBe(1);
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
