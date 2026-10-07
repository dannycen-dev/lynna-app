import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminHeaders, USERS } from "../lib/env";
import { inboundText, randomMxPhone, signMeta } from "../lib/meta";

// Privacidad (LFPDPPP): aviso en el primer mensaje, consentimiento para datos financieros, y derechos ARCO
// (exportar y eliminar) desde la ficha. Usa un prospecto real por webhook. Escribe datos: solo local/CI.

async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navegación principal" });

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Correo").fill(USERS.manager.email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS.manager.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

async function whatsapp(request: APIRequestContext, phone: string, text: string, name: string) {
  const { body } = inboundText(phone, text, undefined, name);
  const res = await request.post("/whatsapp/webhook", { headers: { "content-type": "application/json", "x-hub-signature-256": signMeta(body) }, data: body });
  expect(res.status()).toBe(200);
}

/** Espera (cola + debounce) a que el prospecto exista y cumpla la condición. */
async function prospectWhen(request: APIRequestContext, phone: string, ready: (p: Record<string, unknown>) => boolean) {
  let found: Record<string, unknown> | undefined;
  await expect(async () => {
    const list = (await (await request.get("/api/admin/tenants/demo/prospects", { headers: adminHeaders })).json()) as { id: string; phone: string }[];
    const row = list.find((p) => p.phone === phone);
    expect(row).toBeTruthy();
    const detail = (await (await request.get(`/api/admin/tenants/demo/prospects/${row!.id}`, { headers: adminHeaders })).json()) as { prospect: Record<string, unknown> };
    expect(ready(detail.prospect)).toBe(true);
    found = detail.prospect;
  }).toPass({ timeout: 20_000 });
  return found!;
}

test("privacidad: aviso, consentimiento para datos financieros y ARCO desde la ficha", async ({ page, request }) => {
  await login(page);

  // La desarrolladora configura su aviso.
  await sidebar(page).getByRole("link", { name: "Configuración" }).click();
  await page.getByLabel("Enlace al aviso de privacidad").fill("https://demo.lynna.mx/aviso-de-privacidad");
  await expect(page.getByLabel("Vista previa del aviso")).toContainText("conforme a su aviso de privacidad: https://demo.lynna.mx/aviso-de-privacidad");
  await page.getByRole("button", { name: "Guardar" }).last().click();
  await expect(page.getByText("Guardado").last()).toBeVisible();

  // Un prospecto escribe por WhatsApp y comparte su presupuesto: aviso + pregunta de autorización.
  const phone = randomMxPhone();
  const name = `Privacidad ${phone.slice(-4)}`;
  await whatsapp(request, phone, "Hola, busco terreno y tengo 700 mil de presupuesto", name);
  const asked = await prospectWhen(request, phone, (p) => Boolean(p.privacyNoticeAt && p.consentRequestedAt));
  expect(asked.consentAt).toBeNull();

  // Responde que sí: queda el consentimiento con su respuesta como evidencia.
  await whatsapp(request, phone, "Sí, acepto", name);
  const consented = await prospectWhen(request, phone, (p) => Boolean(p.consentAt));
  expect(consented.consentText).toBe("Sí, acepto");

  // En la ficha: el aviso se envió una vez, la autorización y los botones ARCO.
  await page.goto(`/prospectos/${consented.id}`);
  const privacy = page.locator(".card", { has: page.getByText("Privacidad", { exact: true }) });
  await expect(privacy.getByText(/^Enviado /)).toBeVisible();
  await expect(privacy.getByText("Autorizó", { exact: true })).toBeVisible();
  await expect(privacy.getByText(/respondió "Sí, acepto"/)).toBeVisible();
  const messages = page.getByRole("region", { name: "Conversación" });
  await expect(messages.getByText(/¿me autorizas a guardar esos datos financieros/)).toHaveCount(1);
  await expect(messages.getByText(/aviso de privacidad: https:\/\/demo\.lynna\.mx\/aviso-de-privacidad/)).toHaveCount(1);
  await expect(page.getByText("Autorizó guardar sus datos financieros")).toBeVisible();
  await shot(page, "24-privacidad-ficha");

  // ARCO: exportar descarga el expediente; eliminar borra todo y regresa a la lista.
  const download = page.waitForEvent("download");
  await privacy.getByRole("link", { name: "Exportar datos (ARCO)" }).click();
  expect((await download).suggestedFilename()).toBe(`prospecto-${consented.id}.json`);

  await privacy.getByRole("button", { name: "Eliminar datos (ARCO)" }).click();
  const dialog = page.getByRole("dialog", { name: "Eliminar todos los datos del prospecto" });
  await expect(dialog.getByRole("button", { name: "Eliminar definitivamente" })).toBeDisabled();
  await dialog.getByLabel("Motivo").fill("Solicitud de cancelación del titular (prueba E2E)");
  await dialog.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await expect(page).toHaveURL(/\/prospectos$/);
  const after = await request.get(`/api/admin/tenants/demo/prospects/${consented.id}`, { headers: adminHeaders });
  expect(after.status()).toBe(404);
});
