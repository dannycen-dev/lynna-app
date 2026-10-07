import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Convenciones:
// - Todas las tablas de negocio llevan tenant_id (producto multi-cliente).
// - Dinero en centavos (integer); porcentajes en puntos base (1 % = 100).
// - Fechas en epoch ms (integer).

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const createdAt = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now());
const updatedAt = () =>
  integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());
const tenantId = () =>
  text("tenant_id")
    .notNull()
    .references(() => tenants.id);

/** Horario de atención de los asesores: tramos por día (0 = domingo), en minutos desde la medianoche. */
export type BusinessHours = { weekday: number; startMinute: number; endMinute: number }[];

export const tenants = sqliteTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Asignación de prospectos: en turno automático o manual por un gerente.
  assignmentMode: text("assignment_mode", { enum: ["round_robin", "manual"] }).notNull().default("round_robin"),
  // Si un prospecto pidió asesor y nadie tomó la conversación en estos minutos, pasa al siguiente vendedor (0 = nunca).
  reassignAfterMinutes: integer("reassign_after_minutes").notNull().default(30),
  // Agenda: zona horaria del negocio (horarios de los vendedores) y duración de cada cita.
  timezone: text("timezone").notNull().default("America/Mexico_City"),
  appointmentMinutes: integer("appointment_minutes").notNull().default(60),
  // Cómo se presenta la IA y cuándo atienden los asesores. La IA contesta 24/7; fuera de este horario
  // le dice al prospecto cuándo lo contactará un asesor ("mañana a partir de las 9:00") en lugar de "en breve".
  assistantName: text("assistant_name").notNull().default("Lynna"),
  businessHours: text("business_hours", { mode: "json" }).$type<BusinessHours>(),
  // Privacidad (LFPDPPP): enlace al aviso de privacidad y texto corto que se manda en el primer mensaje.
  privacyNoticeUrl: text("privacy_notice_url"),
  privacyNoticeText: text("privacy_notice_text"),
  createdAt: createdAt(),
});

// Un número de WhatsApp (Cloud API) conectado. El webhook resuelve el tenant por phone_number_id.
export const waAccounts = sqliteTable("wa_accounts", {
  id: id(),
  tenantId: tenantId(),
  phoneNumberId: text("phone_number_id").notNull().unique(),
  wabaId: text("waba_id"),
  displayPhone: text("display_phone"),
  createdAt: createdAt(),
});

export const developments = sqliteTable(
  "developments",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    lat: real("lat"),
    lng: real("lng"),
    // JSON: string[]
    amenities: text("amenities", { mode: "json" }).$type<string[]>(),
    status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("developments_tenant_slug_uq").on(t.tenantId, t.slug)],
);

