import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { adminHeaders, USERS } from "../lib/env";

// Material por WhatsApp (simulador): carrusel de lotes con foto y fotos del desarrollo a pedido.
// Con el modelo de prueba: "lotes" → buscar_lotes (+ carrusel); "fotos" → enviar_material.

const TENANT = "/api/admin/tenants/demo";
const PHOTO = readFileSync(path.join(import.meta.dirname, "..", "fixtures", "foto.jpg"));

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS.manager.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS.manager.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test("simulador: carrusel de lotes con foto y envío de fotos del desarrollo", async ({ page, request }) => {
  const up = await request.post(`${TENANT}/developments/los-almendros/media?kind=photo&caption=${encodeURIComponent("Casa club con alberca")}`, {
    headers: { ...adminHeaders, "content-type": "image/jpeg" },
    data: PHOTO,
  });
  expect(up.status()).toBe(201);
  const media = (await up.json()) as { id: string };

  try {
    await login(page);
    await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Agente de IA" }).click();

    await page.getByLabel("Mensaje").fill("¿Qué lotes tienen disponibles?");
    await page.getByRole("button", { name: "Enviar" }).click();
    const carousel = page.locator(".bubble__carousel");
    await expect(carousel).toBeVisible({ timeout: 15_000 });
    await expect(carousel).toContainText("Desliza para ver los lotes");
    await expect(carousel.locator("li").first()).toContainText(/Manzana [A-D], lote \d+/);
    await expect(carousel.locator("img")).toHaveAttribute("src", `/media/${media.id}`);

    await page.getByLabel("Mensaje").fill("Mándame fotos del desarrollo");
    await page.getByRole("button", { name: "Enviar" }).click();
    const photo = page.getByRole("img", { name: "Casa club con alberca" });
    await expect(photo).toBeVisible({ timeout: 15_000 });
    expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await request.delete(`${TENANT}/media/${media.id}`, { headers: adminHeaders });
  }
});
