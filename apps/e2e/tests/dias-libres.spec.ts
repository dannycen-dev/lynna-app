import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Varios horarios por día (hora de comida) y días libres: vacaciones de un vendedor y cierre de oficina,
// que cambia lo que la IA promete al turnar. Escribe datos: solo local/CI (no es @smoke).

const DAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

async function login(page: Page, who: keyof typeof USERS) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS[who].email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS[who].password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

/** Fecha local de México dentro de `days` días, "AAAA-MM-DD", y su día de la semana. */
function mxDate(days: number) {
  const d = new Date(Date.now() + days * 86_400_000);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(d);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/Mexico_City", weekday: "short" }).format(d);
  return { iso, day: DAYS[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday)]! };
}

test("horario con hora de comida; vacaciones del vendedor", async ({ page }) => {
  await login(page, "seller");
  await page.goto("/ajustes");
  const schedule = page.getByRole("region", { name: `Horario de ${USERS.seller.name}` });
  await schedule.getByLabel(`${USERS.seller.name} atiende el Lunes`).check();
  await schedule.getByLabel("Lunes, desde", { exact: true }).fill("09:00");
  await schedule.getByLabel("Lunes, hasta", { exact: true }).fill("14:00");
  await schedule.getByRole("button", { name: "Agregar otro horario el Lunes" }).click();
  // Empalme: se avisa y no deja guardar.
  await schedule.getByLabel("Lunes, desde (tramo 2)").fill("13:00");
  await schedule.getByLabel("Lunes, hasta (tramo 2)").fill("19:00");
  await expect(schedule.getByText("Hay horarios que se empalman en el mismo día.")).toBeVisible();
  await expect(schedule.getByRole("button", { name: "Guardar horario" })).toBeDisabled();
  await schedule.getByLabel("Lunes, desde (tramo 2)").fill("16:00");
  await schedule.getByRole("button", { name: "Guardar horario" }).click();
  await expect(schedule.getByText("Guardado")).toBeVisible();
  await page.reload();
  await expect(schedule.getByLabel("Lunes, desde (tramo 2)")).toHaveValue("16:00");

  // Vacaciones: el vendedor solo puede registrar las suyas.
  const card = page.locator(".card", { has: page.getByText("Días libres y días festivos") });
  await expect(card.getByLabel("Quién")).toBeDisabled();
  await expect(card.getByLabel("Quién")).toHaveValue(/.+/);
  const start = mxDate(30);
  const end = mxDate(34);
  await card.getByLabel("Desde").fill(start.iso);
  await card.getByLabel("Hasta").fill(end.iso);
  await card.getByLabel("Motivo (opcional)").fill("Vacaciones E2E");
  await card.getByRole("button", { name: "Agregar" }).click();
  const list = card.getByRole("list", { name: "Próximos días libres" });
  const item = list.getByRole("listitem").filter({ hasText: "Vacaciones E2E" });
  await expect(item).toContainText(USERS.seller.name);
  await item.getByRole("button", { name: /^Quitar / }).click();
  await expect(item).toHaveCount(0);

  // Restaurar: un solo tramo.
  await schedule.getByRole("button", { name: "Quitar tramo 2 del Lunes" }).click();
  await schedule.getByLabel("Lunes, hasta", { exact: true }).fill("18:00");
  await schedule.getByRole("button", { name: "Guardar horario" }).click();
  await expect(schedule.getByLabel("Lunes, desde (tramo 2)")).toHaveCount(0);
});

test("cierre de oficina: la IA promete el contacto para el siguiente día que sí abre", async ({ page }) => {
  await login(page, "manager");
  await page.goto("/ajustes");
  const agent = page.locator(".card", { has: page.getByText("Asistente y horario de atención") });
  const preview = agent.getByLabel("Qué promete la IA ahora");
  // Oficina abierta solo un día de la semana, dentro de 3 días.
  const open = mxDate(3);
  await agent.getByLabel(`Oficina abierta el ${open.day}`).check();
  await agent.getByRole("button", { name: "Guardar" }).click();
  const day = Number(open.iso.slice(8));
  await expect(preview).toContainText(new RegExp(`el \\p{L}+ ${day} de`, "u"));

  // Ese día es festivo: la promesa pasa a la semana siguiente.
  const card = page.locator(".card", { has: page.getByText("Días libres y días festivos") });
  await card.getByLabel("Quién").selectOption({ label: "Toda la oficina" });
  await card.getByLabel("Desde").fill(open.iso);
  await card.getByLabel("Hasta").fill(open.iso);
  await card.getByLabel("Motivo (opcional)").fill("Festivo E2E");
  await card.getByRole("button", { name: "Agregar" }).click();
  const item = card.getByRole("listitem").filter({ hasText: "Festivo E2E" });
  await expect(item).toContainText("Toda la oficina");
  const nextWeek = Number(mxDate(10).iso.slice(8));
  await expect(preview).toContainText(new RegExp(`el \\p{L}+ ${nextWeek} de`, "u"));

  // Restaurar.
  await item.getByRole("button", { name: /^Quitar / }).click();
  await expect(item).toHaveCount(0);
  await agent.getByLabel(`Oficina abierta el ${open.day}`).uncheck();
  await agent.getByRole("button", { name: "Guardar" }).click();
  await expect(preview).toContainText('"Un asesor te contactará en breve."');
});
