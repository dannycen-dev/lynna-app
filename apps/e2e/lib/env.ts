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

export const adminHeaders = { authorization: `Bearer ${LOCAL_SECRETS.ADMIN_API_TOKEN}` };
