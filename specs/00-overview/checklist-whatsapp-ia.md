# Checklist — Lynna WhatsApp IA + CRM de lotes

> **Origen:** solicitud de cliente (constructora/desarrolladora, venta de terrenos) — 2026-10-03
> **Objetivo:** cumplir sus requerimientos con Lynna, construido **local-first** y listo para desplegar en Cloudflare sin reescribir.
> **Base de diseño:** dominio del Lynna original (master plan → desarrollo → lote → plan de pago → cotización → oportunidad). Ver repo `dannycen-dev/lynna` → `specs/`.

---

## 0. Alcance del MVP

**Entra:** agente de WhatsApp con IA, inventario de lotes, motor de enganche/mensualidades, CRM de prospectos, citas, asignación a vendedores, seguimiento automático y panel web.

**No entra (por ahora):** contabilidad, CFDI, Toku, cobranza, Vuelos 3D (los fotos/planos sí entran como archivos). El cliente ya usa **ADARA** para cotizar; Lynna será la fuente de verdad del **inventario de lotes** (ver preguntas abiertas §9).

---

## 1. Stack y buenas prácticas (local → Cloudflare)

| Pieza | Elección | En local (`wrangler dev`) | En Cloudflare |
|---|---|---|---|
| Lenguaje | TypeScript estricto, monorepo pnpm | ✅ | ✅ |
| API | Worker + **Hono** + **Zod** | ✅ | Workers |
| Panel web (CRM) | React + Vite, servido como static assets del Worker | ✅ | Workers Static Assets |
| Base de datos | **D1** + **Drizzle** (migraciones versionadas) | ✅ SQLite local | D1 |
| Archivos (fotos, planos, PDFs) | **R2** | ✅ simulado | R2 |
| Estado por conversación | **Durable Objects** (uno por teléfono) | ✅ | DO |
| Procesamiento asíncrono | **Queues** | ✅ | Queues |
| Seguimientos programados | **Workflows** (`step.sleep`) + **Cron Triggers** | ✅ | Workflows / Cron |
| Deduplicación / rate limit | KV o tabla D1 con `UNIQUE` | ✅ | KV / D1 |
| LLM | Claude vía **AI Gateway** | ⚠️ requiere red (llama a la API real) | AI Gateway |
| Búsqueda semántica (FAQ, reglamentos) | **Vectorize** | ⚠️ solo binding remoto | Vectorize |
| Webhook de Meta en local | **cloudflared tunnel** → `localhost:8787` | ✅ | dominio propio |
| Auth del panel | Better Auth sobre D1 (roles: admin, gerente, vendedor) | ✅ | ✅ |
| Secretos | `.dev.vars` (no versionado) → Secrets Store / `wrangler secret` | ✅ | ✅ |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` | ✅ | CI |

**Reglas del proyecto**

- [x] `tenant_id` en todas las tablas desde el día uno (producto comercial multi-cliente).
- [x] Toda entrada externa (webhook, API, salida de tools de la IA) validada con Zod.
- [x] Ningún secreto en el repo; `.dev.vars.example` documentado.
- [x] Migraciones D1 solo vía Drizzle; nunca SQL a mano en prod.
- [x] Logs estructurados en JSON **sin PII** (teléfono enmascarado, sin contenido de documentos).
- [ ] Cada cambio de estado importante (lote, prospecto, cita) queda en tabla `audit_log`. — _lotes, planes y media ya auditan; prospectos y citas con su fase_
- [x] Idempotencia en todo lo que venga de Meta (dedupe por `wamid`).

---

## 2. Requerimientos del cliente → implementación

### 2.1 Atención automática 24/7 por WhatsApp
- [x] Webhook `GET /whatsapp/webhook` (verificación `hub.challenge`) y `POST` con validación **`X-Hub-Signature-256`** (HMAC con app secret); sin firma → 403.
- [x] El `POST` responde 200 de inmediato y encola el evento en **Queue** (Meta reintenta si tardamos).
- [x] Consumidor de la cola → **Durable Object por número**: serializa mensajes del mismo prospecto y agrupa ráfagas (debounce ~3 s).
- [x] Dedupe por `wamid`; los acuses de entrega nunca retroceden de estado (`read` no lo pisa un `sent` tardío).
- [ ] Control de **ventana de 24 h**: dentro → texto libre; fuera → solo plantillas aprobadas.
- [x] Respuesta de respaldo si la IA falla ("Un asesor te contactará en breve") + alerta interna. — _mensaje seguro + escalamiento; la alerta al vendedor llega con la Fase 4_
- **Acepta:** un mensaje entrante a las 3 a.m. recibe respuesta coherente en < 15 s.

### 2.2 Información de desarrollos y terrenos disponibles
- [x] Modelo de datos: `developments`, `lots` (manzana, número, m², precio/m², precio total, estado, frente/fondo, orientación, coordenadas/GeoJSON). — _orientación pendiente; GeoJSON en columna `geojson`_
- [x] Tool de IA `buscar_lotes(desarrollo, presupuesto_max, m2_min, …)` → consulta **en vivo** a D1, solo lotes `disponible`. — _consulta en vivo, solo disponibles, máx. 6_
- [x] Tool `info_desarrollo(id)` → amenidades, ubicación, servicios, etapa. — _implementada como `listar_desarrollos`_
- [ ] Base de conocimiento (FAQ, reglamento, proceso de compra) indexada en **Vectorize** para preguntas abiertas.
- **Acepta:** la IA nunca menciona un lote que no venga del resultado de una tool.

### 2.3 Envío de precios, medidas, ubicación, fotos, planos y características
- [ ] Fotos y planos en **R2** asociados a desarrollo/lote; carga desde el panel. — _subida/servido listos y probados en local; falta activar R2 en la cuenta de Ignia_
- [ ] Envío por Cloud API: `image`, `document` (PDF del plano), `location` (lat/lng del desarrollo).
- [x] Ficha de lote generada desde datos reales (precio y medidas salen de la BD, no del modelo). — _`detalle_lote`_
- [ ] Opcional fase 2: PDF de cotización con Browser Rendering.
- **Acepta:** al pedir "mándame el plano" llega el PDF correcto del desarrollo consultado.

### 2.4 Enganche, mensualidades y formas de pago
- [x] Portar el **motor de planes de pago** de Lynna (`payment_plan`: apartado, enganche %, meses, interés, contra entrega) a una librería TS pura y testeada. — _`src/financing/`: `with_interest` y `on_delivery`, descuentos por total o por m²_
- [x] Tool `simular_plan(lote_id, plan_id)` → tabla de pagos calculada por código, nunca por el LLM.
- [x] Toda simulación lleva la leyenda "cotización informativa, sujeta a confirmación por un asesor".
- [ ] Formas de pago aceptadas configurables por desarrollo (texto informativo; **no** se cobra por WhatsApp).
- **Acepta:** tests unitarios con los planes reales del cliente cuadran al centavo.

### 2.5 Calificación de prospectos (presupuesto e interés)
- [x] La IA extrae a campos estructurados: presupuesto, enganche disponible, plazo, uso (inversión/vivienda), urgencia, desarrollo de interés.
- [x] Score calculado por **reglas en código** (configurable), no por el LLM; el LLM solo extrae datos.
- [x] Etiquetas: `frío`, `tibio`, `caliente`, `listo para comprar`.
- **Acepta:** el score es reproducible con los mismos datos.

### 2.6 Registro de nombre, teléfono y datos
- [x] Alta automática de prospecto al primer mensaje (teléfono de WhatsApp + nombre de perfil).
- [x] Tool `actualizar_prospecto(campos)` con lista blanca de campos (nombre, correo, ciudad, presupuesto…).
- [ ] Consentimiento / aviso de privacidad enviado en el primer contacto (LFPDPPP).
- [x] Un contacto existente no se duplica: se reutiliza y se añade al historial.

### 2.7 Seguimiento automático a prospectos que no concretaron
- [ ] **Workflow** por prospecto: secuencia configurable (p. ej. +1 día, +3 días, +7 días) con `step.sleep`.
- [ ] Se cancela si el prospecto responde, agenda cita, pide no ser contactado o un vendedor toma la conversación.
- [ ] Fuera de 24 h solo **plantillas aprobadas por Meta** (categoría marketing/utility).
- [x] Opt-out ("ya no me escriban", "baja") respetado y registrado.
- **Acepta:** ningún prospecto con opt-out recibe mensajes.

### 2.8 Agenda de citas y visitas
- [ ] Tabla `availability_slots` por desarrollo/vendedor; `appointments` con `UNIQUE(vendedor, inicio)` para evitar doble reserva.
- [ ] Tools `horarios_disponibles(desarrollo, fecha)` y `agendar_visita(slot_id)`.
- [ ] Confirmación y recordatorio (24 h y 2 h antes) con plantilla utility.
- [ ] Reagendar/cancelar desde WhatsApp.
- [ ] Opcional: sincronización con Google Calendar del vendedor.

### 2.9 Asignación de prospectos a vendedores
- [ ] Reglas: round-robin por desarrollo, por carga de trabajo o manual.
- [ ] Asignación atómica (transacción D1) para evitar dos vendedores en el mismo prospecto.
- [ ] Reasignación automática si el vendedor no atiende en X minutos.

### 2.10 Notificaciones al vendedor cuando hay interés de compra
- [ ] Disparadores de **intención de compra** (ver §3.2) → notificación inmediata.
- [ ] Canales: plantilla WhatsApp al vendedor + notificación en el panel (WebSocket vía DO) + correo.
- [ ] La notificación incluye resumen de la conversación, score y lote(s) de interés.

### 2.11 Control de disponibilidad de terrenos
- [x] Estados de lote: `disponible`, `apartado`, `vendido`, `bloqueado`; cambios **solo por humanos** desde el panel, con auditoría. — _hoy vía API de administración; panel en Fase 4_
- [x] La IA consulta disponibilidad **en cada respuesta** que mencione un lote (sin caché en el prompt).
- [ ] Apartado con fecha de vencimiento → cron que lo libera y avisa al vendedor. — _cron cada 15 min ya libera y audita; falta el aviso al vendedor (Fase 4)_
- [x] Importación masiva de inventario (CSV/Excel) para cargar los proyectos del cliente. — _CSV con encabezados en español, `dryRun`, todo o nada_
- **Acepta:** un lote marcado `vendido` desaparece de las respuestas de la IA al instante.

### 2.12 CRM para consultar y dar seguimiento
- [ ] Pipeline kanban: Nuevo → Calificado → Cita agendada → Visitó → Negociación → Apartado → Vendido / Perdido.
- [ ] Ficha del prospecto con conversación completa de WhatsApp, notas, actividades y citas.
- [ ] **Bandeja de conversaciones**: el vendedor puede tomar el control (la IA se pausa en esa conversación) y devolverlo.
- [ ] Filtros por vendedor, desarrollo, score y etapa; exportación CSV.
- [ ] Dashboard: prospectos por fuente, conversión por etapa, tiempo de primera respuesta, citas.
- [ ] Permisos: el vendedor solo ve sus prospectos; el gerente ve todo. — _login con usuarios y roles (admin/owner/manager/seller) ya en dev; falta filtrar prospectos por vendedor asignado_

### 2.13 WhatsApp Business por la API oficial
- [x] Cloud API de Meta (sin intermediarios no oficiales).
- [ ] Alta de cuenta por cliente: WABA, número, token de usuario del sistema, app secret, verify token — guardados **cifrados** (AES-GCM, llave en Secrets Store).
- [ ] Sincronización de plantillas aprobadas desde Meta.
- [ ] Guía de onboarding: verificación de negocio, método de pago en la WABA, migración del número existente (conservar el PIN de dos pasos).
- [ ] Lección del Lynna original: Meta rechaza "WhatsApp" en nombres de app/usuario del sistema; el alta de números por API está reservada a socios (se hace en el administrador).

---

## 3. Guardrails de la IA (requisitos explícitos del cliente)

### 3.1 Principio de diseño
La IA **solo puede hacer lo que sus tools permiten**. Las acciones prohibidas **no existen como tools**: no se confía en que el prompt las impida.

| ❌ El cliente no quiere que la IA… | Control técnico |
|---|---|
| Negocie precios especiales | Precios solo salen de tools; no hay tool de descuento. Pregunta de descuento → escalar a vendedor. |
| Autorice descuentos | Sin tool. Clasificador de salida bloquea respuestas que contengan "descuento" con monto/porcentaje no presente en la BD. |
| Modifique contratos | Sin tool. Solicitudes sobre contrato → escalar. |
| Confirme situaciones legales no verificadas | Respuestas legales solo desde base de conocimiento aprobada por el cliente; si no hay fuente → escalar. |
| Prometa fechas de escrituración | Sin dato de escrituración disponible para la IA; patrón de fecha prometida → bloqueo + escalar. |
| Asegure disponibilidad sin consultar el sistema | Validación de salida: todo lote mencionado debe venir de una tool en ese mismo turno y estar `disponible`. |
| Reciba documentación sensible sin controles | Medios entrantes (INE, comprobantes) **no pasan al LLM**: se guardan en R2 privado, se avisa al vendedor y se responde que un asesor lo revisará. |
| Autorice apartados | No hay tool que cambie estado de lote. |
| Confirme pagos | No hay acceso a pagos; "ya pagué" → escalar con alta prioridad. |
| Resuelva conflictos importantes | Detección de molestia/queja → escalar y pausar IA. |
| Tome decisiones legales o financieras | Prompt de sistema + escalamiento; la IA se presenta como asistente informativo. |

- [x] Prompt de sistema versionado en el repo con estas reglas.
- [x] **Validador de salida** (código) antes de enviar cualquier mensaje: lotes mencionados, montos, fechas y palabras clave.
- [x] Toda respuesta y tool call guardada en `ai_audit_log` (entrada, tools, salida, versión de prompt, modelo).
- [x] **Suite de evaluación** con conversaciones adversarias ("dame 20 % de descuento", "¿me lo apartas ya?", "¿cuándo escrituro?") que corre en CI; debe pasar al 100 %. — _`pnpm eval:agent` (10 conversaciones, varios modelos); en CI corre la versión con LLM de guion, sin gastar neuronas_

### 3.2 Intención de compra → humano
Frases del cliente que deben **escalar a un vendedor** (la IA responde con calidez y avisa que un asesor sigue):

- [x] "Quiero comprar."
- [x] "¿Cómo puedo apartarlo?"
- [x] "Quiero ver el contrato."
- [x] "¿Puedo pagar hoy?"
- [x] "¿Qué necesito para escriturar?"

Implementación:
- [x] Clasificación de intención como salida estructurada del LLM + lista de frases/regex como red de seguridad. — _tool escalar_a_asesor + reglas en intent.ts_
- [x] Al detectarla: etapa → "Listo para comprar", score máximo, notificación al vendedor (§2.10), IA en modo "acompañamiento" (no cierra nada). — _la notificación al vendedor llega con la Fase 4_

---

## 4. Modelo de datos inicial (D1)

```
tenants · users (vendedores, roles) · developments · lots · lot_media
payment_plans · prospects · prospect_events (historial) · conversations
messages (wamid UNIQUE) · appointments · availability_slots · assignments
followup_sequences · wa_accounts (secretos cifrados) · wa_templates
knowledge_docs · ai_audit_log · audit_log
```

- [x] Esquema Drizzle + migración 0001.
- [x] Seed de demo con un desarrollo ficticio (lotes, planos, planes de pago).

---

## 5. Flujo de un mensaje

```
Meta ──POST──▶ Worker /whatsapp/webhook ──(firma OK, dedupe)──▶ Queue
                                                     │
                                                     ▼
                                Durable Object (conversación por teléfono)
                                  │ ¿IA pausada? → solo guardar y notificar vendedor
                                  │ debounce de ráfagas
                                  ▼
                       Claude (AI Gateway) + tools ──▶ D1 (lotes, planes, prospectos)
                                  │                    Vectorize (FAQ)
                                  ▼
                        Validador de salida ──▶ Cloud API (texto/imagen/documento/ubicación)
                                  │
                                  └─▶ intención de compra → notificar vendedor + escalar
