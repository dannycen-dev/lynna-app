import { and, asc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { developments, lots, notifications, paymentPlans, prospects, tenants, type LotStatus } from "../db/schema";
import { simulatePlan, type Simulation } from "../financing";
import { auditInsert } from "../lib/audit";

// Reglas de inventario compartidas por la API de administración y por las tools de la IA (Fase 3).
// La IA SOLO usa las funciones de lectura; los cambios de estado son siempre de un humano.

export class CatalogError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_transition" | "not_available",
    message: string,
  ) {
    super(message);
  }
}

export type LotSearch = {
  developmentId?: string;
  maxPriceCents?: number;
  minAreaM2?: number;
  block?: string;
  limit?: number;
};

/** Lotes disponibles en este momento (consulta en vivo; nunca cachear para la IA). */
export async function searchAvailableLots(db: Db, tenantId: string, q: LotSearch = {}) {
  return db
    .select()
    .from(lots)
    .where(
      and(
        eq(lots.tenantId, tenantId),
        eq(lots.status, "available"),
        q.developmentId ? eq(lots.developmentId, q.developmentId) : undefined,
        q.maxPriceCents !== undefined ? lte(lots.totalPriceCents, q.maxPriceCents) : undefined,
        q.minAreaM2 !== undefined ? gte(lots.areaM2, q.minAreaM2) : undefined,
        q.block ? eq(lots.block, q.block) : undefined,
      ),
    )
    .orderBy(asc(lots.totalPriceCents), asc(lots.block), asc(lots.number))
    .limit(Math.min(q.limit ?? 20, 100));
}

export async function getLot(db: Db, tenantId: string, lotId: string) {
  return db
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
    .get();
}

/** Planes activos aplicables a un desarrollo (los propios + los generales del tenant). */
export async function plansForDevelopment(db: Db, tenantId: string, developmentId: string) {
  return db
    .select()
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.tenantId, tenantId),
        eq(paymentPlans.active, true),
        or(isNull(paymentPlans.developmentId), eq(paymentPlans.developmentId, developmentId)),
      ),
    )
    .orderBy(asc(paymentPlans.name));
}

/** Simulación informativa de un plan para un lote. Solo lotes disponibles y planes aplicables. */
export async function simulateForLot(
  db: Db,
  tenantId: string,
  input: { lotId: string; planId: string; quoteDate: string },
): Promise<Simulation & { lot: typeof lots.$inferSelect; plan: typeof paymentPlans.$inferSelect }> {
  const lot = await getLot(db, tenantId, input.lotId);
  if (!lot) throw new CatalogError("not_found", "Lote no encontrado.");
  if (lot.status !== "available") throw new CatalogError("not_available", "El lote no está disponible.");

  const plan = (await plansForDevelopment(db, tenantId, lot.developmentId)).find((p) => p.id === input.planId);
  if (!plan) throw new CatalogError("not_found", "Plan de pago no encontrado o no aplica a este desarrollo.");

  return { ...simulatePlan(plan, lot, input.quoteDate), lot, plan };
}

export type StatusChange = {
  status: LotStatus;
  reason: string;
  /** Obligatorio al apartar: epoch ms en el futuro. */
  reservedUntil?: number;
  /** Al apartar: para qué prospecto (se le avisa a su vendedor y el prospecto pasa a "Apartado"). */
  prospectId?: string | null;
};

const STAGE_RANK = ["new", "qualified", "appointment", "visited", "negotiation", "ready_to_buy", "reserved", "won"];

/** Cambio de estado hecho por un humano (actor), con auditoría en la misma transacción. */
export async function changeLotStatus(db: Db, tenantId: string, lotId: string, change: StatusChange, actor: string) {
  const lot = await getLot(db, tenantId, lotId);
  if (!lot) throw new CatalogError("not_found", "Lote no encontrado.");
  if (change.status === "reserved" && (!change.reservedUntil || change.reservedUntil <= Date.now())) {
    throw new CatalogError("invalid_transition", "Para apartar se requiere una fecha de vencimiento futura.");
  }
  if (lot.status === change.status && change.status !== "reserved") {
    throw new CatalogError("invalid_transition", `El lote ya está en estado ${change.status}.`);
  }
  const reserving = change.status === "reserved";
  const prospect =
    reserving && change.prospectId
      ? await db.select({ id: prospects.id, stage: prospects.stage }).from(prospects).where(and(eq(prospects.id, change.prospectId), eq(prospects.tenantId, tenantId))).get()
      : undefined;
  if (reserving && change.prospectId && !prospect) throw new CatalogError("not_found", "Prospecto no encontrado.");

  const reservedUntil = reserving ? change.reservedUntil! : null;
  const now = Date.now();
  // El prospecto avanza a "Apartado" (si no estaba ya más adelante).
  const advance = prospect && prospect.stage !== "lost" && STAGE_RANK.indexOf(prospect.stage) < STAGE_RANK.indexOf("reserved");
  const [updated] = await db.batch([
    db
      .update(lots)
      .set({
        status: change.status,
        reservedUntil,
        reservedByUserId: reserving && actor.startsWith("user:") ? actor.slice(5) : null,
        reservedForProspectId: reserving ? (prospect?.id ?? null) : null,
        reservationWarnedAt: null,
        updatedAt: now,
      })
      .where(eq(lots.id, lot.id))
      .returning(),
    auditInsert(db, {
      tenantId,
      actor,
      entity: "lot",
      entityId: lot.id,
      action: "status_change",
      data: { from: lot.status, to: change.status, reason: change.reason, reservedUntil, ...(prospect ? { prospectId: prospect.id } : {}) },
    }),
    ...(advance
      ? [
          db.update(prospects).set({ stage: "reserved", updatedAt: now }).where(eq(prospects.id, prospect.id)),
          auditInsert(db, {
            tenantId,
            actor,
            entity: "prospect",
            entityId: prospect.id,
            action: "stage_change",
            data: { from: prospect.stage, to: "reserved", reason: `Apartó Manzana ${lot.block}, lote ${lot.number}` },
          }),
        ]
      : []),
  ]);
  return updated[0]!;
}

