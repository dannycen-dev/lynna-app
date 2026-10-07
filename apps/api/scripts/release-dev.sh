#!/usr/bin/env bash
# Despliegue manual seguro a dev (lo mismo que hace deploy.yml en CI):
# migraciones (con reintentos) → verificar que no queden pendientes → deploy → /health.
# Nunca despliega código nuevo sobre una base sin migrar.
set -euo pipefail
cd "$(dirname "$0")/.."
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.wrangler-cuentas/ignia}"

for attempt in 1 2 3; do
  if pnpm exec wrangler d1 migrations apply DB --env dev --remote; then break; fi
  echo "⚠ Migraciones fallaron (intento $attempt/3); reintentando en 5 s…"
  sleep 5
  [ "$attempt" = 3 ] && { echo "✘ No se pudieron aplicar las migraciones: NO se despliega."; exit 1; }
done

pending=$(pnpm exec wrangler d1 migrations list DB --env dev --remote 2>&1 || true)
if ! grep -q "No migrations to apply" <<<"$pending"; then
  echo "$pending"
  echo "✘ Quedan migraciones pendientes: NO se despliega."
  exit 1
fi

pnpm --filter @lynna/web build
pnpm exec wrangler deploy --env dev

for attempt in 1 2 3 4 5; do
  health=$(curl -fsS https://devlynna.igniastudio.mx/health || true)
  if grep -q '"ok":true' <<<"$health"; then
    # Calentar: la primera carga tras el deploy (HTML, JS, /api/auth/me) es la lenta.
    for path in / /login /api/auth/me; do curl -s -o /dev/null https://devlynna.igniastudio.mx$path || true; done
    echo "✔ dev sano: $health"
    exit 0
  fi
  sleep 3
done
echo "✘ /health no respondió bien: $health"
exit 1
