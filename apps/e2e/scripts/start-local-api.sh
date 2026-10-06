#!/usr/bin/env bash
# Levanta la API para Playwright con estado limpio: migraciones + seed + wrangler dev.
set -euo pipefail

API_DIR="$(cd "$(dirname "$0")/../../api" && pwd)"
STATE="$API_DIR/.wrangler/e2e-state"
cd "$API_DIR"

rm -rf "$STATE"
pnpm exec wrangler d1 migrations apply DB --local --persist-to "$STATE" >/dev/null
pnpm exec wrangler d1 execute DB --local --persist-to "$STATE" --file=seed/demo.sql >/dev/null

exec pnpm exec wrangler dev \
  --port "${E2E_PORT:-8788}" \
  --inspector-port 0 \
  --persist-to "$STATE" \
  --var "WHATSAPP_APP_SECRET:e2e-app-secret" \
  --var "WHATSAPP_VERIFY_TOKEN:e2e-verify-token" \
  --var "WHATSAPP_ACCESS_TOKEN:e2e-access-token" \
  --var "ADMIN_API_TOKEN:e2e-admin-token-0123456789abcdef0123456789" \
  --var "DEBOUNCE_MS:500"
