import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Consumo del mes: Ignia ve todas las desarrolladoras; el gerente solo la suya; el vendedor no tiene acceso.

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(USERS[who].email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS[who].password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test("consumo: Ignia ve todas las desarrolladoras, el gerente la suya y el vendedor no", async ({ page, browser }) => {
  await login(page, "admin");
  await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Consumo" }).click();
  await expect(page.getByText("Costo de IA")).toBeVisible();
  await expect(page.getByRole("region", { name: "Todas las desarrolladoras" }).getByRole("cell", { name: "Desarrolladora Demo" })).toBeVisible();

  const manager = await browser.newPage();
  await login(manager, "manager");
  await manager.goto("/consumo");
  await expect(manager.getByText("Costo de IA")).toBeVisible();
  await expect(manager.getByRole("region", { name: "Todas las desarrolladoras" })).toHaveCount(0);
  await manager.close();

  const seller = await browser.newPage();
  await login(seller, "seller");
  await expect(seller.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Consumo" })).toHaveCount(0);
  await seller.close();
});
