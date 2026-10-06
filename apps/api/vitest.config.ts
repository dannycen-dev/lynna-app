import { readFileSync } from "node:fs";
import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Sin red ni neuronas en pruebas: el agente se prueba con un LLM falso (test/agent.test.ts).
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEED_SQL: readFileSync(path.join(import.meta.dirname, "seed/demo.sql"), "utf8"),
            WHATSAPP_APP_SECRET: "test-app-secret",
            WHATSAPP_VERIFY_TOKEN: "test-verify-token",
            WHATSAPP_ACCESS_TOKEN: "test-access-token",
            ADMIN_API_TOKEN: "test-admin-token-0123456789abcdef0123456789",
            // El agente se prueba directo con un LLM falso; el DO no debe llamar a la IA en las pruebas.
            AUTO_REPLY_MODE: "off",
            AI_MODEL: "fake",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
