import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";
import { getDb } from "../src/db/client";
import { ftsQuery, searchKnowledge } from "../src/knowledge/search";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function article(id: string, title: string, body: string, keywords: string | null, status = "approved") {
  await env.DB.prepare(
    "INSERT INTO kb_articles (id, tenant_id, title, body, keywords, category, status, created_at, updated_at) VALUES (?, 'tnt-demo', ?, ?, ?, 'general', ?, 0, 0)",
  )
    .bind(id, title, body, keywords, status)
    .run();
}

const ORIGIN = "https://lynna.test";
const T = `${ORIGIN}/api/admin/tenants/demo`;
const PASSWORD = "Contraseña-KB-2026";

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
    ["kb_articles", "appointments", "notification_reads", "notifications", "sessions", "login_attempts", "ai_audit_log", "audit_log", "messages", "conversations", "prospects", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await article("kb-servicios", "Servicios del desarrollo", "Cada lote cuenta con toma de agua potable, electricidad y drenaje.", "agua, luz, electricidad, CFE, drenaje");
  await article("kb-pagos", "Formas de pago aceptadas", "Los pagos se hacen por transferencia o depósito a la cuenta de la empresa; el apartado es de $10,000 MXN. No se aceptan pagos en efectivo.", "efectivo, tarjeta, transferencia");
  await article("kb-construir", "¿Cuándo puedo construir?", "Puedes construir desde la entrega del lote, respetando el reglamento de construcción.", "construcción, obra, casa");
  await createUser("u-laura", "laura@demo.mx", "manager", "Laura González");
  await createUser("u-miguel", "miguel@demo.mx", "seller", "Miguel Torres");
  await article("kb-borrador", "Aviso de mantenimiento", "La cuota de mantenimiento es de $800 al mes.", "cuota, mantenimiento", "draft");
});

describe("base de conocimiento: búsqueda", () => {
  it("convierte la pregunta en raíces con prefijo y quita palabras vacías", () => {
    expect(ftsQuery("¿Los terrenos tienen agua y luz?")).toBe('"terren"* OR "agu"* OR "luz"*');
    expect(ftsQuery("¿Qué necesito para escriturar?")).toBe('"necesi"* OR "escritur"*');
    expect(ftsQuery("hola, ¿qué tal?")).toBe('"tal"*');
    expect(ftsQuery("¿y?")).toBeNull();
  });

  it("encuentra por sinónimos, sin acentos y por raíz", async () => {
    const db = getDb(env.DB);
    const first = async (q: string) => (await searchKnowledge(db, "tnt-demo", q, { approvedOnly: true }))[0]?.id;
    expect(await first("¿Ya tiene luz el terreno?")).toBe("kb-servicios");
    expect(await first("¿Hay CFE?")).toBe("kb-servicios");
    expect(await first("¿Puedo pagar en efectivo?")).toBe("kb-pagos");
    expect(await first("¿cuando empiezo la construccion de mi casa?")).toBe("kb-construir");
  });

  it("la IA no ve borradores; el índice se actualiza al editar y borrar", async () => {
    const db = getDb(env.DB);
    expect(await searchKnowledge(db, "tnt-demo", "cuota de mantenimiento", { approvedOnly: true })).toEqual([]);
    expect((await searchKnowledge(db, "tnt-demo", "cuota de mantenimiento"))[0]?.id).toBe("kb-borrador");

    await env.DB.prepare("UPDATE kb_articles SET keywords = 'agua, luz, internet, fibra óptica' WHERE id = 'kb-servicios'").run();
    expect((await searchKnowledge(db, "tnt-demo", "¿llega la fibra?", { approvedOnly: true }))[0]?.id).toBe("kb-servicios");

    await env.DB.prepare("DELETE FROM kb_articles WHERE id = 'kb-servicios'").run();
    expect(await searchKnowledge(db, "tnt-demo", "¿llega la fibra?", { approvedOnly: true })).toEqual([]);
  });
});

describe("base de conocimiento: panel y agente", () => {
  it("el gerente escribe y aprueba; el vendedor solo consulta", async () => {
    const laura = await login("laura@demo.mx");
    const miguel = await login("miguel@demo.mx");
    const draft = { title: "Horario de la oficina de ventas", body: "Atendemos de lunes a sábado de 9:00 a 18:00 en la caseta del desarrollo.", keywords: "horario, oficina, caseta", category: "oficina" };
    expect((await miguel.call("/knowledge", "POST", draft)).status).toBe(403);
    const created = await laura.json("/knowledge", "POST", draft);
    expect(created).toMatchObject({ status: "draft", approvedByUserId: null });
    // Borrador: la IA todavía no lo ve.
    expect((await laura.json("/knowledge/search?q=horario%20de%20la%20oficina")).hits).toEqual([]);
    const approved = await laura.json(`/knowledge/${created.id}`, "PATCH", { status: "approved" });
    expect(approved).toMatchObject({ status: "approved", approvedByUserId: "u-laura" });
    expect((await miguel.json("/knowledge/search?q=horario%20de%20la%20oficina")).hits[0].id).toBe(created.id);
    expect((await miguel.json("/knowledge")).map((a: { title: string }) => a.title)).toContain("Horario de la oficina de ventas");
    expect((await laura.call(`/knowledge/${created.id}`, "DELETE")).status).toBe(204);
    expect((await laura.call("/knowledge", "POST", { title: "x", body: "corto" })).status).toBe(400);
  });

  it("la IA responde con el texto aprobado y el validador acepta sus montos", async () => {
    const laura = await login("laura@demo.mx");
    const turn = await laura.json("/agent/simulator", "POST", { message: "¿Aceptan pagos en efectivo?" });
    expect(turn.tools.map((t: { name: string }) => t.name)).toContain("consultar_informacion");
    expect(turn.blocked).toEqual([]);
    expect(turn.fallback).toBe(false);
    // El monto del apartado viene del artículo aprobado, no de la imaginación del modelo.
    expect(turn.reply).toContain("$10,000");
    expect(turn.reply).toContain("No se aceptan pagos en efectivo");
  });

  it("sin información aprobada, la IA no inventa", async () => {
    const laura = await login("laura@demo.mx");
    // Ninguna palabra coincide con un artículo aprobado. (Si coincidiera solo de pasada —"reglamento"—, la
    // herramienta pide al modelo decir que no tiene el dato; eso lo mide la eval con el modelo real.)
    const turn = await laura.json("/agent/simulator", "POST", { message: "¿Se permiten mascotas?" });
    expect(turn.tools.map((t: { name: string }) => t.name)).toContain("consultar_informacion");
    expect(turn.reply).toContain("asesor");
  });
});
