import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Base de conocimiento: el gerente escribe un texto, lo prueba como la IA (borrador = invisible para la IA),
// lo aprueba y el vendedor lo ve sin poder editar. Escribe datos: solo local/CI.

async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navegación principal" });

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS[who].email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS[who].password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test("base de conocimiento: escribir, probar como la IA, aprobar; el vendedor solo consulta", async ({ page, browser }) => {
  await login(page, "manager");
  await sidebar(page).getByRole("link", { name: "Base de conocimiento" }).click();
  await expect(page.getByRole("heading", { name: "Base de conocimiento" })).toBeVisible();

  // Un texto nuevo, todavía en borrador.
  const title = `¿Hay transporte público cerca? ${Date.now()}`;
  await page.getByRole("button", { name: "Nuevo texto" }).click();
  const dialog = page.getByRole("dialog", { name: "Nuevo texto" });
  await dialog.getByLabel("Pregunta o tema").fill(title);
  await dialog.getByLabel("Categoría").selectOption({ label: "Desarrollo y servicios" });
  await dialog.getByLabel("Respuesta aprobada").fill("Hay paradas de camión sobre la avenida principal, a cinco minutos caminando del acceso.");
  await dialog.getByLabel("Palabras clave").fill("camión, transporte, autobús, parada");
  await dialog.getByRole("button", { name: "Guardar" }).click();
  await expect(dialog).toBeHidden();
  const card = page.getByRole("article", { name: title });
  await expect(card.getByText("Borrador · la IA no lo usa")).toBeVisible();

  // Mientras sea borrador, la IA no lo encontraría.
  await page.getByLabel("Pregunta de prueba").fill("¿pasa el camión cerca?");
  await expect(page.getByText("La IA no encontraría nada aprobado")).toBeVisible();

  // Aprobado: ahora sí.
  await card.getByRole("button", { name: `Editar ${title}` }).click();
  const edit = page.getByRole("dialog", { name: "Editar texto" });
  await edit.getByLabel("Aprobado: la IA puede usar este texto").check();
  await edit.getByRole("button", { name: "Guardar" }).click();
  await expect(edit).toBeHidden();
  await expect(card.getByText("Aprobado", { exact: true })).toBeVisible();
  await expect(card.getByText(/Aprobó Gerente E2E/)).toBeVisible();
  await expect(page.getByRole("list", { name: "Resultados de la prueba" }).getByText(title)).toBeVisible();
  await shot(page, "23-base-conocimiento");

  // El vendedor lo ve, pero no puede crear ni editar.
  const seller = await browser.newPage();
  await login(seller, "seller");
  await sidebar(seller).getByRole("link", { name: "Base de conocimiento" }).click();
  await expect(seller.getByRole("article", { name: title })).toBeVisible();
  await expect(seller.getByRole("button", { name: "Nuevo texto" })).toHaveCount(0);
  await expect(seller.getByRole("button", { name: `Editar ${title}` })).toHaveCount(0);
  await seller.close();
});
