import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password";

const ORIGIN = "https://lynna.test";
const PASSWORD = "Contraseña-Segura-2026";

async function createUser(email: string, role: "admin" | "owner" | "manager" | "seller", tenantId: string | null, opts: { active?: boolean; iterations?: number } = {}) {
  await env.DB.prepare(
    "INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  )
    .bind(crypto.randomUUID(), tenantId, email, `Usuario ${role}`, await hashPassword(PASSWORD, opts.iterations), role, opts.active === false ? 0 : 1)
    .run();
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  });
}

async function login(email: string, password = PASSWORD): Promise<string> {
  const res = await post("/api/auth/login", { email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!;
  return cookie.split(";")[0]!; // "lynna_session=<token>"
}

const get = (path: string, cookie: string) => exports.default.fetch(`${ORIGIN}${path}`, { headers: { cookie } });

beforeEach(async () => {
  await env.DB.batch(
    ["sessions", "login_attempts", "users", "audit_log", "lot_media", "lots", "payment_plans", "developments", "messages", "conversations", "prospects", "wa_accounts", "tenants"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch([
    env.DB.prepare("INSERT INTO tenants (id, name, slug, created_at) VALUES ('tnt-a', 'Desarrolladora A', 'a', 0), ('tnt-b', 'Desarrolladora B', 'b', 0)"),
    env.DB.prepare("INSERT INTO developments (id, tenant_id, name, slug, status, created_at, updated_at) VALUES ('dev-a', 'tnt-a', 'Dev A', 'dev-a', 'active', 0, 0)"),
    env.DB.prepare(
      "INSERT INTO lots (id, tenant_id, development_id, block, number, area_m2, price_per_m2_cents, total_price_cents, status, updated_at) VALUES ('lot-a1', 'tnt-a', 'dev-a', 'A', '1', 200, 300000, 60000000, 'available', 0)",
    ),
    env.DB.prepare(
      "INSERT INTO payment_plans (id, tenant_id, name, calculation_type, down_payment_bp, months) VALUES ('plan-a', 'tnt-a', 'Plan A', 'with_interest', 2000, 12)",
    ),
  ]);
});

describe("contraseñas", () => {
  it("verifica la correcta, rechaza otras y pide re-hash con menos iteraciones", async () => {
    const hash = await hashPassword("secreto-123");
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword("secreto-123", hash)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword("secreto-124", hash)).ok).toBe(false);
    expect(await verifyPassword("x", "basura")).toEqual({ ok: false, needsRehash: false });
    expect((await verifyPassword("secreto-123", await hashPassword("secreto-123", 1000))).needsRehash).toBe(true);
  });
});

describe("login", () => {
  it("entra con correo sin importar mayúsculas y pone una cookie HttpOnly segura", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const res = await post("/api/auth/login", { email: "  ANA@a.mx ", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user: { email: "ana@a.mx", role: "manager", tenantId: "tnt-a" }, tenants: [{ slug: "a" }] });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^lynna_session=[\w-]{40,};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    // En BD solo se guarda el hash del token, nunca el token.
    const token = cookie.split(";")[0]!.split("=")[1]!;
    const stored = await env.DB.prepare("SELECT id FROM sessions").first<{ id: string }>();
    expect(stored!.id).not.toBe(token);
    expect(stored!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mismo mensaje para correo inexistente, contraseña mala o usuario inactivo", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    await createUser("baja@a.mx", "manager", "tnt-a", { active: false });
    for (const [email, password] of [
      ["nadie@a.mx", PASSWORD],
      ["ana@a.mx", "incorrecta"],
      ["baja@a.mx", PASSWORD],
    ]) {
      const res = await post("/api/auth/login", { email, password });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials", message: "Correo o contraseña incorrectos." });
    }
  });

  it("bloquea tras 5 intentos fallidos aunque después la contraseña sea correcta", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    for (let i = 0; i < 5; i++) expect((await post("/api/auth/login", { email: "ana@a.mx", password: "mal" })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "ana@a.mx", password: PASSWORD })).status).toBe(429);
  });

  it("un login exitoso reinicia el contador de intentos", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    for (let i = 0; i < 4; i++) await post("/api/auth/login", { email: "ana@a.mx", password: "mal" });
    await login("ana@a.mx");
    for (let i = 0; i < 4; i++) await post("/api/auth/login", { email: "ana@a.mx", password: "mal" });
    expect((await post("/api/auth/login", { email: "ana@a.mx", password: PASSWORD })).status).toBe(200);
  });

  it("re-hashea contraseñas guardadas con menos iteraciones", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a", { iterations: 1000 });
    await login("ana@a.mx");
    const row = await env.DB.prepare("SELECT password_hash FROM users").first<{ password_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
  });

  it("rechaza login desde otro origen", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const res = await post("/api/auth/login", { email: "ana@a.mx", password: PASSWORD }, { origin: "https://malicioso.example" });
    expect(res.status).toBe(403);
  });
});

