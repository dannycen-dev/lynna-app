#!/usr/bin/env bash
# Usuarios ficticios de demo, uno por rol (desarrolladora "demo"), con contraseña genérica.
# Solo para entornos con datos ficticios: se niega a correr en prod.
#
#   pnpm --filter @lynna/api demo:users --target stg      (local | dev | stg)
set -euo pipefail

TARGET="local"
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    *) echo "Uso: demo-users.sh --target local|dev|stg" >&2; exit 1 ;;
  esac
done
if [ "$TARGET" = "prod" ]; then
  echo "✘ Los usuarios de demo con contraseña genérica no van en prod." >&2
  exit 1
fi

PASSWORD="LynnaDemo2026!"
cd "$(dirname "$0")/.."

create() { node scripts/create-user.mjs --target "$TARGET" --password "$PASSWORD" "$@"; }
create --email sofia.ramirez@lynna.mx --name "Sofía Ramírez" --role admin
create --email carlos.mendoza@lynna.mx --name "Carlos Mendoza" --role owner --tenant demo
create --email laura.gonzalez@lynna.mx --name "Laura González" --role manager --tenant demo
create --email miguel.torres@lynna.mx --name "Miguel Torres" --role seller --tenant demo
create --email ana.hernandez@lynna.mx --name "Ana Hernández" --role seller --tenant demo

echo "Contraseña de todos: $PASSWORD"
