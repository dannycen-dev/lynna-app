import { createMiddleware } from "hono/factory";
import { log } from "./log";

const encoder = new TextEncoder();

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Autenticación provisional de la API de administración (hasta Better Auth en la Fase 4):
 * `Authorization: Bearer <ADMIN_API_TOKEN>`. Se comparan los hashes en tiempo constante.
 */
export const requireAdminToken = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const expected = c.env.ADMIN_API_TOKEN;
  const header = c.req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  // Un token corto o el placeholder nunca deben abrir la API.
  const configured = expected && expected.length >= 32 && expected !== "PENDIENTE";
  const ok =
    configured && provided.length > 0 && crypto.subtle.timingSafeEqual(await sha256(provided), await sha256(expected));

  if (!ok) {
    log("warn", "admin.auth_rejected", { path: c.req.path, configured: Boolean(configured) });
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});
