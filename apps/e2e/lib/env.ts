// Credenciales FIJAS solo para el servidor local que levanta Playwright (no son secretos reales).
export const LOCAL_SECRETS = {
  WHATSAPP_APP_SECRET: "e2e-app-secret",
  WHATSAPP_VERIFY_TOKEN: "e2e-verify-token",
  WHATSAPP_ACCESS_TOKEN: "e2e-access-token",
  ADMIN_API_TOKEN: "e2e-admin-token-0123456789abcdef0123456789",
} as const;

export const LOCAL_PORT = 8788;

/** Si está definida, las pruebas corren contra un entorno desplegado (solo @smoke). */
export const REMOTE_BASE_URL = process.env.E2E_BASE_URL;

/** Usuarios que crea scripts/start-local-api.sh en el servidor de pruebas (solo local/CI). */
export const USERS = {
  manager: { email: "gerente@demo.lynna.mx", password: "Gerente-E2E-2026", name: "Gerente E2E" },
  seller: { email: "vendedor@demo.lynna.mx", password: "Vendedor-E2E-2026", name: "Vendedor E2E" },
  admin: { email: "ops@igniastudio.mx", password: "Admin-E2E-2026!", name: "Ops Ignia" },
} as const;

export const adminHeaders = { authorization: `Bearer ${LOCAL_SECRETS.ADMIN_API_TOKEN}` };
