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
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEED_SQL: readFileSync(path.join(import.meta.dirname, "seed/demo.sql"), "utf8"),
            WHATSAPP_APP_SECRET: "test-app-secret",
            WHATSAPP_VERIFY_TOKEN: "test-verify-token",
            WHATSAPP_ACCESS_TOKEN: "test-access-token",
            ADMIN_API_TOKEN: "test-admin-token-0123456789abcdef0123456789",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
