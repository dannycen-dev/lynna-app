import { and, asc, desc, eq, gte, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { canSendWhatsApp } from "../agent/respond";
import { actorOf, type AuthVariables, type Principal } from "../auth/middleware";
import { assignProspect, isSeller, prospectScope, tenantUsers } from "../crm/assignment";
import { getDb, type Db } from "../db/client";
import {
  aiAuditLog,
  auditLog,
  conversations,
  MESSAGE_STATUS_RANK,
  messages,
  notificationReads,
  notifications,
  PROSPECT_STAGES,
  prospectNotes,
  prospects,
  tenants,
  users,
  waAccounts,
} from "../db/schema";
import { auditInsert } from "../lib/audit";
import { log } from "../lib/log";
import { isWithinServiceWindow, sendText } from "../whatsapp/client";

// CRM del panel: ficha del prospecto, etapas, notas, toma de conversación por un asesor y avisos.

type AppEnv = { Bindings: Env; Variables: AuthVariables & { tenant: typeof tenants.$inferSelect } };
export const crm = new Hono<AppEnv>();

/** userId de la persona con sesión (null si es el token de automatización). */
const userIdOf = (c: { var: AuthVariables }) => (c.var.principal.kind === "user" ? c.var.principal.user.id : null);

async function readBody<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) {
  return schema.safeParse(await c.req.json().catch(() => null));
}

/** Prospecto visible para quien pregunta (un vendedor solo los suyos; si no, 404). */
async function loadProspect(db: Db, tenantId: string, prospectId: string, principal: Principal) {
  return db
    .select()
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId), prospectScope(principal)))
    .get();
}

// ── Ficha del prospecto ───────────────────────────────────────────────────────

crm.get("/prospects/:id", async (c) => {
  const db = getDb(c.env.DB);
  const tenantId = c.var.tenant.id;
  const prospect = await loadProspect(db, tenantId, c.req.param("id"), c.var.principal);
  if (!prospect) return c.json({ error: "not_found" }, 404);

  const conversation = await db
    .select({ conversation: conversations, takenByName: users.name })
    .from(conversations)
    .leftJoin(users, eq(users.id, conversations.takenByUserId))
    .where(eq(conversations.prospectId, prospect.id))
    .orderBy(desc(conversations.lastInboundAt))
    .get();

  const [msgs, notes, history, lastAi] = await Promise.all([
    conversation
      ? db.select().from(messages).where(eq(messages.conversationId, conversation.conversation.id)).orderBy(asc(messages.createdAt)).limit(500)
      : Promise.resolve([]),
    db
      .select({ id: prospectNotes.id, body: prospectNotes.body, createdAt: prospectNotes.createdAt, authorName: users.name })
      .from(prospectNotes)
      .leftJoin(users, eq(users.id, prospectNotes.authorUserId))
      .where(eq(prospectNotes.prospectId, prospect.id))
      .orderBy(desc(prospectNotes.createdAt)),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), or(eq(auditLog.entityId, prospect.id), conversation ? eq(auditLog.entityId, conversation.conversation.id) : sql`0`)))
      .orderBy(desc(auditLog.createdAt))
      .limit(100),
    conversation
      ? db.select().from(aiAuditLog).where(eq(aiAuditLog.conversationId, conversation.conversation.id)).orderBy(desc(aiAuditLog.createdAt)).limit(1).get()
      : Promise.resolve(undefined),
  ]);

  // Nombres de los actores "user:<id>" del historial.
  const actorIds = [...new Set(history.map((h) => h.actor).filter((a) => a.startsWith("user:")).map((a) => a.slice(5)))];
  const actorNames = actorIds.length
    ? Object.fromEntries((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, actorIds))).map((u) => [u.id, u.name]))
    : {};

  const assigned = prospect.assignedUserId
    ? await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, prospect.assignedUserId)).get()
    : undefined;

  return c.json({
    prospect: { ...prospect, assignedName: assigned?.name ?? null },
    conversation: conversation ? { ...conversation.conversation, takenByName: conversation.takenByName } : null,
    messages: msgs,
    notes,
    history: history.map((h) => ({
      ...h,
      actorName: h.actor === "ai" ? "IA" : h.actor === "system" ? "Sistema" : h.actor.startsWith("user:") ? (actorNames[h.actor.slice(5)] ?? "Usuario") : "Automatización",
    })),
    lastAi: lastAi ?? null,
  });
});

