import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";
import { inboundText, randomMxPhone, signMeta } from "../lib/meta";

// Filtros del CRM (en el servidor y en la URL), exportar CSV y métricas. Solo local/CI.

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS[who].email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS[who].password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test("CRM: buscar y filtrar (en la URL), exportar CSV y ver métricas", async ({ page, request }) => {
  // Un prospecto con nombre único entra por WhatsApp.
  const phone = randomMxPhone();
  const name = `Filtro ${phone.slice(-5)}`;
  const { body } = inboundText(phone, "Hola, me interesan sus terrenos", undefined, name);
  expect((await request.post("/whatsapp/webhook", { headers: { "content-type": "application/json", "x-hub-signature-256": signMeta(body) }, data: body })).status()).toBe(200);

  await login(page, "manager");
  await page.goto("/prospectos");
  const board = page.getByLabel("Tablero de prospectos");
  await expect(async () => {
    await page.getByLabel("Buscar prospecto").fill(name);
    await expect(board.getByRole("article")).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(board.getByRole("article", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText("1 prospecto", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(name).replace(/%20/g, "\\+|%20")}`));

  // Filtro que lo excluye: "Listo para comprar".
  await page.getByLabel("Filtrar por calificación").selectOption({ label: "Listo para comprar" });
  await expect(page.getByText("Ningún prospecto con estos filtros")).toBeVisible();
  await page.getByLabel("Filtrar por calificación").selectOption({ label: "Frío" });
  await expect(board.getByRole("article", { name: new RegExp(name) })).toBeVisible();

  // Los filtros sobreviven a abrir la ficha y regresar.
  await board.getByRole("article", { name: new RegExp(name) }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Buscar prospecto")).toHaveValue(name);
  await expect(page.getByLabel("Filtrar por calificación")).toHaveValue("frio");

  // CSV con los mismos filtros.
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Exportar CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^prospectos-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv.split("\r\n").filter(Boolean)).toHaveLength(2);
  expect(csv).toContain(name);

  await page.getByRole("button", { name: "Limpiar" }).click();
  await expect(page.getByLabel("Buscar prospecto")).toHaveValue("");

  // Métricas.
  await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Métricas" }).click();
  await expect(page.getByRole("heading", { name: "Métricas" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Embudo de conversión" }).getByText("Nuevo", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "7 días" }).click();
  await expect(page.getByRole("tab", { name: "7 días" })).toHaveAttribute("aria-selected", "true");
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/25-metricas.png`, fullPage: true });

  // El vendedor no ve "Exportar CSV".
  const seller = await page.context().browser()!.newPage();
  await login(seller, "seller");
  await seller.goto("/prospectos");
  await expect(seller.getByLabel("Buscar prospecto")).toBeVisible();
  await expect(seller.getByRole("link", { name: "Exportar CSV" })).toHaveCount(0);
  await seller.close();
});