export const LOT_STATUSES = ["available", "reserved", "sold", "blocked"] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export const lots = sqliteTable(
  "lots",
  {
    id: id(),
    tenantId: tenantId(),
    developmentId: text("development_id")
      .notNull()
      .references(() => developments.id),
    block: text("block").notNull(), // manzana
    number: text("number").notNull(),
    areaM2: real("area_m2").notNull(),
    frontM: real("front_m"),
    depthM: real("depth_m"),
    pricePerM2Cents: integer("price_per_m2_cents").notNull(),
    totalPriceCents: integer("total_price_cents").notNull(),
    // Solo un humano cambia el estado (desde el panel, con auditoría). La IA solo lo lee.
    status: text("status", { enum: LOT_STATUSES }).notNull().default("available"),
    reservedUntil: integer("reserved_until"),
    // Quién lo apartó y para qué prospecto: a ellos se les avisa antes de que venza y cuando se libera.
    reservedByUserId: text("reserved_by_user_id"),
    reservedForProspectId: text("reserved_for_prospect_id"),
    reservationWarnedAt: integer("reservation_warned_at"),
    features: text("features"),
    geojson: text("geojson"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("lots_dev_block_number_uq").on(t.developmentId, t.block, t.number),
    index("lots_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const lotMedia = sqliteTable("lot_media", {
  id: id(),
  tenantId: tenantId(),
  developmentId: text("development_id")
    .notNull()
    .references(() => developments.id),
  lotId: text("lot_id").references(() => lots.id),
  kind: text("kind", { enum: ["photo", "plan", "brochure"] }).notNull(),
  r2Key: text("r2_key").notNull(),
  mime: text("mime").notNull(),
  caption: text("caption"),
  sort: integer("sort").notNull().default(0),
});

// Motor portado de realestate.payment.plan (Lynna Odoo). Ver src/financing/.
// - with_interest: enganche % + amortización francesa a `months` con `annual_interest_bp`.
// - on_delivery: enganche / mensualidades (`months` pagos) / contra entrega, cada segmento
//   en % o monto fijo; `rounding_absorber` toma la diferencia para cuadrar al precio de venta.
export const CALCULATION_TYPES = ["with_interest", "on_delivery"] as const;
export const VALUE_TYPES = ["percentage", "fixed"] as const;
export const ROUNDING_ABSORBERS = ["down_payment", "monthly", "on_delivery"] as const;

export const paymentPlans = sqliteTable("payment_plans", {
  id: id(),
  tenantId: tenantId(),
  // null = aplica a todos los desarrollos del tenant
  developmentId: text("development_id").references(() => developments.id),
  name: text("name").notNull(),
  calculationType: text("calculation_type", { enum: CALCULATION_TYPES }).notNull().default("with_interest"),
  // list_price = precio total del lote; total_m2 = precio/m² × superficie (descuento por m²)
  listPriceType: text("list_price_type", { enum: ["list_price", "total_m2"] }).notNull().default("list_price"),
  discountType: text("discount_type", { enum: VALUE_TYPES }).notNull().default("percentage"),
  discountBp: integer("discount_bp").notNull().default(0),
  // Con list_price_type=total_m2 es descuento POR m²; si no, sobre el total.
  discountFixedCents: integer("discount_fixed_cents").notNull().default(0),
  reservationCents: integer("reservation_cents").notNull().default(0),
  openingFeeCents: integer("opening_fee_cents").notNull().default(0),
  downPaymentType: text("down_payment_type", { enum: VALUE_TYPES }).notNull().default("percentage"),
  downPaymentBp: integer("down_payment_bp").notNull().default(0),
  downPaymentFixedCents: integer("down_payment_fixed_cents").notNull().default(0),
  downPaymentInstallments: integer("down_payment_installments").notNull().default(1),
  // Plazo (with_interest) o número de mensualidades (on_delivery).
  months: integer("months").notNull().default(0),
  annualInterestBp: integer("annual_interest_bp").notNull().default(0),
  monthlyType: text("monthly_type", { enum: VALUE_TYPES }).notNull().default("percentage"),
  monthlyBp: integer("monthly_bp").notNull().default(0),
  monthlyFixedCents: integer("monthly_fixed_cents").notNull().default(0),
  onDeliveryType: text("on_delivery_type", { enum: VALUE_TYPES }).notNull().default("percentage"),
  onDeliveryBp: integer("on_delivery_bp").notNull().default(0),
  onDeliveryFixedCents: integer("on_delivery_fixed_cents").notNull().default(0),
  onDeliveryInstallments: integer("on_delivery_installments").notNull().default(1),
  roundingAbsorber: text("rounding_absorber", { enum: ROUNDING_ABSORBERS }),
  deliveryDate: text("delivery_date"), // YYYY-MM-DD
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const PROSPECT_STAGES = [
  "new",
  "qualified",
  "appointment",
  "visited",
  "negotiation",
  "ready_to_buy",
  "reserved",
  "won",
  "lost",
] as const;

export const prospects = sqliteTable(
  "prospects",
  {
    id: id(),
    tenantId: tenantId(),
    phone: text("phone").notNull(), // wa_id: solo dígitos con lada país
    name: text("name"),
    profileName: text("profile_name"),
    email: text("email"),
    stage: text("stage", { enum: PROSPECT_STAGES }).notNull().default("new"),
    score: integer("score").notNull().default(0),
    budgetCents: integer("budget_cents"),
    assignedUserId: text("assigned_user_id"),
    assignedAt: integer("assigned_at"),
    reassignCount: integer("reassign_count").notNull().default(0),
    // Calificación (la IA extrae los datos con la tool actualizar_prospecto; el score lo calcula el código).
    city: text("city"),
    purpose: text("purpose", { enum: ["vivienda", "inversion", "otro"] }),
    downPaymentCents: integer("down_payment_cents"),
    timeframe: text("timeframe", { enum: ["inmediato", "1-3_meses", "3-6_meses", "mas_6_meses", "explorando"] }),
    interestDevelopmentId: text("interest_development_id").references(() => developments.id),
    // Traspaso a un asesor humano (intención de compra, descuentos, temas legales, pagos, quejas, documentos).
    handoffAt: integer("handoff_at"),
    handoffReason: text("handoff_reason"),
    source: text("source", { enum: ["whatsapp", "simulator"] }).notNull().default("whatsapp"),
    // Privacidad (LFPDPPP). Aviso mostrado en el primer mensaje; consentimiento EXPRESO para datos
    // financieros/patrimoniales (presupuesto, enganche): sin él no se guardan, quedan en pending_financial.
    privacyNoticeAt: integer("privacy_notice_at"),
    consentRequestedAt: integer("consent_requested_at"),
    consentAt: integer("consent_at"),
    consentDeniedAt: integer("consent_denied_at"),
    consentText: text("consent_text"), // lo que respondió el prospecto (evidencia)
    pendingFinancial: text("pending_financial", { mode: "json" }).$type<{ budgetCents?: number; downPaymentCents?: number }>(),
    optedOutAt: integer("opted_out_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("prospects_tenant_phone_uq").on(t.tenantId, t.phone)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: id(),
    tenantId: tenantId(),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => prospects.id),
    waAccountId: text("wa_account_id")
      .notNull()
      .references(() => waAccounts.id),
    // Cuando un vendedor toma la conversación, la IA no responde.
    aiPaused: integer("ai_paused", { mode: "boolean" }).notNull().default(false),
    takenByUserId: text("taken_by_user_id").references(() => users.id),
    takenAt: integer("taken_at"),
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversations_prospect_account_uq").on(t.prospectId, t.waAccountId)],
);

// Los acuses de Meta pueden llegar desordenados; status_rank impide retroceder (read no lo pisa sent).
export const MESSAGE_STATUS_RANK = {
  received: 0,
  simulated: 0, // respuesta del simulador o de un entorno sin credenciales de Meta
  accepted: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4,
} as const;
export type MessageStatus = keyof typeof MESSAGE_STATUS_RANK;

export const messages = sqliteTable(
  "messages",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    wamid: text("wamid").notNull().unique(), // dedupe de reintentos de Meta
    direction: text("direction", { enum: ["in", "out"] }).notNull(),
    author: text("author", { enum: ["prospect", "ai", "user", "system"] }).notNull(),
    type: text("type").notNull(),
    body: text("body"),
    mediaId: text("media_id"),
    mediaMime: text("media_mime"),
    status: text("status").$type<MessageStatus>().notNull(),
    statusRank: integer("status_rank").notNull(),
    error: text("error"),
    waTimestamp: integer("wa_timestamp"),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    tenantId: tenantId(),
    actor: text("actor").notNull(), // system | ai | user:<id>
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    data: text("data", { mode: "json" }),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("audit_entity_idx").on(t.tenantId, t.entity, t.entityId)],
);

// ── Usuarios y sesiones ─────────────────────────────────────────────────────────
// admin = equipo Ignia (sin tenant, ve todas las desarrolladoras).
// owner/manager administran el inventario; seller consulta y cotiza.
export const USER_ROLES = ["admin", "owner", "manager", "seller"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = sqliteTable(
  "users",
  {
    id: id(),
    // null solo para role=admin
    tenantId: text("tenant_id").references(() => tenants.id),
    email: text("email").notNull(), // siempre en minúsculas
    name: text("name").notNull(),
    // pbkdf2-sha256$<iteraciones>$<sal b64>$<hash b64>
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: USER_ROLES }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    // Vendedores: si recibe prospectos nuevos en el reparto (false = vacaciones, saturado…).
    receivesLeads: integer("receives_leads", { mode: "boolean" }).notNull().default(true),
    lastAssignedAt: integer("last_assigned_at"),
    lastLoginAt: integer("last_login_at"),
    // Contraseña temporal (alta o restablecimiento desde el panel): hay que cambiarla al entrar.
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
    passwordChangedAt: integer("password_changed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    // SHA-256 del token de la cookie: si se filtra la tabla, los tokens no sirven.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: createdAt(),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// Intentos fallidos de login, para bloquear fuerza bruta por correo.
export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("login_attempts_email_idx").on(t.email, t.createdAt)],
);

// Bitácora de cada respuesta del agente: qué entró, qué herramientas usó, qué bloqueó el validador y qué salió.
export const aiAuditLog = sqliteTable(
  "ai_audit_log",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    input: text("input").notNull(), // mensajes del prospecto que dispararon la respuesta
    toolCalls: text("tool_calls", { mode: "json" }).$type<unknown[]>().notNull(),
    draft: text("draft"), // última respuesta del modelo antes de validar
    reply: text("reply").notNull(), // lo que se envió
    blocked: text("blocked", { mode: "json" }).$type<string[]>().notNull(),
    escalation: text("escalation"),
    fallback: integer("fallback", { mode: "boolean" }).notNull().default(false),
    neurons: real("neurons").notNull().default(0),
    latencyMs: integer("latency_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_audit_conversation_idx").on(t.conversationId, t.createdAt)],
);

// Notas del equipo sobre un prospecto (no las ve el prospecto).
export const prospectNotes = sqliteTable(
  "prospect_notes",
  {
    id: id(),
    tenantId: tenantId(),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("prospect_notes_prospect_idx").on(t.prospectId, t.createdAt)],
);

// Avisos para el equipo (p. ej. "quiere comprar"). userId null = para todo el equipo de la desarrolladora.
export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    tenantId: tenantId(),
    userId: text("user_id").references(() => users.id),
    prospectId: text("prospect_id").references(() => prospects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["handoff", "assignment", "appointment", "reservation", "system"] }).notNull(),
    title: text("title").notNull(),
    body: text("body"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_tenant_idx").on(t.tenantId, t.createdAt)],
);

// Qué avisos leyó cada usuario (un aviso de equipo lo lee cada quien por separado).
export const notificationReads = sqliteTable(
  "notification_reads",
  {
    notificationId: text("notification_id")
      .notNull()
      .references(() => notifications.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readAt: integer("read_at").notNull(),
  },
  (t) => [uniqueIndex("notification_reads_uq").on(t.notificationId, t.userId)],
);

// ── Agenda de citas ───────────────────────────────────────────────────────────

// Horario semanal en que un vendedor recibe visitas (hora local de la desarrolladora).
export const availabilityRules = sqliteTable(
  "availability_rules",
  {
    id: id(),
    tenantId: tenantId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(), // 0 = domingo … 6 = sábado
    startMinute: integer("start_minute").notNull(), // minutos desde la medianoche
    endMinute: integer("end_minute").notNull(),
  },
  (t) => [index("availability_user_idx").on(t.userId, t.weekday)],
);

export const APPOINTMENT_STATUSES = ["scheduled", "completed", "no_show", "cancelled"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointments = sqliteTable(
  "appointments",
  {
    id: id(),
    tenantId: tenantId(),
    prospectId: text("prospect_id")
      .notNull()
      .references(() => prospects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    developmentId: text("development_id").references(() => developments.id),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    status: text("status", { enum: APPOINTMENT_STATUSES }).notNull().default("scheduled"),
    source: text("source", { enum: ["ai", "user"] }).notNull(),
    notes: text("notes"),
    cancelReason: text("cancel_reason"),
    // Aviso interno al vendedor antes de la cita (cron). Los recordatorios al prospecto van por WhatsApp (Fase 2).
    sellerRemindedAt: integer("seller_reminded_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Un vendedor no puede tener dos citas vigentes a la misma hora: lo garantiza la base, no solo el código.
    uniqueIndex("appointments_user_start_uq").on(t.userId, t.startsAt).where(sql`status = 'scheduled'`),
    index("appointments_tenant_start_idx").on(t.tenantId, t.startsAt),
    index("appointments_prospect_idx").on(t.prospectId),
  ],
);

// ── Base de conocimiento ──────────────────────────────────────────────────────
// Textos aprobados por la desarrolladora que la IA puede citar (servicios, proceso de compra, requisitos,
// formas de pago aceptadas…). La búsqueda usa el índice de texto completo `kb_fts` (FTS5, ver migración 0007).

export const KB_CATEGORIES = ["desarrollo", "compra", "pagos", "construccion", "oficina", "general"] as const;

export const kbArticles = sqliteTable(
  "kb_articles",
  {
    id: id(),
    tenantId: tenantId(),
    // null = aplica a toda la desarrolladora
    developmentId: text("development_id").references(() => developments.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // Cómo lo preguntan los prospectos ("luz, electricidad, CFE"): mejora la búsqueda.
    keywords: text("keywords"),
    category: text("category", { enum: KB_CATEGORIES }).notNull().default("general"),
    // Solo lo aprobado lo ve la IA.
    status: text("status", { enum: ["draft", "approved"] }).notNull().default("draft"),
    approvedByUserId: text("approved_by_user_id").references(() => users.id),
    approvedAt: integer("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("kb_tenant_status_idx").on(t.tenantId, t.status)],
);
