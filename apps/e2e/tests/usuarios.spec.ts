import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Usuarios desde el panel: alta con contraseña temporal → cambio obligatorio al entrar → desactivar.
// Solo local/CI.

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel("Contraseña", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("usuarios: alta, contraseña temporal obligatoria y desactivar", async ({ page, browser }) => {
  await login(page, USERS.manager.email, USERS.manager.password);
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
  await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Usuarios" }).click();
  await expect(page.getByRole("heading", { name: "Usuarios" })).toBeVisible();

  // El gerente da de alta a una vendedora (solo puede crear vendedores).
  const email = `vendedora.${Date.now()}@demo.lynna.mx`;
  await page.getByRole("button", { name: "Nuevo usuario" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo usuario" });
  await dialog.getByLabel("Nombre").fill("Vendedora Nueva");
  await dialog.getByLabel("Correo").fill(email);
  await expect(dialog.getByLabel("Rol").locator("option")).toHaveText(["Vendedor"]);
  await dialog.getByRole("button", { name: "Dar de alta" }).click();
  const temp = (await page.getByLabel("Contraseña temporal generada").textContent())!.trim();
  expect(temp).toHaveLength(14);
  await page.getByRole("button", { name: "Listo, ya la guardé" }).click();
  const row = page.getByRole("row", { name: "Vendedora Nueva" });
  await expect(row.getByText("Con contraseña temporal")).toBeVisible();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/26-usuarios.png`, fullPage: true });

  // Ella entra con la temporal: primero tiene que cambiarla.
  const her = await browser.newPage();
  await login(her, email, temp);
  await expect(her.getByRole("heading", { name: "Cambia tu contraseña temporal" })).toBeVisible();
  await her.getByLabel("Contraseña actual").fill(temp);
  await her.getByLabel("Nueva contraseña", { exact: true }).fill("Mi-Contraseña-2026");
  await her.getByLabel("Repite la nueva contraseña").fill("Mi-Contraseña-2026");
  await her.getByRole("button", { name: "Cambiar contraseña" }).click();
  await expect(her.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
  // Como vendedora no ve "Usuarios".
  await expect(her.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Usuarios" })).toHaveCount(0);

  // El gerente la desactiva: su sesión deja de servir.
  await page.reload();
  await row.getByRole("button", { name: "Desactivar" }).click();
  await expect(row.getByText("Inactivo")).toBeVisible();
  await her.goto("/prospectos");
  await expect(her).toHaveURL(/\/login$/);
  await login(her, email, "Mi-Contraseña-2026");
  await expect(her.getByRole("alert")).toContainText("Correo o contraseña incorrectos.");
  await her.close();
});
