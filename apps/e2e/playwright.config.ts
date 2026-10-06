import { defineConfig } from "@playwright/test";
import { LOCAL_PORT, REMOTE_BASE_URL } from "./lib/env";

// Local/CI: Playwright levanta `wrangler dev` con estado limpio y corre TODO.
// Remoto (E2E_BASE_URL=https://lynna-api-dev…): solo @smoke, que no escribe datos.
const remote = Boolean(REMOTE_BASE_URL);
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  ...(remote ? { grep: /@smoke/ } : {}),
  use: {
    baseURL: REMOTE_BASE_URL ?? `http://127.0.0.1:${LOCAL_PORT}`,
    trace: "retain-on-failure",
    browserName: "chromium",
    viewport: { width: 1366, height: 900 },
    locale: "es-MX",
    timezoneId: "America/Mexico_City",
    contextOptions: { reducedMotion: "reduce" },
  },
  ...(remote
    ? {}
    : {
        webServer: {
          command: "./scripts/start-local-api.sh",
          url: `http://127.0.0.1:${LOCAL_PORT}/health`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: "ignore",
          stderr: process.env.E2E_DEBUG ? "pipe" : "ignore",
          env: { E2E_PORT: String(LOCAL_PORT) },
        },
      }),
});