/** Cron: libera apartados vencidos. Devuelve los lotes liberados. */
/** Apartados vigentes o vencidos, con lo necesario para avisar (quién apartó, para quién, zona horaria). */
function reservationRows(db: Db) {
  return db
    .select({
      id: lots.id,
      tenantId: lots.tenantId,
      block: lots.block,
      number: lots.number,
      reservedUntil: lots.reservedUntil,
      reservedByUserId: lots.reservedByUserId,
      prospectId: lots.reservedForProspectId,
      prospectName: sql<string | null>`coalesce(${prospects.name}, ${prospects.profileName})`,
      sellerId: prospects.assignedUserId,
      timezone: tenants.timezone,
    })
    .from(lots)
    .innerJoin(tenants, eq(tenants.id, lots.tenantId))
    .leftJoin(prospects, eq(prospects.id, lots.reservedForProspectId));
}

type ReservationRow = {
  id: string;
  tenantId: string;
  block: string;
  number: string;
  reservedUntil: number | null;
  reservedByUserId: string | null;
  prospectId: string | null;
  prospectName: string | null;
  sellerId: string | null;
  timezone: string;
};

/** Avisos para quien apartó y para el vendedor del prospecto; si no hay nadie, para todo el equipo. */
function reservationNotices(db: Db, r: ReservationRow, title: string, body: string, now: number) {
  const recipients = [...new Set([r.reservedByUserId, r.sellerId].filter((x): x is string => Boolean(x)))];
  return (recipients.length ? recipients : [null]).map((userId) =>
    db.insert(notifications).values({ tenantId: r.tenantId, userId, prospectId: r.prospectId, kind: "reservation", title, body, createdAt: now }),
  );
}

const when = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

/** Cron: libera los apartados vencidos (el lote vuelve a "disponible" y la IA lo puede ofrecer) y avisa. */
export async function releaseExpiredReservations(db: Db, now = Date.now()) {
  const expired = await reservationRows(db).where(and(eq(lots.status, "reserved"), lt(lots.reservedUntil, now)));
  if (expired.length === 0) return [];

  await db.batch([
    db
      .update(lots)
      .set({ status: "available", reservedUntil: null, reservedByUserId: null, reservedForProspectId: null, reservationWarnedAt: null, updatedAt: now })
      // Misma condición que el SELECT (sin lista de IDs: D1 limita a 100 parámetros por consulta).
      .where(and(eq(lots.status, "reserved"), lt(lots.reservedUntil, now))),
    ...expired.flatMap((l) => [
      auditInsert(db, {
        tenantId: l.tenantId,
        actor: "system",
        entity: "lot",
        entityId: l.id,
        action: "reservation_expired",
        data: { reservedUntil: l.reservedUntil, prospectId: l.prospectId },
      }),
      ...reservationNotices(
        db,
        l,
        `Se liberó el apartado: Manzana ${l.block}, lote ${l.number}`,
        `${l.prospectName ? `Era para ${l.prospectName}. ` : ""}Venció el ${when(l.reservedUntil!, l.timezone)}. Ya está disponible y la IA lo puede ofrecer.`,
        now,
      ),
    ]),
  ]);
  return expired;
}

/** Cron: avisa una vez, 24 h antes, de los apartados que están por vencer (para extenderlos si sigue el trámite). */
export async function warnExpiringReservations(db: Db, now = Date.now()) {
  const soon = await reservationRows(db).where(
    and(eq(lots.status, "reserved"), gte(lots.reservedUntil, now), lte(lots.reservedUntil, now + 24 * 60 * 60 * 1000), isNull(lots.reservationWarnedAt)),
  );
  for (const l of soon) {
    await db.batch([
      db.update(lots).set({ reservationWarnedAt: now }).where(eq(lots.id, l.id)),
      ...reservationNotices(
        db,
        l,
        `Vence pronto el apartado: Manzana ${l.block}, lote ${l.number}`,
        `${l.prospectName ? `Es para ${l.prospectName}. ` : ""}Vence el ${when(l.reservedUntil!, l.timezone)}. Si el trámite sigue, extiéndelo en Inventario.`,
        now,
      ),
    ]);
  }
  return soon.length;
}

export async function getDevelopmentBySlug(db: Db, tenantId: string, slug: string) {
  return db
    .select()
    .from(developments)
    .where(and(eq(developments.tenantId, tenantId), eq(developments.slug, slug)))
    .get();
}
