import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { appointments, availabilityRules, notifications, prospects, tenants, users, type AppointmentStatus } from "../db/schema";
import type { BatchItem } from "drizzle-orm/batch";
import { addDays, parseIsoDate, todayIn } from "../financing/dates";
import { auditInsert } from "../lib/audit";

// Agenda de citas: horarios semanales por vendedor, horarios libres y reserva sin empalmes.
// Las horas de los vendedores son hora local de la desarrolladora (tenants.timezone); en la base todo es epoch ms.

/** No se ofrecen horarios que empiecen antes de esto (el vendedor necesita margen para prepararse). */
export const MIN_LEAD_MS = 2 * 60 * 60 * 1000;
/** Aviso interno al vendedor antes de la cita. */
export const SELLER_REMINDER_MS = 2 * 60 * 60 * 1000;

type Tenant = Pick<typeof tenants.$inferSelect, "id" | "timezone" | "appointmentMinutes">;

// ── Zona horaria ────────────────────────────────────────────────────────────────

/** Diferencia (ms) entre la hora local de `timeZone` y UTC en el instante `epoch`. */
function offsetMs(timeZone: string, epoch: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(epoch))
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return local - Math.floor(epoch / 1000) * 1000;
}

/** "2026-10-08" + 600 min en America/Mexico_City → epoch ms. Resuelve cambios de horario con una segunda pasada. */
export function localToEpoch(date: string, minute: number, timeZone: string): number {
  const { y, m, d } = parseIsoDate(date);
  const guess = Date.UTC(y, m - 1, d) + minute * 60_000;
  const first = guess - offsetMs(timeZone, guess);
  const second = guess - offsetMs(timeZone, first);
  return second;
}

/** 0 = domingo … 6 = sábado, para una fecha de calendario. */
export function weekdayOf(date: string): number {
  const { y, m, d } = parseIsoDate(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Fecha local (YYYY-MM-DD) y hora local ("10:00") de un instante. */
export function localParts(epoch: number, timeZone: string): { date: string; time: string } {
  const date = todayIn(timeZone, new Date(epoch));
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(epoch));
  return { date, time };
}

/** "martes 8 de octubre, 10:00" */
export function slotLabel(epoch: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(epoch));
  return `${day.replace(",", "")}, ${localParts(epoch, timeZone).time}`;
}

export const parseTime = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

// ── Horarios libres ─────────────────────────────────────────────────────────────

export type Slot = { userId: string; userName: string; startsAt: number; endsAt: number };

/** Vendedores activos que tienen horario de citas (opcionalmente, solo los indicados). */
async function rulesFor(db: Db, tenantId: string, userIds?: string[]) {
  return db
    .select({ userId: availabilityRules.userId, userName: users.name, weekday: availabilityRules.weekday, startMinute: availabilityRules.startMinute, endMinute: availabilityRules.endMinute })
    .from(availabilityRules)
    .innerJoin(users, eq(users.id, availabilityRules.userId))
    .where(and(eq(availabilityRules.tenantId, tenantId), eq(users.active, true), userIds ? inArray(availabilityRules.userId, userIds) : undefined));
}

/**
 * Horarios libres desde `fromDate` durante `days` días. Cada regla se parte en bloques de la duración de la
 * cita; se descartan los que ya pasaron (o empiezan en menos de MIN_LEAD_MS) y los que se empalman con
 * una cita vigente del mismo vendedor.
 */
export async function freeSlots(
  db: Db,
  tenant: Tenant,
  opts: { fromDate?: string; days?: number; userIds?: string[]; now?: number; excludeAppointmentId?: string },
): Promise<Slot[]> {
  const now = opts.now ?? Date.now();
  const tz = tenant.timezone;
  const duration = tenant.appointmentMinutes * 60_000;
  const fromDate = opts.fromDate ?? todayIn(tz, new Date(now));
  const days = Math.min(Math.max(opts.days ?? 7, 1), 31);
  const rules = await rulesFor(db, tenant.id, opts.userIds);
  if (rules.length === 0) return [];

  const rangeStart = localToEpoch(fromDate, 0, tz);
  const rangeEnd = localToEpoch(addDays(fromDate, days), 0, tz);
  const busy = await db
    .select({ id: appointments.id, userId: appointments.userId, startsAt: appointments.startsAt, endsAt: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenant.id),
        eq(appointments.status, "scheduled"),
        lt(appointments.startsAt, rangeEnd),
        gt(appointments.endsAt, rangeStart),
        inArray(
          appointments.userId,
          [...new Set(rules.map((r) => r.userId))],
        ),
      ),
    );

  const slots: Slot[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    const weekday = weekdayOf(date);
    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;
      for (let minute = rule.startMinute; minute + tenant.appointmentMinutes <= rule.endMinute; minute += tenant.appointmentMinutes) {
        const startsAt = localToEpoch(date, minute, tz);
        const endsAt = startsAt + duration;
        if (startsAt < now + MIN_LEAD_MS) continue;
        const clash = busy.some((b) => b.userId === rule.userId && b.id !== opts.excludeAppointmentId && b.startsAt < endsAt && b.endsAt > startsAt);
        if (!clash) slots.push({ userId: rule.userId, userName: rule.userName, startsAt, endsAt });
      }
    }
  }
  return slots.sort((a, b) => a.startsAt - b.startsAt || a.userName.localeCompare(b.userName));
}

