import { expect, test } from "@playwright/test";

// @smoke: solo lectura. Corre después de cada deploy contra la URL del entorno.
test.describe("smoke @smoke", () => {
  test("health responde con el entorno esperado", async ({ request }) => {
    const res = await request.get("/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    if (process.env.E2E_EXPECT_ENV) expect(body.env).toBe(process.env.E2E_EXPECT_ENV);
  });

  test("el webhook rechaza un verify token incorrecto", async ({ request }) => {
    const res = await request.get("/whatsapp/webhook", {
      params: { "hub.mode": "subscribe", "hub.verify_token": "token-falso", "hub.challenge": "x" },
    });
    expect(res.status()).toBe(403);
  });

  test("el webhook rechaza eventos sin firma de Meta", async ({ request }) => {
    const res = await request.post("/whatsapp/webhook", { data: { object: "whatsapp_business_account", entry: [] } });
    expect(res.status()).toBe(403);
  });

  test("la API de administración exige token", async ({ request }) => {
    expect((await request.get("/api/admin/tenants/demo/developments")).status()).toBe(401);
    const forged = await request.get("/api/admin/tenants/demo/developments", { headers: { authorization: "Bearer falso" } });
    expect(forged.status()).toBe(401);
  });

  test("la interfaz carga y pide iniciar sesión", async ({ page }) => {
    await page.goto("/cotizador");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Lynna" })).toBeVisible();
    await expect(page.getByLabel("Clave de acceso")).toBeVisible();
  });

  test("encabezados de seguridad en la interfaz", async ({ request }) => {
    const res = await request.get("/");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
    expect(res.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  test("las rutas de desarrollo local no existen", async ({ request }) => {
    expect((await request.get("/api/dev/tenants/demo/developments")).status()).toBe(404);
  });
});
