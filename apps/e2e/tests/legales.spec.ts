import { expect, test } from "@playwright/test";

// @smoke: páginas legales públicas que Meta pide para publicar la app (privacidad, términos, eliminación de datos).
// Son HTML estático: el rastreador de Meta las lee sin JavaScript y sin sesión.
const PAGES = [
  { path: "/privacidad", heading: "Aviso de privacidad" },
  { path: "/terminos", heading: "Términos del servicio" },
  { path: "/eliminacion-de-datos", heading: "Cómo eliminar tus datos" },
];

test.describe("páginas legales @smoke", () => {
  for (const { path, heading } of PAGES) {
    test(`${path} responde HTML estático sin sesión`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<h1>${heading}</h1>`);
      expect(html).not.toContain('id="root"');
    });
  }

  test("se navega entre las páginas desde el pie", async ({ page }) => {
    await page.goto("/privacidad");
    await expect(page.getByRole("heading", { level: 1, name: "Aviso de privacidad" })).toBeVisible();
    await page.locator("footer").getByRole("link", { name: "Eliminación de datos" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Cómo eliminar tus datos" })).toBeVisible();
  });
});
