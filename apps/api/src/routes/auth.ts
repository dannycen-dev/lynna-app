import { and, asc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { authenticate, type AuthVariables } from "../auth/middleware";
import { DUMMY_HASH, hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from "../auth/password";
import { createSession, destroySession, revokeUserSessions, type SessionUser } from "../auth/session";
import { getDb, type Db } from "../db/client";
import { loginAttempts, tenants, users } from "../db/schema";
import { auditInsert } from "../lib/audit";
import { log } from "../lib/log";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export const auth = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const loginBody = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1).max(200),
});

async function accessibleTenants(db: Db, user: SessionUser) {
  const query = db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug }).from(tenants);
  return user.role === "admin" ? query.orderBy(asc(tenants.name)) : query.where(eq(tenants.id, user.tenantId ?? ""));
}

auth.post("/login", async (c) => {
  // CSRF de login: solo desde la propia app.
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "forbidden", message: "Origen no permitido." }, 403);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const parsed = loginBody.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation", message: "Escribe un correo y una contraseña válidos." }, 400);
  const { email, password } = parsed.data;

  const db = getDb(c.env.DB);
  const since = Date.now() - LOCKOUT_WINDOW_MS;
  const failed = await db.$count(loginAttempts, and(eq(loginAttempts.email, email), gte(loginAttempts.createdAt, since)));
  if (failed >= MAX_FAILED_ATTEMPTS) {
    log("warn", "auth.locked", { failed });
    return c.json({ error: "too_many_attempts", message: "Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo." }, 429);
  }

  const user = await db.select().from(users).where(eq(users.email, email)).get();
  // Siempre se calcula un hash (aunque el correo no exista) para no revelar qué correos están dados de alta.
  const result = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !user.active || !result.ok) {
    await db.insert(loginAttempts).values({ email, createdAt: Date.now() });
    log("info", "auth.login_failed", { reason: !user ? "unknown_email" : !user.active ? "inactive" : "bad_password" });
    return c.json({ error: "invalid_credentials", message: "Correo o contraseña incorrectos." }, 401);
  }

  await db.batch([
    db.delete(loginAttempts).where(eq(loginAttempts.email, email)),
    db
      .update(users)
      .set({ lastLoginAt: Date.now(), ...(result.needsRehash ? { passwordHash: await hashPassword(password) } : {}) })
      .where(eq(users.id, user.id)),
  ]);
  await createSession(c, db, user.id);
  log("info", "auth.login", { userId: user.id, role: user.role });

  const sessionUser: SessionUser = { id: user.id, tenantId: user.tenantId, email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword };
  return c.json({ user: sessionUser, tenants: await accessibleTenants(db, sessionUser) });
});

auth.post("/logout", async (c) => {
  await destroySession(c, getDb(c.env.DB));
  return c.body(null, 204);
});

auth.get("/me", authenticate, async (c) => {
  const p = c.var.principal;
  if (p.kind !== "user") return c.json({ error: "not_a_user", message: "Este endpoint es para sesiones de usuario." }, 400);
  return c.json({ user: p.user, tenants: await accessibleTenants(getDb(c.env.DB), p.user) });
});

/** Cambiar mi contraseña (también la temporal). Cierra mis otras sesiones. */
auth.post("/password", authenticate, async (c) => {
  const p = c.var.principal;
  if (p.kind !== "user") return c.json({ error: "not_a_user" }, 400);
  const parsed = z
    .object({ current: z.string().min(1).max(200), next: z.string().min(MIN_PASSWORD_LENGTH).max(200) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "validation", message: `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.` }, 400);
  const { current, next } = parsed.data;
  if (current === next) return c.json({ error: "validation", message: "La nueva contraseña debe ser distinta de la actual." }, 400);
  const db = getDb(c.env.DB);
  const user = await db.select().from(users).where(eq(users.id, p.user.id)).get();
  if (!user || !(await verifyPassword(current, user.passwordHash)).ok) {
    return c.json({ error: "invalid_credentials", message: "La contraseña actual no es correcta." }, 400);
  }
  const now = Date.now();
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(next), mustChangePassword: false, passwordChangedAt: now }).where(eq(users.id, user.id)),
    ...(user.tenantId ? [auditInsert(db, { tenantId: user.tenantId, actor: `user:${user.id}`, entity: "user", entityId: user.id, action: "password_changed" })] : []),
  ]);
  await revokeUserSessions(c, db, user.id, true);
  return c.body(null, 204);
});
