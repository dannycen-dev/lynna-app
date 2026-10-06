import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { importLots, parseLotsCsv } from "../catalog/lots-import";
import { CatalogError, changeLotStatus, getDevelopmentBySlug, plansForDevelopment, simulateForLot } from "../catalog/service";
import { getDb } from "../db/client";
import {
  CALCULATION_TYPES,
  conversations,
  developments,
  LOT_STATUSES,
  lotMedia,
  lots,
  messages,
  paymentPlans,
  prospects,
  ROUNDING_ABSORBERS,
  tenants,
  VALUE_TYPES,
} from "../db/schema";
import { PlanError, todayIn, validatePlan } from "../financing";
import { requireAdminToken } from "../lib/admin-auth";
import { auditInsert } from "../lib/audit";
import { log } from "../lib/log";
import { deleteMedia, uploadMedia } from "./media";

// API de administración (operación de Ignia y, después, el panel). Auth provisional por token.
const ACTOR = "admin-token";

type Tenant = typeof tenants.$inferSelect;
type AppEnv = { Bindings: Env; Variables: { tenant: Tenant } };

export const admin = new Hono<AppEnv>();
admin.use("*", requireAdminToken);

admin.onError((err, c) => {
  if (err instanceof PlanError) return c.json({ error: "invalid_plan", message: err.message }, 422);
  if (err instanceof CatalogError) {
    return c.json({ error: err.code, message: err.message }, err.code === "not_found" ? 404 : 409);
  }
  log("error", "admin.unhandled", { path: c.req.path, error: err.message });
  return c.json({ error: "internal_error" }, 500);
});

admin.use("/tenants/:tenant/*", async (c, next) => {
  const tenant = await getDb(c.env.DB).select().from(tenants).where(eq(tenants.slug, c.req.param("tenant"))).get();
  if (!tenant) return c.json({ error: "not_found", message: "Tenant no encontrado." }, 404);
  c.set("tenant", tenant);
  await next();
});

/** Valida el JSON del cuerpo; devuelve los datos o una respuesta 400 lista para regresar. */
async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<{ data: z.output<T> } | { response: Response }> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { response: c.json({ error: "invalid_json" }, 400) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { response: c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400) };
  }
  return { data: parsed.data };
}

// ── Desarrollos ────────────────────────────────────────────────────────────────

const developmentBody = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "solo minúsculas, números y guiones"),
  description: z.string().max(4000).nullish(),
  address: z.string().max(300).nullish(),
  city: z.string().max(120).nullish(),
  state: z.string().max(120).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  amenities: z.array(z.string().max(120)).max(50).nullish(),
  status: z.enum(["active", "inactive"]).optional(),
});

admin.get("/tenants/:tenant/developments", async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(developments)
    .where(eq(developments.tenantId, c.var.tenant.id))
    .orderBy(asc(developments.name));
  return c.json(rows);
});

admin.post("/tenants/:tenant/developments", async (c) => {
  const body = await readJson(c, developmentBody);
  if ("response" in body) return body.response;
  const db = getDb(c.env.DB);
  if (await getDevelopmentBySlug(db, c.var.tenant.id, body.data.slug)) {
    return c.json({ error: "conflict", message: "Ya existe un desarrollo con ese slug." }, 409);
  }
  const [created] = await db.insert(developments).values({ ...body.data, tenantId: c.var.tenant.id }).returning();
  return c.json(created, 201);
});

admin.patch("/tenants/:tenant/developments/:development", async (c) => {
  const body = await readJson(c, developmentBody.partial().omit({ slug: true }));
  if ("response" in body) return body.response;
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);
  const [updated] = await db.update(developments).set(body.data).where(eq(developments.id, dev.id)).returning();
  return c.json(updated);
});

// ── Lotes ─────────────────────────────────────────────────────────────────────

admin.get("/tenants/:tenant/developments/:development/lots", async (c) => {
  const status = z.enum(LOT_STATUSES).optional().safeParse(c.req.query("status"));
  if (!status.success) return c.json({ error: "validation", message: "status inválido" }, 400);
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);
  const rows = await db
    .select()
    .from(lots)
    .where(and(eq(lots.developmentId, dev.id), status.data ? eq(lots.status, status.data) : undefined))
    .orderBy(asc(lots.block), asc(lots.number));
  return c.json(rows);
});

