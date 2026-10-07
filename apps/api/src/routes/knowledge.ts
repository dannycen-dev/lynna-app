import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, type AuthVariables } from "../auth/middleware";
import { getDb } from "../db/client";
import { developments, KB_CATEGORIES, kbArticles, tenants, users } from "../db/schema";
import { ftsQuery, searchKnowledge } from "../knowledge/search";
import { auditInsert } from "../lib/audit";

// Base de conocimiento en el panel. Gerente y dueño escriben y aprueban (el middleware de admin ya bloquea
// escrituras de vendedores); todos pueden consultar y probar qué encontraría la IA.

type AppEnv = { Bindings: Env; Variables: AuthVariables & { tenant: typeof tenants.$inferSelect } };
export const knowledge = new Hono<AppEnv>();

const userIdOf = (c: { var: AuthVariables }) => (c.var.principal.kind === "user" ? c.var.principal.user.id : null);

const articleBody = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(10).max(4000),
  keywords: z.string().trim().max(500).nullish(),
  category: z.enum(KB_CATEGORIES).default("general"),
  developmentId: z.string().min(1).nullish(),
  status: z.enum(["draft", "approved"]).default("draft"),
});

async function readBody<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) {
  return schema.safeParse(await c.req.json().catch(() => null));
}

async function developmentBelongs(c: { env: Env; var: { tenant: { id: string } } }, developmentId: string | null | undefined) {
  if (!developmentId) return true;
  const dev = await getDb(c.env.DB)
    .select({ id: developments.id })
    .from(developments)
    .where(and(eq(developments.id, developmentId), eq(developments.tenantId, c.var.tenant.id)))
    .get();
  return Boolean(dev);
}

knowledge.get("/knowledge", async (c) => {
  const rows = await getDb(c.env.DB)
    .select({ article: kbArticles, developmentName: developments.name, approvedByName: users.name })
    .from(kbArticles)
    .leftJoin(developments, eq(developments.id, kbArticles.developmentId))
    .leftJoin(users, eq(users.id, kbArticles.approvedByUserId))
    .where(eq(kbArticles.tenantId, c.var.tenant.id))
    .orderBy(asc(kbArticles.category), asc(kbArticles.title));
  return c.json(rows.map((r) => ({ ...r.article, developmentName: r.developmentName, approvedByName: r.approvedByName })));
});

// Lo que la IA encontraría con esta pregunta (solo artículos aprobados).
knowledge.get("/knowledge/search", async (c) => {
  const q = (c.req.query("q") ?? "").slice(0, 500);
  const hits = await searchKnowledge(getDb(c.env.DB), c.var.tenant.id, q, { approvedOnly: true, limit: 3 });
  return c.json({ query: ftsQuery(q), hits });
});

knowledge.post("/knowledge", async (c) => {
  const parsed = await readBody(c, articleBody);
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  if (!(await developmentBelongs(c, parsed.data.developmentId))) return c.json({ error: "validation", message: "Desarrollo no encontrado." }, 400);
  const db = getDb(c.env.DB);
  const now = Date.now();
  const id = crypto.randomUUID();
  const approved = parsed.data.status === "approved";
  await db.batch([
    db.insert(kbArticles).values({
      id,
      tenantId: c.var.tenant.id,
      ...parsed.data,
      keywords: parsed.data.keywords ?? null,
      developmentId: parsed.data.developmentId ?? null,
      approvedByUserId: approved ? userIdOf(c) : null,
      approvedAt: approved ? now : null,
      createdAt: now,
      updatedAt: now,
    }),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "kb_article", entityId: id, action: "created", data: { title: parsed.data.title, status: parsed.data.status } }),
  ]);
  return c.json(await db.select().from(kbArticles).where(eq(kbArticles.id, id)).get(), 201);
});

knowledge.patch("/knowledge/:id", async (c) => {
  const parsed = await readBody(c, articleBody.partial());
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  if (!(await developmentBelongs(c, parsed.data.developmentId))) return c.json({ error: "validation", message: "Desarrollo no encontrado." }, 400);
  const db = getDb(c.env.DB);
  const current = await db.select().from(kbArticles).where(and(eq(kbArticles.id, c.req.param("id")), eq(kbArticles.tenantId, c.var.tenant.id))).get();
  if (!current) return c.json({ error: "not_found" }, 404);
  const now = Date.now();
  const status = parsed.data.status ?? current.status;
  // Quien edita un texto aprobado (o lo aprueba) queda como responsable de lo que la IA va a decir.
  const approval = status === "approved" ? { approvedByUserId: userIdOf(c), approvedAt: now } : { approvedByUserId: null, approvedAt: null };
  const [updated] = await db.batch([
    db
      .update(kbArticles)
      .set({ ...parsed.data, ...approval, updatedAt: now })
      .where(eq(kbArticles.id, current.id))
      .returning(),
    auditInsert(db, {
      tenantId: c.var.tenant.id,
      actor: actorOf(c.var.principal),
      entity: "kb_article",
      entityId: current.id,
      action: current.status !== status ? (status === "approved" ? "approved" : "unapproved") : "updated",
      data: { title: parsed.data.title ?? current.title, status },
    }),
  ]);
  return c.json(updated[0]);
});

knowledge.delete("/knowledge/:id", async (c) => {
  const db = getDb(c.env.DB);
  const current = await db.select().from(kbArticles).where(and(eq(kbArticles.id, c.req.param("id")), eq(kbArticles.tenantId, c.var.tenant.id))).get();
  if (!current) return c.json({ error: "not_found" }, 404);
  await db.batch([
    db.delete(kbArticles).where(eq(kbArticles.id, current.id)),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "kb_article", entityId: current.id, action: "deleted", data: { title: current.title } }),
  ]);
  return c.body(null, 204);
});
