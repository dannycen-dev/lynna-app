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

export const tenants = sqliteTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
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
    consentAt: integer("consent_at"),
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
    lastInboundAt: integer("last_inbound_at"),
    lastOutboundAt: integer("last_outbound_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("conversations_prospect_account_uq").on(t.prospectId, t.waAccountId)],
);

// Los acuses de Meta pueden llegar desordenados; status_rank impide retroceder (read no lo pisa sent).
export const MESSAGE_STATUS_RANK = {
  received: 0,
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
    lastLoginAt: integer("last_login_at"),
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
