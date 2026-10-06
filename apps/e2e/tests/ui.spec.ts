import { expect, test, type Page } from "@playwright/test";
import { USERS } from "../lib/env";

// Pruebas de navegador del panel. Escriben datos: solo corren en local/CI (no son @smoke).
// SCREENSHOT_DIR=/ruta guarda capturas de cada pantalla para revisión visual.

async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Navegación principal" });

async function login(page: Page, who: keyof typeof USERS = "manager") {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Correo").fill(USERS[who].email);
  await page.getByLabel("Contraseña", { exact: true }).fill(USERS[who].password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();
}

test.describe("acceso", () => {
  test("sin sesión redirige al login y rechaza una contraseña incorrecta", async ({ page }) => {
    await page.goto("/cotizador");
    await expect(page).toHaveURL(/\/login$/);
    await shot(page, "01-login");
    await page.getByLabel("Correo").fill(USERS.manager.email);
    await page.getByLabel("Contraseña", { exact: true }).fill("incorrecta-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toContainText("Correo o contraseña incorrectos.");
    await expect(page.getByLabel("Contraseña", { exact: true })).toHaveValue("");
  });

  test("entrar, la sesión sobrevive a recargar, y salir la cierra", async ({ page, context }) => {
    await login(page);
    await expect(page.getByText(USERS.manager.name)).toBeVisible();
    await expect(page.getByText("Gerente", { exact: true })).toBeVisible();
    // La cookie es HttpOnly: el JavaScript de la página no puede leerla.
    const cookie = (await context.cookies()).find((c) => c.name === "lynna_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain("lynna_session");

    await page.reload();
    await expect(page.getByRole("heading", { name: "Bienvenido a Lynna" })).toBeVisible();

    await page.getByRole("button", { name: /Salir/ }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/inventario");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("vendedor: cotiza pero no ve acciones de administración", async ({ page }) => {
    await login(page, "seller");
    await expect(page.getByText("Vendedor", { exact: true })).toBeVisible();
    await sidebar(page).getByRole("link", { name: "Desarrollos y lotes" }).click();
    // Esperar a que cargue el contenido antes de afirmar ausencias (si no, pasan durante el "Cargando…").
    await expect(page.getByRole("button", { name: /Residencial Los Almendros/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Nuevo desarrollo" })).toHaveCount(0);
    await page.getByRole("button", { name: /Residencial Los Almendros/ }).click();
    await expect(page.getByText("Mz A · Lote 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Lotes" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Importar CSV" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cambiar estado" })).toHaveCount(0);
    await shot(page, "14-vendedor-inventario");

    await sidebar(page).getByRole("link", { name: "Cotizador" }).click();
    await page.getByRole("button", { name: /Residencial Los Almendros/ }).click();
    await page.getByRole("tab", { name: "Lista" }).click();
    await page.getByRole("cell", { name: "Mz A · Lote 1", exact: true }).click();
    await expect(page.getByText("Tabla de pagos")).toBeVisible();
  });

  test("admin de Ignia entra sin estar ligado a una desarrolladora", async ({ page }) => {
    await login(page, "admin");
    await expect(page.getByText("Ignia", { exact: true })).toBeVisible();
    // Con una sola desarrolladora se muestra su nombre; con varias, un selector.
    await expect(page.getByRole("banner").getByText("Desarrolladora Demo")).toBeVisible();
  });
});

test("inicio muestra KPIs y disponibilidad del inventario de demo", async ({ page }) => {
  await login(page);
  await expect(page.getByText("Lotes disponibles", { exact: true })).toBeVisible();
  await expect(page.getByText("Residencial Los Almendros")).toBeVisible();
  await shot(page, "02-inicio");
});

test("cotizador: plano por manzana → lote → plan → tabla de pagos", async ({ page }) => {
  await login(page);
  await sidebar(page).getByRole("link", { name: "Cotizador" }).click();
  await page.getByRole("button", { name: /Residencial Los Almendros/ }).click();
  await expect(page.getByText("Manzana A", { exact: true })).toBeVisible();
  await shot(page, "03-cotizador-plano");

  await page.getByRole("tab", { name: "Lista" }).click();
  await expect(page.getByRole("cell", { name: "Mz A · Lote 1", exact: true })).toBeVisible();
  await shot(page, "04-cotizador-lista");

  // Los lotes vendidos no aparecen con el filtro por omisión (Disponible).
  await expect(page.getByRole("cell", { name: "Mz A · Lote 7", exact: true })).toHaveCount(0);

  await page.getByRole("cell", { name: "Mz A · Lote 1", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Manzana A · Lote 1/ })).toBeVisible();
  await page.getByLabel("Plan", { exact: true }).selectOption({ label: "36 meses (12 % anual)" });
  await page.getByLabel("Fecha de cotización").fill("2026-10-06");
  await expect(page.getByText("Tabla de pagos")).toBeVisible();
  // apartado + enganche + total enganche (informativo) + 36 mensualidades
  await expect(page.locator("table tbody tr")).toHaveCount(39);
  await expect(page.getByText("Cotización informativa, sujeta a confirmación por un asesor", { exact: false })).toBeVisible();
  await shot(page, "05-cotizador-lote");

  await page.getByLabel("Plan", { exact: true }).selectOption({ label: "Preventa 30/50/20" });
  await expect(page.getByText("Contra entrega").first()).toBeVisible();
  await shot(page, "06-cotizador-preventa");
});

test("inventario: crear desarrollo, importar CSV con revisión previa y apartar un lote", async ({ page }) => {
  const name = `Bosque Alto ${Date.now()}`;
  await login(page);
  await sidebar(page).getByRole("link", { name: "Desarrollos y lotes" }).click();
  await page.getByRole("button", { name: "Nuevo desarrollo" }).click();
  await page.getByLabel("Nombre").fill(name);
  await page.getByLabel("Ciudad").fill("Mérida");
  await page.getByLabel("Amenidades").fill("Alberca, Casa club");
  await shot(page, "07-nuevo-desarrollo");
  await page.getByRole("button", { name: "Crear desarrollo" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("Este desarrollo aún no tiene lotes")).toBeVisible();

  await page.getByRole("tab", { name: "Importar CSV" }).click();
  const csv = page.getByLabel("o pega el contenido");

  await csv.fill("manzana,lote,superficie_m2,precio_m2\nA,1,200,3000\nA,2,cero,3000");
  await page.getByRole("button", { name: "Revisar sin guardar" }).click();
  await expect(page.getByText("1 error — no se guardó nada")).toBeVisible();
  await shot(page, "08-importar-errores");

  await csv.fill("Manzana,Lote,Superficie m2,Precio por m2,Estado\nA,1,200,3000,Disponible\nA,2,250,3000,Disponible\nB,1,300,2800,Vendido");
  await page.getByRole("button", { name: "Revisar sin guardar" }).click();
  await expect(page.getByText(/El archivo es válido.*3 nuevos/)).toBeVisible();
  await page.getByRole("button", { name: "Importar" }).click();
  await expect(page.getByText(/Importación completa/)).toBeVisible();

  await expect(page.getByRole("tab", { name: "Lotes" })).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
  await expect(page.getByText("Mz A · Lote 1", { exact: true })).toBeVisible();
  await shot(page, "09-lotes");

  const row = page.getByRole("row", { name: /Mz A · Lote 2/ });
  await row.getByRole("button", { name: "Cambiar estado" }).click();
  await page.getByLabel("Motivo").fill("Pago de apartado recibido");
  await shot(page, "10-apartar");
  await page.getByRole("button", { name: "Guardar cambio" }).click();
  await expect(row.getByText("Apartado")).toBeVisible();
});

test("planes: el formulario avisa si los porcentajes no suman 100 %", async ({ page }) => {
  await login(page);
  await sidebar(page).getByRole("link", { name: "Planes de pago" }).click();
  await expect(page.getByRole("heading", { name: "Preventa 30/50/20" })).toBeVisible();
  await shot(page, "11-planes");
  await page.getByRole("button", { name: "Nuevo plan" }).click();
  await page.getByLabel("Tipo de cálculo").selectOption("on_delivery");
  await page.getByLabel("Contra entrega %").fill("10");
  await expect(page.getByText(/deben sumar 100 %/)).toBeVisible();
});

test("agente de IA: conversar en el simulador, ver herramientas y escalamiento", async ({ page }) => {
  await login(page);
  await sidebar(page).getByRole("link", { name: "Agente de IA" }).click();
  await expect(page.getByRole("heading", { name: "Agente de IA" })).toBeVisible();

  await page.getByLabel("Mensaje").fill("¿Qué lotes tienen?");
  await page.getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByText("Tengo disponible Manzana C, lote 2 por $560,000 MXN.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Buscó lotes disponibles")).toBeVisible();
  await expect(page.getByText("Validada")).toBeVisible();

  await page.getByRole("button", { name: "Quiero comprar, ¿cómo lo aparto?" }).click();
  await expect(page.getByText("Quiere comprar → asesor")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".badge", { hasText: "Listo para comprar" })).toBeVisible();
  await shot(page, "15-agente-ia");

  await page.getByRole("button", { name: "Nueva conversación" }).click();
  await expect(page.getByText("Escribe como lo haría un prospecto")).toBeVisible();
});

test("CRM: aviso de compra → ficha → tomar la conversación → nota → etapa → tablero", async ({ page }) => {
  await login(page, "seller");

  await test.step("el prospecto dice que quiere comprar (simulador)", async () => {
    await sidebar(page).getByRole("link", { name: "Agente de IA" }).click();
    await page.getByLabel("Mensaje").fill("Quiero comprar, ¿cómo lo aparto?");
    await page.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Quiere comprar → asesor")).toBeVisible({ timeout: 15_000 });
  });

  await test.step("aparece el aviso y lleva a la ficha", async () => {
    await page.getByRole("button", { name: /Avisos: \d+ sin leer/ }).click({ timeout: 15_000 });
    await page.getByRole("button", { name: /Vendedor E2E quiere comprar/ }).first().click();
    await expect(page.getByRole("heading", { name: "Vendedor E2E" })).toBeVisible();
    await expect(page.getByText("Turnó a un asesor: Quiere comprar")).toBeVisible();
    await expect(page.getByText("Atiende la IA")).toBeVisible();
  });

  await test.step("el vendedor toma la conversación y responde", async () => {
    await page.getByRole("button", { name: "Tomar conversación" }).click();
    await expect(page.getByText("Atiende tú")).toBeVisible();
    await page.getByLabel("Respuesta del asesor").fill("Hola, soy tu asesor. ¿Te llamo en 10 minutos?");
    await page.getByRole("button", { name: "Enviar respuesta" }).click();
    await expect(page.getByText("Hola, soy tu asesor. ¿Te llamo en 10 minutos?")).toBeVisible();
    await expect(page.getByText(/Asesor · .* · simulado/)).toBeVisible();
  });

  await test.step("nota y cambio de etapa", async () => {
    await page.getByLabel("Nueva nota").fill("Quiere visitar el sábado.");
    await page.getByRole("button", { name: "Guardar nota" }).click();
    await expect(page.getByText("Quiere visitar el sábado.")).toBeVisible();
    await page.getByRole("combobox", { name: "Etapa" }).selectOption("negotiation");
    await expect(page.getByText(/Cambió la etapa: Listo para comprar → Negociación/)).toBeVisible();
    await shot(page, "16-ficha-prospecto");
  });

  await test.step("tablero: la tarjeta está en Negociación y se puede arrastrar", async () => {
    await sidebar(page).getByRole("link", { name: "Prospectos" }).click();
    const negotiation = page.getByRole("region", { name: "Negociación" });
    const card = negotiation.getByRole("article", { name: /Vendedor E2E/ });
    await expect(card).toBeVisible();
    await shot(page, "17-tablero");
    await card.dragTo(page.getByRole("region", { name: "Cita agendada" }));
    await expect(page.getByRole("region", { name: "Cita agendada" }).getByRole("article", { name: /Vendedor E2E/ })).toBeVisible();
  });
});

test("móvil: el menú lateral se abre como cajón", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await shot(page, "12-movil-inicio");
  await page.getByRole("button", { name: "Abrir menú" }).click();
  await expect(sidebar(page).getByRole("link", { name: "Cotizador" })).toBeVisible();
  await shot(page, "13-movil-menu");
});