const MAX_CSV_BYTES = 2 * 1024 * 1024;

admin.post("/tenants/:tenant/developments/:development/lots/import", async (c) => {
  const dryRun = c.req.query("dryRun") === "true" || c.req.query("dryRun") === "1";
  if (Number(c.req.header("content-length") ?? 0) > MAX_CSV_BYTES) {
    return c.json({ error: "too_large", message: "El CSV no puede pasar de 2 MB." }, 413);
  }
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);

  const { rows, errors } = parseLotsCsv(await c.req.text());
  if (errors.length > 0) {
    return c.json({ error: "validation", dryRun, valid: false, errors }, dryRun ? 200 : 422);
  }
  const result = await importLots(db, { tenantId: c.var.tenant.id, developmentId: dev.id, actor: ACTOR }, rows, { dryRun });
  log("info", "admin.lots_import", { tenantId: c.var.tenant.id, developmentId: dev.id, dryRun, ...result });
  return c.json({ dryRun, valid: true, ...result });
});

const statusBody = z.object({
  status: z.enum(LOT_STATUSES),
  reason: z.string().trim().min(3, "indique el motivo").max(500),
  reservedUntil: z.iso.datetime({ offset: true }).optional(),
});

admin.patch("/tenants/:tenant/lots/:lotId/status", async (c) => {
  const body = await readJson(c, statusBody);
  if ("response" in body) return body.response;
  const { reservedUntil, ...rest } = body.data;
  const lot = await changeLotStatus(
    getDb(c.env.DB),
    c.var.tenant.id,
    c.req.param("lotId"),
    { ...rest, ...(reservedUntil ? { reservedUntil: Date.parse(reservedUntil) } : {}) },
    ACTOR,
  );
  return c.json(lot);
});

// ── Planes de pago ────────────────────────────────────────────────────────────

const planBody = z.object({
  name: z.string().trim().min(2).max(120),
  developmentId: z.string().nullish(),
  calculationType: z.enum(CALCULATION_TYPES),
  listPriceType: z.enum(["list_price", "total_m2"]).default("list_price"),
  discountType: z.enum(VALUE_TYPES).default("percentage"),
  discountBp: z.int().min(0).max(10_000).default(0),
  discountFixedCents: z.int().min(0).default(0),
  reservationCents: z.int().min(0).default(0),
  openingFeeCents: z.int().min(0).default(0),
  downPaymentType: z.enum(VALUE_TYPES).default("percentage"),
  downPaymentBp: z.int().min(0).max(10_000).default(0),
  downPaymentFixedCents: z.int().min(0).default(0),
  downPaymentInstallments: z.int().min(1).max(60).default(1),
  months: z.int().min(0).max(360).default(0),
  annualInterestBp: z.int().min(0).max(10_000).default(0),
  monthlyType: z.enum(VALUE_TYPES).default("percentage"),
  monthlyBp: z.int().min(0).max(10_000).default(0),
  monthlyFixedCents: z.int().min(0).default(0),
  onDeliveryType: z.enum(VALUE_TYPES).default("percentage"),
  onDeliveryBp: z.int().min(0).max(10_000).default(0),
  onDeliveryFixedCents: z.int().min(0).default(0),
  onDeliveryInstallments: z.int().min(1).max(60).default(1),
  roundingAbsorber: z.enum(ROUNDING_ABSORBERS).nullish(),
  deliveryDate: z.iso.date().nullish(),
  active: z.boolean().default(true),
});

admin.get("/tenants/:tenant/payment-plans", async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(paymentPlans)
    .where(eq(paymentPlans.tenantId, c.var.tenant.id))
    .orderBy(asc(paymentPlans.name));
  return c.json(rows);
});

admin.post("/tenants/:tenant/payment-plans", async (c) => {
  const body = await readJson(c, planBody);
  if ("response" in body) return body.response;
  const data = { ...body.data, roundingAbsorber: body.data.roundingAbsorber ?? null, deliveryDate: body.data.deliveryDate ?? null };
  validatePlan(data);
  const db = getDb(c.env.DB);
  if (data.developmentId) {
    const dev = await db
      .select({ id: developments.id })
      .from(developments)
      .where(and(eq(developments.id, data.developmentId), eq(developments.tenantId, c.var.tenant.id)))
      .get();
    if (!dev) return c.json({ error: "validation", message: "developmentId no pertenece al tenant." }, 400);
  }
  const [created] = await db.insert(paymentPlans).values({ ...data, tenantId: c.var.tenant.id }).returning();
  return c.json(created, 201);
});

