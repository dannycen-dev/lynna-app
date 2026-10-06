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
  src/financing/           Motor de planes de pago (puro, en centavos) portado de Lynna Odoo
  src/catalog/             Reglas de inventario: búsqueda, simulación, estados, importación CSV
  src/routes/admin.ts      API de administración (/api/admin, token provisional hasta la Fase 4)
  migrations/              Migraciones generadas por drizzle-kit (no editar a mano)
  seed/demo.sql            Desarrollo ficticio "Residencial Los Almendros" (40 lotes, 3 planes)
  scripts/                 Herramientas locales (simular mensajes entrantes)
apps/web/                  Panel (React 19 + Vite + React Router + TanStack Query) con el diseño de Lynna;
                           el mismo Worker lo sirve como assets estáticos (mismo origen que la API)
apps/e2e/                  Pruebas end-to-end con Playwright: API, navegador y smoke post-deploy
specs/                     Specs del producto
```

## Arranque local

Requisitos: Node 24, pnpm 11. Opcional para recibir mensajes reales: `brew install cloudflared`.

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # llenar valores
pnpm db:migrate        # aplica migraciones a la D1 local
pnpm db:seed           # carga el desarrollo de demo
pnpm build            # compila la interfaz (apps/web/dist)
pnpm dev               # http://localhost:8787 → API + interfaz compilada
pnpm dev:web           # opcional: http://localhost:5173 con recarga en caliente (proxy a la API)
```

Para entrar crea tu usuario (no hay registro abierto):

```bash
pnpm user:create --email tu@empresa.mx --name "Tu Nombre" --role admin                 # local
pnpm user:create --email ana@cliente.mx --name "Ana" --role manager --tenant demo --target dev
```

Si no pasas `--password`, se genera una y se muestra **una sola vez**. Volver a correrlo con el mismo correo
cambia la contraseña y cierra sus sesiones.

Usuarios ficticios de demo (uno por rol, desarrolladora `demo`, contraseña `LynnaDemo2026!`) — ya creados en **stg**:
`pnpm demo:users --target local|dev|stg` (se niega a correr en prod).

| Correo | Rol |
|---|---|
| sofia.ramirez@lynna.mx | admin (Ignia) |
| carlos.mendoza@lynna.mx | owner |
| laura.gonzalez@lynna.mx | manager |
| miguel.torres@lynna.mx | seller |
| ana.hernandez@lynna.mx | seller |

## Usuarios y acceso

| Rol | Alcance |
|---|---|
| `admin` | Equipo Ignia: todas las desarrolladoras |
| `owner`, `manager` | Su desarrolladora: inventario, planes, importación, estados |
| `seller` | Su desarrolladora: consulta y cotiza; no modifica |

- Contraseñas con PBKDF2-SHA256 (100k iteraciones, sal por usuario); se re-hashean solas si suben las iteraciones.
- Sesión en cookie `lynna_session` `HttpOnly` + `Secure` + `SameSite=Lax`, 7 días deslizantes; en BD solo el SHA-256 del token.
- Bloqueo de 15 min tras 5 intentos fallidos por correo; mismo mensaje para correo inexistente o contraseña mala.
- Anti-CSRF: toda petición con cookie que modifica datos debe traer `Origin` del mismo sitio.
- Un usuario que pide otra desarrolladora recibe 404 (no se revela que existe).
- `ADMIN_API_TOKEN` queda solo para automatización (scripts, pruebas); la interfaz no lo usa.

Comprobar:

```bash
curl localhost:8787/health
T=$(grep ADMIN_API_TOKEN apps/api/.dev.vars | cut -d= -f2-)
curl -H "authorization: Bearer $T" 'localhost:8787/api/admin/tenants/demo/developments/los-almendros/lots?status=available'
pnpm --filter @lynna/api simulate "Hola, ¿qué lotes tienen?"   # mensaje firmado como Meta
```

## API de administración

Todas las rutas van bajo `/api/admin/tenants/<tenant>`, con sesión (cookie) o `Authorization: Bearer <ADMIN_API_TOKEN>`
para automatización. Cada cambio queda en `audit_log` con el usuario que lo hizo.
Login: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.

| Método y ruta | Qué hace |
|---|---|
| `GET/POST /developments`, `PATCH /developments/:slug` | Desarrollos |
| `GET /developments/:slug/lots?status=` | Lotes (filtrables por estado) |
| `POST /developments/:slug/lots/import?dryRun=true` | Importa CSV (cuerpo = CSV). Todo o nada; errores por renglón |
| `PATCH /lots/:id/status` | `{status, reason, reservedUntil?}` — apartar exige vencimiento futuro |
| `GET/POST /payment-plans`, `PATCH /payment-plans/:id` | Planes (no se editan: solo `active`) |
| `GET /developments/:slug/payment-plans` | Planes que aplican a un desarrollo |
| `POST /simulate` | `{lotId, planId, quoteDate?}` → desglose y tabla de pagos (solo lotes disponibles) |
| `GET/POST /developments/:slug/media?kind=photo\|plan\|brochure` | Fotos/planos a R2 (cuerpo = archivo; JPG, PNG, WebP o PDF ≤ 15 MB) |
| `DELETE /media/:id` | Borra de R2 y de D1 |
| `GET /prospects`, `GET /conversations/:id/messages` | Prospectos y mensajes de WhatsApp |

Público: `GET /media/:id` sirve el archivo (con ETag). Cron cada 15 min: libera apartados vencidos.

CSV de lotes — columnas (acepta `,` o `;` y encabezados en español):
`manzana, lote, superficie_m2, precio_m2` (obligatorias) y `frente_m, fondo_m, precio_total, estado, caracteristicas`.
`estado`: disponible / apartado / vendido / bloqueado. Si falta `precio_total` se calcula.

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
| `pnpm test` | Vitest dentro del runtime de Workers (unitarias e integración) |
| `pnpm e2e` | Playwright: levanta `wrangler dev` con estado limpio + seed y prueba API e interfaz (Chromium) |
| `SCREENSHOT_DIR=/ruta pnpm e2e` | Además guarda capturas de cada pantalla |
| `E2E_BASE_URL=https://… pnpm e2e:smoke` | Solo pruebas `@smoke` (lectura) contra un entorno desplegado |
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
| **dev** | https://devlynna.igniastudio.mx | `lynna-dev` | seed demo | automático en cada push a `main` |
| **stg** | https://stglynna.igniastudio.mx | `lynna-stg` | seed demo + usuarios de demo | tag `v*` |
| **prod** | https://lynna.igniastudio.mx | `lynna-prod` | reales (nunca seed) | tag `v*` + aprobación en GitHub |

Todo vive en la cuenta Cloudflare de **Ignia Studio** (`account_id` fijado en `wrangler.jsonc`).
Cada entorno tiene sus propias colas (`lynna-wa-inbound-<env>` + DLQ), D1 y secretos; nada se comparte.

### Flujo de trabajo

1. Rama corta desde `main` → PR. El pipeline corre tipos, typecheck, pruebas y **E2E con Playwright**.
2. Merge a `main` → migraciones + deploy a **dev** + health check + **smoke E2E** contra dev.
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
- Dominios: Custom Domains de Workers sobre la zona `igniastudio.mx` (DNS y certificado automáticos);
  `*.workers.dev` desactivado para que cada entorno tenga una sola URL.