describe("sesión", () => {
  it("me, logout y sesión inválida tras salir", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const cookie = await login("ana@a.mx");
    expect(await (await get("/api/auth/me", cookie)).json()).toMatchObject({ user: { email: "ana@a.mx" } });

    const out = await post("/api/auth/logout", {}, { cookie });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/lynna_session=;.*Max-Age=0/);
    expect((await get("/api/auth/me", cookie)).status).toBe(401);
  });

  it("una sesión vencida o de un usuario desactivado ya no sirve", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const cookie = await login("ana@a.mx");
    await env.DB.prepare("UPDATE sessions SET expires_at = 1").run();
    expect((await get("/api/auth/me", cookie)).status).toBe(401);

    const fresh = await login("ana@a.mx");
    await env.DB.prepare("UPDATE users SET active = 0").run();
    expect((await get("/api/admin/tenants/a/summary", fresh)).status).toBe(401);
  });

  it("CSRF: con cookie, un cambio sin Origin o de otro origen se rechaza", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const cookie = await login("ana@a.mx");
    const patch = (headers: Record<string, string>) =>
      exports.default.fetch(`${ORIGIN}/api/admin/tenants/a/payment-plans/plan-a`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
        headers: { "content-type": "application/json", cookie, ...headers },
      });
    expect((await patch({})).status).toBe(403);
    expect((await patch({ origin: "https://malicioso.example" })).status).toBe(403);
    expect((await patch({ origin: ORIGIN })).status).toBe(200);
  });
});

describe("permisos", () => {
  it("un usuario solo ve su desarrolladora; las demás responden 404", async () => {
    await createUser("ana@a.mx", "owner", "tnt-a");
    const cookie = await login("ana@a.mx");
    expect((await get("/api/admin/tenants/a/summary", cookie)).status).toBe(200);
    expect((await get("/api/admin/tenants/b/summary", cookie)).status).toBe(404);
    expect(await (await get("/api/admin/tenants", cookie)).json()).toEqual([{ id: "tnt-a", name: "Desarrolladora A", slug: "a" }]);
  });

  it("admin (Ignia) ve todas las desarrolladoras", async () => {
    await createUser("ops@igniastudio.mx", "admin", null);
    const cookie = await login("ops@igniastudio.mx");
    expect((await get("/api/admin/tenants/b/summary", cookie)).status).toBe(200);
    expect(await (await get("/api/auth/me", cookie)).json()).toMatchObject({ tenants: [{ slug: "a" }, { slug: "b" }] });
  });

  it("vendedor: consulta y cotiza, pero no modifica", async () => {
    await createUser("vendedor@a.mx", "seller", "tnt-a");
    const cookie = await login("vendedor@a.mx");
    expect((await get("/api/admin/tenants/a/developments/dev-a/lots", cookie)).status).toBe(200);
    expect((await post("/api/admin/tenants/a/simulate", { lotId: "lot-a1", planId: "plan-a", quoteDate: "2026-10-06" }, { cookie })).status).toBe(200);

    const forbidden = await post("/api/admin/tenants/a/developments", { name: "Nuevo", slug: "nuevo" }, { cookie });
    expect(forbidden.status).toBe(403);
    const status = await exports.default.fetch(`${ORIGIN}/api/admin/tenants/a/lots/lot-a1/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "sold", reason: "intento" }),
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    });
    expect(status.status).toBe(403);
  });

  it("la auditoría registra al usuario real", async () => {
    await createUser("ana@a.mx", "manager", "tnt-a");
    const cookie = await login("ana@a.mx");
    const userId = (await env.DB.prepare("SELECT id FROM users").first<{ id: string }>())!.id;
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const res = await exports.default.fetch(`${ORIGIN}/api/admin/tenants/a/lots/lot-a1/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "reserved", reason: "Apartado", reservedUntil: until }),
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    const audit = await env.DB.prepare("SELECT actor FROM audit_log WHERE action = 'status_change'").first();
    expect(audit).toEqual({ actor: `user:${userId}` });
  });
});