/**
 * Quién puede recibir a este prospecto: su vendedor asignado, si tiene horario de citas; si no tiene vendedor
 * (o el asignado no recibe visitas, p. ej. un gerente), cualquiera del equipo con horario.
 */
export async function sellersForProspect(db: Db, prospect: { assignedUserId: string | null }): Promise<string[] | undefined> {
  if (!prospect.assignedUserId) return undefined;
  const hasSchedule = await db.select({ id: availabilityRules.id }).from(availabilityRules).where(eq(availabilityRules.userId, prospect.assignedUserId)).limit(1).get();
  return hasSchedule ? [prospect.assignedUserId] : undefined;
}

// ── Reserva ─────────────────────────────────────────────────────────────────────

export type BookInput = {
  tenant: Tenant;
  prospectId: string;
  startsAt: number;
  /** Vendedor elegido; si no se indica, el del prospecto o el primero libre a esa hora. */
  userId?: string | null;
  developmentId?: string | null;
  notes?: string | null;
  source: "ai" | "user";
  actor: string;
  now?: number;
};

export type BookResult =
  | { ok: true; appointment: typeof appointments.$inferSelect; userName: string; replaced: boolean }
  | { ok: false; error: "not_available" | "taken" | "prospect_not_found" };

/** Cita vigente (futura) del prospecto, si tiene. */
export function upcomingAppointment(db: Db, prospectId: string, now = Date.now()) {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.prospectId, prospectId), eq(appointments.status, "scheduled"), gte(appointments.endsAt, now)))
    .orderBy(asc(appointments.startsAt))
    .get();
}

/**
 * Agenda (o reagenda) una cita. Verifica que el horario siga libre y lo inserta en un solo batch con la
 * cancelación de la cita anterior, el cambio de etapa, la asignación y el aviso. Si dos reservas llegan a la
 * vez, el índice único (vendedor, inicio) rechaza la segunda y se responde "taken".
 */
