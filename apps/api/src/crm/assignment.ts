import { and, eq, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Principal } from "../auth/middleware";
import type { Db } from "../db/client";
import { conversations, notifications, prospects, tenants, users } from "../db/schema";
import { auditInsert } from "../lib/audit";

// Asignación de prospectos a vendedores y alcance de lo que cada quien puede ver.

export const MAX_REASSIGNMENTS = 2;

/** Lo que un vendedor puede ver: solo sus prospectos. Gerente, dueño, admin y automatización ven todo. */
export function prospectScope(p: Principal) {
  return p.kind === "user" && p.user.role === "seller" ? eq(prospects.assignedUserId, p.user.id) : undefined;
}

export const isSeller = (p: Principal) => p.kind === "user" && p.user.role === "seller";

/**
 * Siguiente vendedor en turno: el que lleva más tiempo sin recibir prospecto.
 * Una sola sentencia (UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING): atómica en D1, así dos
 * prospectos simultáneos no se reparten con el mismo "último asignado".
 */
export async function takeNextSeller(db: Db, tenantId: string, now: number, excludeUserId?: string | null) {
  return db.get<{ id: string; name: string } | undefined>(sql`
    UPDATE users SET last_assigned_at = ${now}
    WHERE id = (
      SELECT id FROM users
      WHERE tenant_id = ${tenantId} AND role = 'seller' AND active = 1 AND receives_leads = 1
        ${excludeUserId ? sql`AND id <> ${excludeUserId}` : sql``}
      ORDER BY last_assigned_at ASC NULLS FIRST, created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING id, name`);
}

type AssignInput = {
  tenantId: string;
  prospectId: string;
  userId: string | null;
  actor: string;
  action: "assigned" | "reassigned" | "unassigned";
  reason?: string;
  incrementReassign?: boolean;
  notify?: boolean;
};

/** Asigna (o desasigna) con auditoría y aviso al vendedor, en una transacción. */
export async function assignProspect(db: Db, input: AssignInput) {
  const now = Date.now();
  const prospect = await db.select().from(prospects).where(eq(prospects.id, input.prospectId)).get();
  if (!prospect) return null;
  const who = prospect.name ?? prospect.profileName ?? "Un prospecto";
  const [updated] = await db.batch([
    db
      .update(prospects)
      .set({
        assignedUserId: input.userId,
        assignedAt: input.userId ? now : null,
        ...(input.incrementReassign ? { reassignCount: sql`${prospects.reassignCount} + 1` } : {}),
        updatedAt: now,
      })
      .where(eq(prospects.id, input.prospectId))
      .returning(),
    auditInsert(db, {
      tenantId: input.tenantId,
      actor: input.actor,
      entity: "prospect",
      entityId: input.prospectId,
      action: input.action,
      data: { from: prospect.assignedUserId, to: input.userId, ...(input.reason ? { reason: input.reason } : {}) },
    }),
    ...(input.userId && input.notify !== false
      ? [
          db.insert(notifications).values({
            tenantId: input.tenantId,
            userId: input.userId,
            prospectId: input.prospectId,
            kind: "assignment",
            title: input.action === "reassigned" ? `Se te reasignó: ${who}` : `Nuevo prospecto asignado: ${who}`,
            body: input.reason ?? null,
            createdAt: now,
          }),
        ]
      : []),
  ]);
  return updated[0] ?? null;
}

/** Al crear un prospecto: si la desarrolladora reparte en turno y no tiene vendedor, se le asigna uno. */
export async function autoAssignIfNeeded(db: Db, tenantId: string, prospectId: string): Promise<string | null> {
  const row = await db
    .select({ mode: tenants.assignmentMode, assigned: prospects.assignedUserId })
    .from(prospects)
    .innerJoin(tenants, eq(tenants.id, prospects.tenantId))
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .get();
  if (!row || row.assigned || row.mode !== "round_robin") return row?.assigned ?? null;
  const seller = await takeNextSeller(db, tenantId, Date.now());
  if (!seller) return null; // sin vendedores disponibles: queda para el gerente
  await assignProspect(db, { tenantId, prospectId, userId: seller.id, actor: "system", action: "assigned", reason: "Reparto en turno" });
  return seller.id;
}

/**
 * Cron: prospectos que pidieron asesor (handoff) y cuyo vendedor no tomó la conversación a tiempo
 * pasan al siguiente vendedor (hasta MAX_REASSIGNMENTS veces).
 */
export async function reassignStale(db: Db, now = Date.now()) {
  const reassigned: { prospectId: string; from: string; to: string }[] = [];
  const configs = await db.select({ id: tenants.id, minutes: tenants.reassignAfterMinutes }).from(tenants).where(sql`${tenants.reassignAfterMinutes} > 0`);
  for (const t of configs) {
    const cutoff = now - t.minutes * 60_000;
    const stale = await db
      .select({ id: prospects.id, assignedUserId: prospects.assignedUserId })
      .from(prospects)
      .leftJoin(conversations, eq(conversations.prospectId, prospects.id))
      .where(
        and(
          eq(prospects.tenantId, t.id),
          isNotNull(prospects.handoffAt),
          isNotNull(prospects.assignedUserId),
          lte(prospects.handoffAt, cutoff),
          lte(prospects.assignedAt, cutoff),
          lt(prospects.reassignCount, MAX_REASSIGNMENTS),
          notInArray(prospects.stage, ["won", "lost"]),
          // Nadie tomó la conversación después de que pidió asesor.
          or(isNull(conversations.takenAt), lt(conversations.takenAt, prospects.handoffAt)),
        ),
      )
      .limit(50);
    for (const p of stale) {
      const next = await takeNextSeller(db, t.id, now, p.assignedUserId);
      if (!next) continue;
      await assignProspect(db, {
        tenantId: t.id,
        prospectId: p.id,
        userId: next.id,
        actor: "system",
        action: "reassigned",
        reason: `Sin atención en ${t.minutes} min`,
        incrementReassign: true,
      });
      reassigned.push({ prospectId: p.id, from: p.assignedUserId!, to: next.id });
    }
  }
  return reassigned;
}

/** Usuarios activos de la desarrolladora (para selector de asignación y equipo). */
export function tenantUsers(db: Db, tenantId: string) {
  return db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active, receivesLeads: users.receivesLeads, lastAssignedAt: users.lastAssignedAt })
    .from(users)
    .where(eq(users.tenantId, tenantId))
    .orderBy(users.name);
}