// ── Etapa ─────────────────────────────────────────────────────────────────────

const stageBody = z.object({ stage: z.enum(PROSPECT_STAGES), reason: z.string().trim().max(500).optional() });

crm.patch("/prospects/:id/stage", async (c) => {
  const parsed = await readBody(c, stageBody);
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const { stage, reason } = parsed.data;
  if (stage === "lost" && !reason) return c.json({ error: "validation", message: "Indica por qué se perdió." }, 400);

  const db = getDb(c.env.DB);
  const prospect = await loadProspect(db, c.var.tenant.id, c.req.param("id"), c.var.principal);
  if (!prospect) return c.json({ error: "not_found" }, 404);
  if (prospect.stage === stage) return c.json(prospect);

  const [updated] = await db.batch([
    db.update(prospects).set({ stage, updatedAt: Date.now() }).where(eq(prospects.id, prospect.id)).returning(),
    auditInsert(db, {
      tenantId: c.var.tenant.id,
      actor: actorOf(c.var.principal),
      entity: "prospect",
      entityId: prospect.id,
      action: "stage_change",
      data: { from: prospect.stage, to: stage, ...(reason ? { reason } : {}) },
    }),
  ]);
  return c.json(updated[0]);
});

// ── Notas ─────────────────────────────────────────────────────────────────────

crm.post("/prospects/:id/notes", async (c) => {
  const parsed = await readBody(c, z.object({ body: z.string().trim().min(1).max(4000) }));
  if (!parsed.success) return c.json({ error: "validation", message: "Escribe la nota." }, 400);
  const db = getDb(c.env.DB);
  const prospect = await loadProspect(db, c.var.tenant.id, c.req.param("id"), c.var.principal);
  if (!prospect) return c.json({ error: "not_found" }, 404);
  const [note] = await db
    .insert(prospectNotes)
    .values({ tenantId: c.var.tenant.id, prospectId: prospect.id, authorUserId: userIdOf(c), body: parsed.data.body })
    .returning();
  return c.json(note, 201);
});

// ── Tomar / devolver la conversación ────────────────────────────────────────────

async function loadConversation(db: Db, tenantId: string, conversationId: string, principal: Principal) {
  return db
    .select({ conversation: conversations, prospect: prospects, account: waAccounts })
    .from(conversations)
    .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
    .innerJoin(waAccounts, eq(waAccounts.id, conversations.waAccountId))
    .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId), prospectScope(principal)))
    .get();
}

async function setTakeover(c: Context<AppEnv>, take: boolean) {
  const db = getDb(c.env.DB);
  const row = await loadConversation(db, c.var.tenant.id, c.req.param("id") ?? "", c.var.principal);
  if (!row) return c.json({ error: "not_found" }, 404);
  const userId = userIdOf(c);
  const [updated] = await db.batch([
    db
      .update(conversations)
      .set(take ? { aiPaused: true, takenByUserId: userId, takenAt: Date.now() } : { aiPaused: false, takenByUserId: null, takenAt: null })
      .where(eq(conversations.id, row.conversation.id))
      .returning(),
    auditInsert(db, {
      tenantId: c.var.tenant.id,
      actor: actorOf(c.var.principal),
      entity: "conversation",
      entityId: row.conversation.id,
      action: take ? "taken_over" : "returned_to_ai",
    }),
  ]);
  return c.json(updated[0]);
}

crm.post("/conversations/:id/takeover", (c) => setTakeover(c, true));
crm.post("/conversations/:id/release", (c) => setTakeover(c, false));

// ── Respuesta de un asesor ──────────────────────────────────────────────────────

