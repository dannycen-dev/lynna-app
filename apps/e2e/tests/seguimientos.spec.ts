import { expect, test } from "@playwright/test";
import { USERS } from "../lib/env";

// Seguimientos automáticos: configurar la secuencia. Restaura al final (pruebas en paralelo). Solo local/CI.

test("seguimientos: activar, editar un paso y que persista", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Correo").fill(USERS.manager.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS.manager.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
  await page.goto("/ajustes");

  const card = page.locator(".card", { has: page.getByText("Seguimientos automáticos", { exact: true }) });
  const toggle = card.getByLabel("Escribir a los prospectos que dejan de responder");
  await expect(card.getByRole("region", { name: "Seguimiento 1" })).toBeVisible();
  await toggle.check();
  await card.getByLabel("Espera del seguimiento 1").selectOption({ label: "2 días" });
  await card.getByLabel("Texto del seguimiento 1").fill("Hola {nombre}, ¿seguimos en contacto sobre {desarrollo}?");
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(card.getByText("Guardado")).toBeVisible();

  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(card.getByLabel("Espera del seguimiento 1")).toHaveValue("48");
  await expect(card.getByLabel("Texto del seguimiento 1")).toHaveValue("Hola {nombre}, ¿seguimos en contacto sobre {desarrollo}?");

  // Restaurar.
  await toggle.uncheck();
  await card.getByRole("button", { name: "Guardar" }).click();
  await expect(card.getByText("Guardado")).toBeVisible();
});