export async function bookAppointment(db: Db, input: BookInput): Promise<BookResult> {
  const now = input.now ?? Date.now();
  const prospect = await db.select().from(prospects).where(and(eq(prospects.id, input.prospectId), eq(prospects.tenantId, input.tenant.id))).get();
  if (!prospect) return { ok: false, error: "prospect_not_found" };

  const previous = await upcomingAppointment(db, prospect.id, now);
  // Volver a pedir el mismo horario que ya tiene (p. ej. "sí, agéndala" después de agendar) no cambia nada.
  if (previous && previous.startsAt === input.startsAt && (!input.userId || input.userId === previous.userId)) {
    const owner = await db.select({ name: users.name }).from(users).where(eq(users.id, previous.userId)).get();
    return { ok: true, appointment: previous, userName: owner?.name ?? "", replaced: false };
  }
  const date = localParts(input.startsAt, input.tenant.timezone).date;
  const candidates = input.userId ? [input.userId] : await sellersForProspect(db, prospect);
  const free = (await freeSlots(db, input.tenant, { fromDate: date, days: 1, userIds: candidates, now, excludeAppointmentId: previous?.id })).filter(
    (s) => s.startsAt === input.startsAt,
  );
  const slot = free[0];
  if (!slot) return { ok: false, error: "not_available" };

  const who = prospect.name ?? prospect.profileName ?? "Un prospecto";
  const label = slotLabel(slot.startsAt, input.tenant.timezone);
  const id = crypto.randomUUID();
  const earlyStage = prospect.stage === "new" || prospect.stage === "qualified";
  try {
    const statements: BatchItem<"sqlite">[] = [
      // Primero se libera la cita anterior (si la hay): así reagendar a un horario contiguo no choca con ella.
      ...(previous
        ? [db.update(appointments).set({ status: "cancelled", cancelReason: "Reagendada", updatedAt: now }).where(eq(appointments.id, previous.id))]
        : []),
      db.insert(appointments).values({
        id,
        tenantId: input.tenant.id,
        prospectId: prospect.id,
        userId: slot.userId,
        developmentId: input.developmentId ?? prospect.interestDevelopmentId ?? null,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        source: input.source,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      }),
      db
        .update(prospects)
        .set({
          ...(earlyStage ? { stage: "appointment" as const } : {}),
          // Quien recibe la visita se queda con el prospecto si no tenía vendedor.
          ...(prospect.assignedUserId ? {} : { assignedUserId: slot.userId, assignedAt: now }),
          updatedAt: now,
        })
        .where(eq(prospects.id, prospect.id)),
      db.insert(notifications).values({
        tenantId: input.tenant.id,
        userId: slot.userId,
        prospectId: prospect.id,
        kind: "appointment",
        title: `${previous ? "Cita reagendada" : "Cita agendada"}: ${who}`,
        body: `${label}${input.source === "ai" ? " (la agendó la IA)" : ""}`,
        createdAt: now,
      }),
      auditInsert(db, {
        tenantId: input.tenant.id,
        actor: input.actor,
        entity: "prospect",
        entityId: prospect.id,
        action: previous ? "appointment_rescheduled" : "appointment_booked",
        data: { appointmentId: id, startsAt: slot.startsAt, userId: slot.userId, label, ...(previous ? { previousId: previous.id } : {}) },
      }),
      ...(earlyStage
        ? [auditInsert(db, { tenantId: input.tenant.id, actor: input.actor, entity: "prospect", entityId: prospect.id, action: "stage_change", data: { from: prospect.stage, to: "appointment" } })]
        : []),
    ];
    await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? "")}`)) {
      return { ok: false, error: "taken" };
    }
    throw err;
  }
  const appointment = (await db.select().from(appointments).where(eq(appointments.id, id)).get())!;
  return { ok: true, appointment, userName: slot.userName, replaced: Boolean(previous) };
}

/** Cambia el estado de una cita (asistió, no asistió, cancelada) con auditoría y efectos en la etapa. */
export async function setAppointmentStatus(
  db: Db,
  input: { tenantId: string; appointmentId: string; status: Exclude<AppointmentStatus, "scheduled">; reason?: string | null; actor: string; now?: number },
) {
  const now = input.now ?? Date.now();
  const current = await db.select().from(appointments).where(and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, input.tenantId))).get();
  if (!current) return null;
  if (current.status === input.status) return current;
  const prospect = await db.select({ stage: prospects.stage }).from(prospects).where(eq(prospects.id, current.prospectId)).get();
  // Si visitó, el prospecto avanza a "Visitó" (salvo que ya esté más adelante).
  const advance = input.status === "completed" && prospect && ["new", "qualified", "appointment"].includes(prospect.stage);
  const [updated] = await db.batch([
    db
      .update(appointments)
      .set({ status: input.status, ...(input.status === "cancelled" ? { cancelReason: input.reason ?? null } : {}), updatedAt: now })
      .where(eq(appointments.id, current.id))
      .returning(),
    auditInsert(db, {
      tenantId: input.tenantId,
      actor: input.actor,
      entity: "prospect",
      entityId: current.prospectId,
      action: `appointment_${input.status}`,
      data: { appointmentId: current.id, startsAt: current.startsAt, ...(input.reason ? { reason: input.reason } : {}) },
    }),
    ...(advance
      ? [
          db.update(prospects).set({ stage: "visited", updatedAt: now }).where(eq(prospects.id, current.prospectId)),
          auditInsert(db, { tenantId: input.tenantId, actor: input.actor, entity: "prospect", entityId: current.prospectId, action: "stage_change", data: { from: prospect!.stage, to: "visited" } }),
        ]
      : []),
  ]);
  return updated[0] ?? null;
}

/** Cron: aviso al vendedor de las citas que empiezan pronto (una sola vez por cita). */
export async function remindSellers(db: Db, now = Date.now()) {
  const due = await db
    .select({ appointment: appointments, prospectName: prospects.name, profileName: prospects.profileName, timezone: tenants.timezone })
    .from(appointments)
    .innerJoin(prospects, eq(prospects.id, appointments.prospectId))
    .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
    .where(
      and(
        eq(appointments.status, "scheduled"),
        isNull(appointments.sellerRemindedAt),
        gt(appointments.startsAt, now),
        lte(appointments.startsAt, now + SELLER_REMINDER_MS),
        notInArray(prospects.stage, ["won", "lost"]),
      ),
    )
    .limit(100);
  for (const row of due) {
    const a = row.appointment;
    await db.batch([
      db.update(appointments).set({ sellerRemindedAt: now }).where(and(eq(appointments.id, a.id), isNull(appointments.sellerRemindedAt))),
      db.insert(notifications).values({
        tenantId: a.tenantId,
        userId: a.userId,
        prospectId: a.prospectId,
        kind: "appointment",
        title: `Cita próxima: ${row.prospectName ?? row.profileName ?? "prospecto"}`,
        body: slotLabel(a.startsAt, row.timezone),
        createdAt: now,
      }),
    ]);
  }
  return due.length;
}

/** Reemplaza el horario semanal de un vendedor. */
export async function replaceAvailability(
  db: Db,
  input: { tenantId: string; userId: string; rules: { weekday: number; startMinute: number; endMinute: number }[]; actor: string },
) {
  await db.batch([
    db.delete(availabilityRules).where(and(eq(availabilityRules.userId, input.userId), eq(availabilityRules.tenantId, input.tenantId))),
    ...input.rules.map((r) => db.insert(availabilityRules).values({ tenantId: input.tenantId, userId: input.userId, ...r })),
    auditInsert(db, { tenantId: input.tenantId, actor: input.actor, entity: "user", entityId: input.userId, action: "availability_updated", data: { rules: input.rules } }),
  ]);
}

export const appointmentCountSql = (tenantId: string, from: number, to: number) =>
  sql<number>`(SELECT count(*) FROM ${appointments} WHERE ${appointments.tenantId} = ${tenantId} AND ${appointments.status} = 'scheduled' AND ${appointments.startsAt} >= ${from} AND ${appointments.startsAt} < ${to})`;
