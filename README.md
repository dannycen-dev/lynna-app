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

## Despliegue (pendiente)

Antes de cualquier comando remoto: `npx wrangler whoami` debe mostrar la cuenta de **Ignia Studio**.
Después: fijar `account_id`, crear D1/R2/Queues y reemplazar el `database_id` placeholder en `wrangler.jsonc`.