crm.post("/conversations/:id/messages", async (c) => {
  const parsed = await readBody(c, z.object({ body: z.string().trim().min(1).max(4000) }));
  if (!parsed.success) return c.json({ error: "validation", message: "Escribe el mensaje." }, 400);
  const db = getDb(c.env.DB);
  const row = await loadConversation(db, c.var.tenant.id, c.req.param("id"), c.var.principal);
  if (!row) return c.json({ error: "not_found" }, 404);
  const { conversation, prospect, account } = row;
  if (prospect.optedOutAt) return c.json({ error: "opted_out", message: "El prospecto pidió no recibir mensajes." }, 409);

  // Escribir como asesor implica tomar la conversación: la IA deja de responder.
  const userId = userIdOf(c);
  let status: "accepted" | "simulated" | "failed" = "simulated";
  let wamid = `sim.${crypto.randomUUID()}`;
  let error: string | null = null;

  if (prospect.source === "whatsapp" && canSendWhatsApp(c.env)) {
    if (!isWithinServiceWindow(conversation.lastInboundAt)) {
      return c.json(
        { error: "window_closed", message: "Pasaron más de 24 h desde el último mensaje del prospecto: solo se puede escribir con una plantilla aprobada." },
        409,
      );
    }
    try {
      ({ wamid } = await sendText(
        { accessToken: c.env.WHATSAPP_ACCESS_TOKEN, graphVersion: c.env.WHATSAPP_GRAPH_VERSION },
        account.phoneNumberId,
        prospect.phone,
        parsed.data.body,
      ));
      status = "accepted";
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message.slice(0, 300) : "Error al enviar";
      log("error", "crm.send_failed", { conversationId: conversation.id, error });
    }
  }

  const now = Date.now();
  const [inserted] = await db.batch([
    db
      .insert(messages)
      .values({
        tenantId: c.var.tenant.id,
        conversationId: conversation.id,
        wamid,
        direction: "out",
        author: "user",
        type: "text",
        body: parsed.data.body,
        status,
        statusRank: MESSAGE_STATUS_RANK[status],
        error,
        createdAt: now,
      })
      .returning(),
    db
      .update(conversations)
      .set({
        lastOutboundAt: now,
        ...(conversation.aiPaused ? {} : { aiPaused: true, takenByUserId: userId, takenAt: now }),
      })
      .where(eq(conversations.id, conversation.id)),
    ...(conversation.aiPaused
      ? []
      : [auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "conversation", entityId: conversation.id, action: "taken_over" })]),
  ]);
  if (status === "failed") return c.json({ error: "send_failed", message: "No se pudo enviar por WhatsApp.", message_record: inserted[0] }, 502);
  return c.json(inserted[0], 201);
});

// ── Avisos ────────────────────────────────────────────────────────────────────

/**
 * Avisos visibles (últimos 30 días): un vendedor solo los suyos; gerente/dueño/admin los suyos y
 * los de equipo (prospectos sin vendedor).
 */
function visibleTo(tenantId: string, principal: Principal) {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const userId = principal.kind === "user" ? principal.user.id : null;
  return and(
    eq(notifications.tenantId, tenantId),
    gte(notifications.createdAt, since),
    userId ? (isSeller(principal) ? eq(notifications.userId, userId) : or(isNull(notifications.userId), eq(notifications.userId, userId))) : undefined,
  );
}

crm.get("/notifications", async (c) => {
  const db = getDb(c.env.DB);
  const userId = userIdOf(c);
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      prospectId: notifications.prospectId,
      createdAt: notifications.createdAt,
      readAt: notificationReads.readAt,
    })
    .from(notifications)
    .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, userId ?? "")))
    .where(visibleTo(c.var.tenant.id, c.var.principal))
    .orderBy(desc(notifications.createdAt))
    .limit(30);
  const unread = userId
    ? await db.$count(
        notifications,
        and(
          visibleTo(c.var.tenant.id, c.var.principal),
          notExists(
            db
              .select({ one: sql`1` })
              .from(notificationReads)
              .where(and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, userId))),
          ),
        ),
      )
    : 0;
  return c.json({ unread, items: rows });
});

