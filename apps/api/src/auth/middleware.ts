import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { log } from "../lib/log";
import { readSession, type SessionUser } from "./session";

// Quién hace la petición:
// - user: persona con sesión (cookie). Es lo que usa la interfaz.
// - token: automatización (scripts, pruebas) con `Authorization: Bearer <ADMIN_API_TOKEN>`.
export type Principal = { kind: "user"; user: SessionUser } | { kind: "token" };
export type AuthVariables = { principal: Principal };

const encoder = new TextEncoder();
const sha256 = (v: string) => crypto.subtle.digest("SHA-256", encoder.encode(v));

async function isValidAdminToken(header: string | undefined, expected: string | undefined): Promise<boolean> {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = header.slice("Bearer ".length);
  // Un token corto o el placeholder nunca deben abrir la API.
  if (!expected || expected.length < 32 || expected === "PENDIENTE" || provided.length === 0) return false;
  return crypto.subtle.timingSafeEqual(await sha256(provided), await sha256(expected));
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Exige sesión o token; con sesión, además valida Origin en métodos que modifican (CSRF). */
export const authenticate = createMiddleware<{ Bindings: Env; Variables: AuthVariables }>(async (c, next) => {
  const authHeader = c.req.header("authorization");
  if (authHeader) {
    if (await isValidAdminToken(authHeader, c.env.ADMIN_API_TOKEN)) {
      c.set("principal", { kind: "token" });
      return next();
    }
    log("warn", "auth.bad_token", { path: c.req.path });
    return c.json({ error: "unauthorized", message: "No autorizado." }, 401);
  }

  const user = await readSession(c, getDb(c.env.DB));
  if (!user) return c.json({ error: "unauthorized", message: "Inicia sesión para continuar." }, 401);

  if (UNSAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      log("warn", "auth.csrf_rejected", { path: c.req.path, origin: origin ?? null });
      return c.json({ error: "forbidden", message: "Origen no permitido." }, 403);
    }
  }
  c.set("principal", { kind: "user", user });
  return next();
});

export function canAccessTenant(p: Principal, tenantId: string): boolean {
  return p.kind === "token" || p.user.role === "admin" || p.user.tenantId === tenantId;
}

/** owner, manager y admin administran inventario y planes; seller consulta y cotiza. */
export function canWrite(p: Principal): boolean {
  return p.kind === "token" || p.user.role !== "seller";
}

/** Identificador del actor para audit_log. */
export function actorOf(p: Principal): string {
  return p.kind === "token" ? "admin-token" : `user:${p.user.id}`;
}
