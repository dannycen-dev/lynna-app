# Lynna

Agente de WhatsApp con IA + CRM para desarrolladoras inmobiliarias, construido sobre Cloudflare
(Workers, D1, R2, Queues, Durable Objects). Se desarrolla **local-first** con `wrangler dev` y se
despliega en la cuenta de Cloudflare de **Ignia Studio**.

- Checklist del MVP: [`specs/00-overview/checklist-whatsapp-ia.md`](specs/00-overview/checklist-whatsapp-ia.md)
- System design de referencia (Lynna en Odoo): `github.com/dannycen-dev/lynna` → `specs/`

## Estructura

```
apps/api/                  Worker (Hono) — webhook WhatsApp, cola, Durable Objects, API
  src/db/schema.ts         Esquema D1 (Drizzle) — fuente de verdad del modelo de datos
  src/whatsapp/            Webhook, firma de Meta, payload, cliente Cloud API, consumidor de cola
  src/conversation/        ConversationDO — una instancia por conversación (debounce, IA en Fase 3)
  migrations/              Migraciones generadas por drizzle-kit (no editar a mano)
  seed/demo.sql            Desarrollo ficticio "Residencial Los Almendros" (40 lotes, 3 planes)
  scripts/                 Herramientas locales (simular mensajes entrantes)
specs/                     Specs del producto
```

## Arranque local

Requisitos: Node 24, pnpm 11. Opcional para recibir mensajes reales: `brew install cloudflared`.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # llenar valores
pnpm db:migrate        # aplica migraciones a la D1 local
pnpm db:seed           # carga el desarrollo de demo
pnpm dev               # http://localhost:8787
```

Comprobar:

```bash
curl localhost:8787/health
curl 'localhost:8787/api/dev/tenants/demo/developments/los-almendros?status=available'
pnpm --filter @lynna/api simulate "Hola, ¿qué lotes tienen?"   # mensaje firmado como Meta
```

`/api/dev/*` solo existe con `ENVIRONMENT=local` (sin auth hasta la Fase 4).

## Conectar un número real de WhatsApp (local)

1. Levanta un túnel rápido (no requiere cuenta): `pnpm --filter @lynna/api tunnel` → copia la URL `https://….trycloudflare.com`.
2. En Meta → tu app → WhatsApp → Configuración → Webhook:
   - URL de devolución: `https://….trycloudflare.com/whatsapp/webhook`
   - Token de verificación: el `WHATSAPP_VERIFY_TOKEN` de `.dev.vars`
   - Suscribe el campo **messages**.
3. En `.dev.vars`: `WHATSAPP_APP_SECRET` (clave secreta de la app) y `WHATSAPP_ACCESS_TOKEN`.
4. Asocia tu número al tenant de demo:
   ```bash
   cd apps/api && pnpm exec wrangler d1 execute DB --local \
     --command "UPDATE wa_accounts SET phone_number_id='<TU_PHONE_NUMBER_ID>' WHERE id='wa-demo'"
   ```
5. Para probar el circuito de respuesta antes de la IA, cambia `AUTO_REPLY_MODE` a `"ack"` en `wrangler.jsonc`.

La URL del túnel rápido cambia en cada arranque; hay que actualizarla en Meta.

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Worker local con D1, R2, Queues y DO simulados |
| `pnpm test` | Vitest dentro del runtime de Workers |
| `pnpm typecheck` | TypeScript estricto |
| `pnpm db:generate` | Genera migración tras cambiar `schema.ts` |
| `pnpm db:migrate` / `pnpm db:seed` | Migraciones y seed en local |
| `pnpm --filter @lynna/api typegen` | Regenera `worker-configuration.d.ts` tras cambiar `wrangler.jsonc` |

## Convenciones

- `tenant_id` en todas las tablas de negocio. Dinero en centavos; porcentajes en puntos base.
- Toda entrada externa se valida con Zod. Todo lo que viene de Meta es idempotente (`wamid` único).
- Logs JSON sin PII (teléfonos enmascarados).
- El estado de un lote solo lo cambia un humano; la IA solo lo lee.
- `compatibility_date` debe ser ≤ a la que soporta el workerd de wrangler **y** el de vitest-pool-workers.

## Entornos

| Entorno | Worker / URL | D1 | Datos | Cómo se despliega |
|---|---|---|---|---|
| **local** | `wrangler dev` → `localhost:8787` | `.wrangler/state` | seed demo | `pnpm dev` |
| **dev** | `lynna-api-dev.igniastudiomx.workers.dev` | `lynna-dev` | seed demo | automático en cada push a `main` |
| **stg** | `lynna-api-stg.igniastudiomx.workers.dev` | `lynna-stg` | seed demo | tag `v*` |
| **prod** | `lynna-api-prod.igniastudiomx.workers.dev` | `lynna-prod` | reales (nunca seed) | tag `v*` + aprobación en GitHub |

Todo vive en la cuenta Cloudflare de **Ignia Studio** (`account_id` fijado en `wrangler.jsonc`).
Cada entorno tiene sus propias colas (`lynna-wa-inbound-<env>` + DLQ), D1 y secretos; nada se comparte.

### Flujo de trabajo

1. Rama corta desde `main` → PR. El pipeline corre tipos, typecheck y pruebas.
2. Merge a `main` → migraciones + deploy a **dev** + health check.
3. Release: `git tag v0.1.0 && git push origin v0.1.0` → **stg**; al aprobar el environment `prod` en GitHub → **prod**.
4. Las migraciones corren **antes** del deploy: deben ser compatibles con el código anterior
   (agregar columnas/tablas primero; borrar o renombrar en un release posterior).

### Secretos por entorno

Los valores viven en `apps/api/.dev.vars.<env>` (ignorados por git) y se suben con:

```bash
pnpm --filter @lynna/api secrets:dev     # o secrets:stg / secrets:prod
```

`secrets.required` en `wrangler.jsonc` impide desplegar si falta alguno. Mientras no haya credenciales
reales de Meta, `WHATSAPP_APP_SECRET` y `WHATSAPP_ACCESS_TOKEN` valen `PENDIENTE` (el webhook rechaza todo con 403).

### Comandos manuales (perfil `wrangler-ignia`)

Los scripts remotos usan `XDG_CONFIG_HOME=$HOME/.wrangler-cuentas/ignia` (sesión de wrangler de Ignia).

| Comando (`pnpm --filter @lynna/api …`) | Qué hace |
|---|---|
| `deploy:<env>` | Despliega el Worker del entorno |
| `db:migrate:<env>` | Aplica migraciones pendientes a la D1 remota |
| `db:seed:dev` / `db:seed:stg` | Recarga datos de demo (no existe para prod) |
| `tail:<env>` | Logs en vivo |
| `secrets:<env>` | Sube `.dev.vars.<env>` como secretos |

### CI/CD en GitHub

- `.github/workflows/pipeline.yml` orquesta; `deploy.yml` es el job reutilizable (migrar → desplegar → health check).
- Requiere el secreto de repo **`CLOUDFLARE_API_TOKEN`** (token de la cuenta de Ignia con permisos de
  Workers Scripts, D1, Queues y Account Settings de lectura).
- Environments de GitHub: `dev` (solo `main`), `stg` y `prod` (solo tags `v*`; `prod` exige aprobación).

### Pendientes de infraestructura

- Activar **R2** en la cuenta de Ignia y crear `lynna-media-{dev,stg,prod}` (Fase 1).
- Dominio propio para prod (hoy usa `workers.dev`).
