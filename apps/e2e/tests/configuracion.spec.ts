import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Asistente y horario de atención: el nombre de la IA y lo que promete fuera de horario. Restaura los valores
// al final (otras pruebas corren en paralelo contra la misma desarrolladora). Solo local/CI.

const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS.manager.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS.manager.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test("configuración: nombre del asistente y horario de atención (qué promete fuera de horario)", async ({ page }) => {
  await login(page);
  await page.goto("/ajustes");
  const card = page.locator(".card", { has: page.getByText("Asistente y horario de atención") });
  const preview = card.getByLabel("Qué promete la IA ahora");
  await expect(preview).toContainText('"Un asesor te contactará en breve."');

  // Oficina abierta solo dentro de 3 días: ahora está cerrada sin importar cuándo corra la prueba.
  const inThreeDays = new Date(Date.now() + 3 * 86_400_000);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", weekday: "short" }).format(inThreeDays);
  const day = DAYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)]!;
  await card.getByLabel("Nombre del asistente").fill("Sofía");
  await card.getByLabel(`Oficina abierta el ${day}`).check();
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(card.getByText("Guardado")).toBeVisible();
  await expect(preview).toContainText(/"Un asesor te contactará el \p{L}+ \d{1,2} de \p{L}+ a partir de las 9:00\."/u);

  // El simulador ya se presenta con el nuevo nombre.
  await page.goto("/agente");
  await expect(page.getByRole("region", { name: "Conversación" }).getByText("Sofía", { exact: true })).toBeVisible();

  // Restaurar.
  await page.goto("/ajustes");
  await card.getByLabel("Nombre del asistente").fill("Lynna");
  await card.getByLabel(`Oficina abierta el ${day}`).uncheck();
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(preview).toContainText('"Un asesor te contactará en breve."');
});
