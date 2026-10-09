import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Agenda de citas: horario del vendedor → la IA ofrece horarios y agenda → aparece en Citas y en la
// ficha → se reagenda desde el panel. Escribe datos: solo local/CI (no es @smoke).

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

test("agenda: horario del vendedor → la IA agenda → Citas → ficha → reagendar", async ({ page, browser }) => {
  // El vendedor define su horario (todos los días, 9:00 a 18:00).
  await login(page, "seller");
  await sidebar(page).getByRole("link", { name: "Configuración" }).click();
  const schedule = page.getByRole("region", { name: `Horario de ${USERS.seller.name}` });
  for (const day of ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]) {
    await schedule.getByLabel(`${USERS.seller.name} atiende el ${day}`).check();
  }
  await schedule.getByRole("button", { name: "Guardar horario" }).click();
  await expect(schedule.getByText("Guardado")).toBeVisible();
  await shot(page, "20-horarios");

  // Un prospecto sin vendedor (simulador del admin) pide una visita: la IA ofrece horarios reales.
  const admin = await browser.newPage();
  await login(admin, "admin");
  await sidebar(admin).getByRole("link", { name: "Agente de IA" }).click();
  await admin.getByLabel("Mensaje").fill("Quiero agendar una visita");
  await admin.getByRole("button", { name: "Enviar", exact: true }).click();
  const offer = admin.getByText(/Tengo estos horarios para visitar el desarrollo/).last();
  await expect(offer).toBeVisible({ timeout: 15_000 });
  const [, date, time] = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\)/.exec((await offer.textContent()) ?? "") ?? [];
  expect(date && time).toBeTruthy();

  await admin.getByLabel("Mensaje").fill(`Agenda la visita el ${date} a las ${time}`);
  await admin.getByRole("button", { name: "Enviar", exact: true }).click();
  await expect(admin.getByText(/Tu visita quedó agendada/).last()).toBeVisible({ timeout: 15_000 });
  await expect(admin.getByText("Validada").last()).toBeVisible();

  // Aparece en Citas (la agendó la IA y se asignó al vendedor libre).
  await sidebar(admin).getByRole("link", { name: "Citas" }).click();
  const row = admin.getByRole("row", { name: new RegExp(USERS.admin.name) });
  await expect(row).toContainText(time!);
  await expect(row).toContainText("la agendó la IA");
  await expect(row).toContainText(USERS.seller.name);
  await expect(row.getByText("Agendada")).toBeVisible();
  await shot(admin, "21-citas");

  // Ficha: la cita está ahí y se reagenda al día siguiente desde el panel.
  await row.getByRole("link", { name: USERS.admin.name }).click();
  await expect(admin.getByRole("heading", { name: USERS.admin.name })).toBeVisible();
  await expect(admin.locator(".badge", { hasText: "Cita agendada" }).or(admin.getByRole("combobox", { name: "Etapa" }))).toBeVisible();
  await admin.getByRole("button", { name: "Reagendar" }).click();
  const dialog = admin.getByRole("dialog", { name: "Reagendar la cita" });
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  await dialog.getByLabel("Día").fill(next.toISOString().slice(0, 10));
  const firstSlot = dialog.getByRole("list", { name: "Horarios libres" }).getByRole("listitem").first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();
  await expect(dialog).toBeHidden();
  await expect(admin.getByText("Cancelada")).toBeVisible();
  await expect(admin.getByText("Agendada", { exact: true })).toBeVisible();
  await expect(admin.getByText(/Reagendó la cita/)).toBeVisible();
  await shot(admin, "22-ficha-citas");
  await admin.close();

  // El vendedor la ve en su agenda (es su cita).
  await sidebar(page).getByRole("link", { name: "Citas" }).click();
  await page.getByRole("button", { name: "Semana siguiente" }).click();
  await page.getByRole("button", { name: "Hoy" }).click();
  await expect(page.getByRole("row", { name: new RegExp(USERS.admin.name) })).toBeVisible();
});