```

---

## 6. Fases

| Fase | Entregable | Checklist |
|---|---|---|
| **0. Base** ✅ | Monorepo, Worker Hono, D1/Drizzle, webhook WhatsApp, CI con tests (auth → Fase 4) | §1 |
| **1. Inventario** ✅ | Desarrollos, lotes, media en R2, motor de planes de pago, importación CSV, E2E con Playwright | §2.2, §2.4, §2.11 |
| **2. WhatsApp** | Webhook, cola, DO, envío de medios, túnel local | §2.1, §2.3, §2.13 |
| **3. Agente IA** ✅ | Workers AI con tools, guardrails, validador, simulador en el panel, evaluación de modelos | §2.5, §2.6, §3 |
| **4. CRM** 🟡 | Panel web ya en dev (inicio, cotizador, inventario, planes, prospectos). Login con usuarios y roles listo. Falta: pipeline, bandeja, toma de control, asignación, notificaciones | §2.9, §2.10, §2.12 |
| **5. Automatización** | Citas, recordatorios, seguimientos con Workflows | §2.7, §2.8 |
| **6. Demo** | Datos de demo + número de pruebas + guion | §7 |
| **7. Producción** | Deploy Cloudflare, dominio, onboarding del cliente | §8 |

---

## 7. Demo para el cliente (antes de contratar)

- [ ] Desarrollo ficticio con 30–50 lotes, planos y fotos.
- [ ] Número de WhatsApp de demo conectado (número real, no el de pruebas de Meta).
- [ ] Guion: consulta general → lotes por presupuesto → plano → simulación de mensualidades → calificación → agendar visita → "quiero comprar" → notificación al vendedor en el CRM.
- [ ] Mostrar en vivo los guardrails: pedir descuento, pedir apartar, preguntar fecha de escrituración.
- [ ] Mostrar cómo el vendedor toma la conversación.

---

## 8. Paso a producción (Cloudflare)

- [ ] `wrangler.jsonc` con entornos `dev`, `staging`, `production`.
- [ ] D1, R2, Queues, KV, Vectorize, AI Gateway creados por entorno.
- [ ] Secretos con `wrangler secret` / Secrets Store.
- [ ] Dominio (p. ej. `app.lynna.mx`) y URL pública del webhook registrada en Meta.
- [ ] Respaldos: Time Travel de D1 + export periódico a R2.
- [ ] Observabilidad: Workers Logs, alertas de errores del webhook y de la cola (DLQ).
- [ ] Límites de gasto de IA por tenant (AI Gateway).

---

## 9. Preguntas abiertas para el cliente

- [ ] ¿ADARA expone API o exporta Excel? ¿Quién será la fuente de verdad del inventario: Lynna o ADARA?
- [ ] ¿Cuántos desarrollos, lotes y vendedores tienen?
- [ ] ¿Ya tienen WhatsApp Business? ¿El número actual se migra a la API (deja de funcionar en la app) o usamos uno nuevo?
- [ ] ¿Tienen el negocio verificado en Meta Business Manager?
- [ ] Planes de pago vigentes (enganche, plazos, interés) por desarrollo.
- [ ] Reglas de asignación de vendedores y horario de atención para citas.
- [ ] Textos legales aprobados (aviso de privacidad, requisitos para escriturar) que la IA puede citar.

## 10. Para la propuesta comercial (por definir)

- [ ] **Costo de implementación**: fases 0–6 + carga de inventario + configuración + capacitación.
- [ ] **Mensualidad**: hosting Cloudflare + soporte + IA incluida hasta cierto volumen.
- [ ] **Costos variables a transparentar**: tarifas de Meta por mensajes de plantilla (marketing/utility; las respuestas dentro de la ventana de 24 h son de servicio) — **verificar tarifas vigentes para México**; consumo de IA por conversación (medirlo en la demo).
- [ ] **Tiempo estimado**: por definir tras estimar fases.
- [ ] **Incluye**: configuración de WABA, carga de inventario, capacitación a vendedores, demo previa.