crm.post("/notifications/read", async (c) => {
  const userId = userIdOf(c);
  if (!userId) return c.json({ error: "not_a_user" }, 400);
  const parsed = await readBody(c, z.object({ ids: z.array(z.string()).max(100).optional() }));
  if (!parsed.success) return c.json({ error: "validation" }, 400);
  const db = getDb(c.env.DB);
  const targets = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(visibleTo(c.var.tenant.id, c.var.principal), parsed.data.ids?.length ? inArray(notifications.id, parsed.data.ids) : undefined))
    .limit(100);
  if (targets.length) {
    const now = Date.now();
    await db
      .insert(notificationReads)
      .values(targets.map((t) => ({ notificationId: t.id, userId, readAt: now })))
      .onConflictDoNothing();
  }
  return c.body(null, 204);
});

// ── Asignación, equipo y configuración ─────────────────────────────────────────

crm.patch("/prospects/:id/assign", async (c) => {
  if (isSeller(c.var.principal)) return c.json({ error: "forbidden", message: "Solo un gerente puede reasignar prospectos." }, 403);
  const parsed = await readBody(c, z.object({ userId: z.string().nullable(), reason: z.string().trim().max(300).optional() }));
  if (!parsed.success) return c.json({ error: "validation" }, 400);
  const db = getDb(c.env.DB);
  const prospect = await loadProspect(db, c.var.tenant.id, c.req.param("id"), c.var.principal);
  if (!prospect) return c.json({ error: "not_found" }, 404);
  if (parsed.data.userId) {
    const target = await db
      .select({ id: users.id, role: users.role, active: users.active })
      .from(users)
      .where(and(eq(users.id, parsed.data.userId), eq(users.tenantId, c.var.tenant.id)))
      .get();
    if (!target?.active) return c.json({ error: "validation", message: "Ese usuario no pertenece al equipo o está inactivo." }, 400);
  }
  if (prospect.assignedUserId === parsed.data.userId) return c.json(prospect);
  const updated = await assignProspect(db, {
    tenantId: c.var.tenant.id,
    prospectId: prospect.id,
    userId: parsed.data.userId,
    actor: actorOf(c.var.principal),
    action: parsed.data.userId ? (prospect.assignedUserId ? "reassigned" : "assigned") : "unassigned",
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
  });
  return c.json(updated);
});

crm.get("/team", async (c) => c.json(await tenantUsers(getDb(c.env.DB), c.var.tenant.id)));

crm.patch("/team/:userId", async (c) => {
  const parsed = await readBody(c, z.object({ receivesLeads: z.boolean() }));
  if (!parsed.success) return c.json({ error: "validation" }, 400);
  const db = getDb(c.env.DB);
  const [updated] = await db
    .update(users)
    .set({ receivesLeads: parsed.data.receivesLeads })
    .where(and(eq(users.id, c.req.param("userId")), eq(users.tenantId, c.var.tenant.id)))
    .returning({ id: users.id, receivesLeads: users.receivesLeads });
  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.json(updated);
});

crm.get("/settings/assignment", (c) =>
  c.json({ assignmentMode: c.var.tenant.assignmentMode, reassignAfterMinutes: c.var.tenant.reassignAfterMinutes }),
);

crm.patch("/settings/assignment", async (c) => {
  const parsed = await readBody(
    c,
    z.object({ assignmentMode: z.enum(["round_robin", "manual"]).optional(), reassignAfterMinutes: z.int().min(0).max(24 * 60).optional() }),
  );
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const db = getDb(c.env.DB);
  const [updated] = await db.batch([
    db.update(tenants).set(parsed.data).where(eq(tenants.id, c.var.tenant.id)).returning({ assignmentMode: tenants.assignmentMode, reassignAfterMinutes: tenants.reassignAfterMinutes }),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "tenant", entityId: c.var.tenant.id, action: "assignment_settings", data: parsed.data }),
  ]);
  return c.json(updated[0]);
});
