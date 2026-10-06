import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import { developments, LOT_STATUSES, lots, paymentPlans, tenants } from "../db/schema";

// Lectura del catálogo SOLO en local, para revisar el seed mientras no existe auth (Fase 4).
export const devCatalog = new Hono<{ Bindings: Env }>();

devCatalog.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT !== "local") return c.notFound();
  await next();
});

devCatalog.get("/tenants/:tenant/developments", async (c) => {
  const db = getDb(c.env.DB);
  const tenant = await db.select().from(tenants).where(eq(tenants.slug, c.req.param("tenant"))).get();
  if (!tenant) return c.notFound();
  const rows = await db.select().from(developments).where(eq(developments.tenantId, tenant.id));
  return c.json(rows);
});

const lotsQuery = z.object({ status: z.enum(LOT_STATUSES).optional() });

devCatalog.get("/tenants/:tenant/developments/:development", async (c) => {
  const query = lotsQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ error: query.error.issues }, 400);

  const db = getDb(c.env.DB);
  const dev = await db
    .select({ development: developments })
    .from(developments)
    .innerJoin(tenants, eq(tenants.id, developments.tenantId))
    .where(and(eq(tenants.slug, c.req.param("tenant")), eq(developments.slug, c.req.param("development"))))
    .get();
  if (!dev) return c.notFound();

  const devId = dev.development.id;
  const [lotRows, plans] = await Promise.all([
    db
      .select()
      .from(lots)
      .where(and(eq(lots.developmentId, devId), query.data.status ? eq(lots.status, query.data.status) : undefined))
      .orderBy(asc(lots.block), asc(lots.number)),
    db.select().from(paymentPlans).where(eq(paymentPlans.tenantId, dev.development.tenantId)),
  ]);
  return c.json({
    ...dev.development,
    paymentPlans: plans.filter((p) => p.developmentId === null || p.developmentId === devId),
    lots: lotRows,
  });
});
