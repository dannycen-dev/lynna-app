import { and, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "../db/client";
import { sessions, users, type UserRole } from "../db/schema";

export const SESSION_COOKIE = "lynna_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Si a la sesión le queda menos de esto, se renueva (sesión deslizante).
const RENEW_THRESHOLD_MS = 6 * 24 * 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  tenantId: string | null;
  email: string;
  name: string;
  role: UserRole;
};

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieOptions(c: Context, maxAgeMs: number) {
  // En https siempre Secure; en http://localhost (desarrollo) el navegador no lo permitiría.
  const secure = new URL(c.req.url).protocol === "https:";
  return { httpOnly: true, secure, sameSite: "Lax" as const, path: "/", maxAge: Math.floor(maxAgeMs / 1000) };
}

export async function createSession(c: Context, db: Db, userId: string): Promise<void> {
  const token = newToken();
  const now = Date.now();
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
  });
  setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_MS));
}

/** Usuario de la cookie, o null. Renueva la sesión si está por vencer. */
export async function readSession(c: Context, db: Db): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const sessionId = await sha256Hex(token);
  const now = Date.now();

  const row = await db
    .select({
      expiresAt: sessions.expiresAt,
      user: { id: users.id, tenantId: users.tenantId, email: users.email, name: users.name, role: users.role, active: users.active },
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
    .get();
  if (!row || !row.user.active) return null;

  if (row.expiresAt - now < RENEW_THRESHOLD_MS) {
    await db.update(sessions).set({ expiresAt: now + SESSION_TTL_MS }).where(eq(sessions.id, sessionId));
    setCookie(c, SESSION_COOKIE, token, cookieOptions(c, SESSION_TTL_MS));
  }
  const { active: _active, ...user } = row.user;
  return user;
}

export async function destroySession(c: Context, db: Db): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Cron: borra sesiones vencidas. */
export async function purgeExpiredSessions(db: Db, now = Date.now()): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