// Los planes no se editan (una cotización ya emitida debe poder reproducirse): solo se activan/desactivan.
admin.patch("/tenants/:tenant/payment-plans/:planId", async (c) => {
  const body = await readJson(c, z.object({ active: z.boolean() }));
  if ("response" in body) return body.response;
  const db = getDb(c.env.DB);
  const [updated] = await db
    .update(paymentPlans)
    .set({ active: body.data.active })
    .where(and(eq(paymentPlans.id, c.req.param("planId")), eq(paymentPlans.tenantId, c.var.tenant.id)))
    .returning();
  if (!updated) return c.json({ error: "not_found" }, 404);
  await auditInsert(db, {
    tenantId: c.var.tenant.id,
    actor: ACTOR,
    entity: "payment_plan",
    entityId: updated.id,
    action: body.data.active ? "activated" : "deactivated",
  });
  return c.json(updated);
});

admin.post("/tenants/:tenant/simulate", async (c) => {
  const body = await readJson(c, z.object({ lotId: z.string(), planId: z.string(), quoteDate: z.iso.date().optional() }));
  if ("response" in body) return body.response;
  const sim = await simulateForLot(getDb(c.env.DB), c.var.tenant.id, {
    ...body.data,
    quoteDate: body.data.quoteDate ?? todayIn(),
  });
  return c.json({ lot: sim.lot, plan: { id: sim.plan.id, name: sim.plan.name }, breakdown: sim.breakdown, lines: sim.lines });
});

admin.get("/tenants/:tenant/developments/:development/payment-plans", async (c) => {
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);
  return c.json(await plansForDevelopment(db, c.var.tenant.id, dev.id));
});

// ── Prospectos (base del CRM de la Fase 4) ─────────────────────────────────────

admin.get("/tenants/:tenant/prospects", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: prospects.id,
      phone: prospects.phone,
      name: prospects.name,
      profileName: prospects.profileName,
      stage: prospects.stage,
      score: prospects.score,
      createdAt: prospects.createdAt,
      conversationId: conversations.id,
      aiPaused: conversations.aiPaused,
      lastInboundAt: conversations.lastInboundAt,
      messageCount: sql<number>`(SELECT count(*) FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id})`,
    })
    .from(prospects)
    .leftJoin(conversations, eq(conversations.prospectId, prospects.id))
    .where(eq(prospects.tenantId, c.var.tenant.id))
    .orderBy(desc(conversations.lastInboundAt))
    .limit(200);
  return c.json(rows);
});

admin.get("/tenants/:tenant/conversations/:conversationId/messages", async (c) => {
  const rows = await getDb(c.env.DB)
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, c.req.param("conversationId")), eq(messages.tenantId, c.var.tenant.id)))
    .orderBy(asc(messages.createdAt))
    .limit(500);
  return c.json(rows);
});

// ── Fotos, planos y folletos (R2) ─────────────────────────────────────────────

admin.get("/tenants/:tenant/developments/:development/media", async (c) => {
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);
  const rows = await db.select().from(lotMedia).where(eq(lotMedia.developmentId, dev.id)).orderBy(asc(lotMedia.sort));
  return c.json(rows);
});

admin.post("/tenants/:tenant/developments/:development/media", async (c) => {
  const db = getDb(c.env.DB);
  const dev = await getDevelopmentBySlug(db, c.var.tenant.id, c.req.param("development"));
  if (!dev) return c.json({ error: "not_found" }, 404);
  return uploadMedia(c, db, { tenantId: c.var.tenant.id, developmentId: dev.id, actor: ACTOR });
});

admin.delete("/tenants/:tenant/media/:mediaId", async (c) =>
  deleteMedia(c, getDb(c.env.DB), { tenantId: c.var.tenant.id, mediaId: c.req.param("mediaId"), actor: ACTOR }),
);
