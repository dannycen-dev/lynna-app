import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password";

const ORIGIN = "https://lynna.test";
const T = `${ORIGIN}/api/admin/tenants/demo`;
const PASSWORD = "Contraseña-Usuarios-2026";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createUser(id: string, email: string, role: string) {
  await env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES (?, 'tnt-demo', ?, ?, ?, ?, 1, 0)")
    .bind(id, email, id, await hashPassword(PASSWORD), role)
    .run();
}

async function login(email: string, password = PASSWORD) {
  const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) return { status: res.status, call: null as never, json: null as never };
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const call = (path: string, method = "GET", body?: unknown) =>
    exports.default.fetch(path.startsWith("/api/") ? `${ORIGIN}${path}` : `${T}${path}`, {
      method,
      headers: { cookie, ...(method !== "GET" ? { origin: ORIGIN, "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { status: 200, call, json: async (path: string, method = "GET", body?: unknown) => (await call(path, method, body)).json() as Promise<any> };
}

beforeEach(async () => {
  await env.DB.batch(
    ["notification_reads", "notifications", "sessions", "login_attempts", "audit_log", "appointments", "messages", "conversations", "prospects", "availability_rules", "kb_articles", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await createUser("u-owner", "duena@x.mx", "owner");
  await createUser("u-manager", "gerente@x.mx", "manager");
  await createUser("u-seller", "vendedor@x.mx", "seller");
});

describe("usuarios desde el panel", () => {
  it("alta con contraseña temporal: hay que cambiarla antes de usar la app", async () => {
    const owner = await login("duena@x.mx");
    const res = await owner.call("/users", "POST", { name: "Pedro Nuevo", email: "Pedro@X.mx", role: "manager" });
    expect(res.status).toBe(201);
    const { user, temporaryPassword } = (await res.json()) as { user: { email: string; mustChangePassword: boolean }; temporaryPassword: string };
    expect(user).toMatchObject({ email: "pedro@x.mx", mustChangePassword: true });
    expect(temporaryPassword).toMatch(/^[A-Za-z2-9]{14}$/);
    expect((await owner.call("/users", "POST", { name: "Otro", email: "pedro@x.mx", role: "seller" })).status).toBe(409);

    const pedro = await login("pedro@x.mx", temporaryPassword);
    expect((await pedro.json("/api/auth/me")).user.mustChangePassword).toBe(true);
    const blocked = await pedro.call("/summary");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "password_change_required" });

    expect((await pedro.call("/api/auth/password", "POST", { current: "incorrecta", next: "Nueva-Contraseña-1" })).status).toBe(400);
    expect((await pedro.call("/api/auth/password", "POST", { current: temporaryPassword, next: "corta" })).status).toBe(400);
    expect((await pedro.call("/api/auth/password", "POST", { current: temporaryPassword, next: "Nueva-Contraseña-1" })).status).toBe(204);
    expect((await pedro.call("/summary")).status).toBe(200);
    expect((await login("pedro@x.mx", "Nueva-Contraseña-1")).status).toBe(200);
  });

  it("el gerente solo administra vendedores; el vendedor a nadie", async () => {
    const manager = await login("gerente@x.mx");
    expect((await manager.call("/users", "POST", { name: "Vendedora", email: "v2@x.mx", role: "seller" })).status).toBe(201);
    expect((await manager.call("/users", "POST", { name: "Gerente 2", email: "g2@x.mx", role: "manager" })).status).toBe(403);
    expect((await manager.call("/users/u-owner", "PATCH", { name: "Cambiado" })).status).toBe(403);
    expect((await manager.call("/users/u-seller", "PATCH", { role: "manager" })).status).toBe(403);
    expect((await manager.json("/users")).manageableRoles).toEqual(["seller"]);

    const seller = await login("vendedor@x.mx");
    expect((await seller.call("/users")).status).toBe(403);
    expect((await seller.call("/users", "POST", { name: "X", email: "x@x.mx", role: "seller" })).status).toBe(403);
  });

  it("desactivar cierra sus sesiones y avisa cuántos prospectos tenía; reactivar le devuelve el acceso", async () => {
    await env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, assigned_user_id, created_at, updated_at) VALUES ('p1', 'tnt-demo', '5219990001111', 'qualified', 30, 'whatsapp', 'u-seller', 0, 0)").run();
    const seller = await login("vendedor@x.mx");
    expect((await seller.call("/summary")).status).toBe(200);
    const manager = await login("gerente@x.mx");
    const off = await manager.json("/users/u-seller", "PATCH", { active: false });
    expect(off).toMatchObject({ user: { active: false }, openProspects: 1 });
    expect((await seller.call("/summary")).status).toBe(401);
    expect((await login("vendedor@x.mx")).status).toBe(401);
    await manager.call("/users/u-seller", "PATCH", { active: true });
    expect((await login("vendedor@x.mx")).status).toBe(200);
  });

  it("nadie se desactiva ni se cambia el rol a sí mismo; siempre queda un dueño activo", async () => {
    const owner = await login("duena@x.mx");
    expect((await owner.call("/users/u-owner", "PATCH", { active: false })).status).toBe(403);
    expect((await owner.call("/users/u-owner", "PATCH", { role: "manager" })).status).toBe(403);
    expect((await owner.call("/users/u-owner", "PATCH", { name: "Dueña Demo" })).status).toBe(200);
    // Con el token de automatización (no es "uno mismo"), quitar a la única dueña se rechaza.
    const asToken = (path: string, body: unknown) =>
      exports.default.fetch(`${T}${path}`, { method: "PATCH", headers: { authorization: `Bearer ${env.ADMIN_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await asToken("/users/u-owner", { active: false })).status).toBe(409);
    expect((await asToken("/users/u-owner", { role: "manager" })).status).toBe(409);
    await createUser("u-owner2", "dueno2@x.mx", "owner");
    expect((await asToken("/users/u-owner", { active: false })).status).toBe(200);
  });

  it("restablecer contraseña: cierra sus sesiones y le da una temporal", async () => {
    const seller = await login("vendedor@x.mx");
    const owner = await login("duena@x.mx");
    expect((await owner.call("/users/u-owner/reset-password", "POST")).status).toBe(403);
    const { temporaryPassword } = await owner.json("/users/u-seller/reset-password", "POST");
    expect((await seller.call("/summary")).status).toBe(401);
    expect((await login("vendedor@x.mx")).status).toBe(401);
    const again = await login("vendedor@x.mx", temporaryPassword);
    expect((await again.json("/api/auth/me")).user.mustChangePassword).toBe(true);
    const audit = await env.DB.prepare("SELECT action FROM audit_log WHERE entity_id = 'u-seller'").all();
    expect(audit.results.map((r) => r.action)).toContain("password_reset");
  });
});
