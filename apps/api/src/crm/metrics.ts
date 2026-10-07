import { and, eq, gte, lt } from "drizzle-orm";
import type { Principal } from "../auth/middleware";
import type { Db } from "../db/client";
import { appointments, auditLog, conversations, messages, PROSPECT_STAGES, prospects, tenants, users } from "../db/schema";
import { addDays, todayIn } from "../financing/dates";
import { localToEpoch } from "./agenda";
import { openMinutesBetween } from "./business-hours";
import { timeOffBetween } from "./time-off";
import { isSeller, prospectScope } from "./assignment";

// Métricas del CRM para un periodo (prospectos cuyo primer contacto cae en el periodo = "cohorte").
// D1 limita a 100 los parámetros por consulta: en lugar de "IN (ids…)" se trae por fecha y se filtra en memoria.

/** Embudo: orden de avance (perdido no es una etapa del embudo). */
const FUNNEL = PROSPECT_STAGES.filter((s) => s !== "lost");
const rank = (stage: string) => FUNNEL.indexOf(stage as (typeof FUNNEL)[number]);

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export type Metrics = Awaited<ReturnType<typeof computeMetrics>>;

export async function computeMetrics(
  db: Db,
  tenant: Pick<typeof tenants.$inferSelect, "id" | "timezone" | "businessHours">,
  principal: Principal,
  days: number,
  now = Date.now(),
) {
  const tz = tenant.timezone;
  const today = todayIn(tz, new Date(now));
  const fromDate = addDays(today, -(days - 1));
  const start = localToEpoch(fromDate, 0, tz);
  const end = localToEpoch(addDays(today, 1), 0, tz);
  const sellerId = isSeller(principal) && principal.kind === "user" ? principal.user.id : null;

  const [cohort, stageEvents, appts, convs, msgs, team] = await Promise.all([
    db
      .select({
        id: prospects.id,
        stage: prospects.stage,
        source: prospects.source,
        handoffAt: prospects.handoffAt,
        handoffReason: prospects.handoffReason,
        assignedUserId: prospects.assignedUserId,
        createdAt: prospects.createdAt,
      })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenant.id), prospectScope(principal), gte(prospects.createdAt, start), lt(prospects.createdAt, end))),
    db
      .select({ entityId: auditLog.entityId, data: auditLog.data })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenant.id), eq(auditLog.action, "stage_change"), gte(auditLog.createdAt, start))),
    db
      .select({ prospectId: appointments.prospectId, userId: appointments.userId, status: appointments.status, startsAt: appointments.startsAt, createdAt: appointments.createdAt })
      .from(appointments)
      .where(and(eq(appointments.tenantId, tenant.id), gte(appointments.createdAt, start), sellerId ? eq(appointments.userId, sellerId) : undefined)),
    db
      .select({ id: conversations.id, prospectId: conversations.prospectId, takenAt: conversations.takenAt })
      .from(conversations)
      .where(and(eq(conversations.tenantId, tenant.id), gte(conversations.createdAt, start))),
    db
      .select({ conversationId: messages.conversationId, direction: messages.direction, author: messages.author, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.tenantId, tenant.id), gte(messages.createdAt, start)))
      .orderBy(messages.createdAt),
    db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.tenantId, tenant.id)),
  ]);

  const ids = new Set(cohort.map((p) => p.id));

  // ── Embudo: la etapa más avanzada a la que llegó cada prospecto (aunque después se haya perdido). ──
  const furthest = new Map<string, number>();
  for (const p of cohort) furthest.set(p.id, Math.max(0, rank(p.stage)));
  for (const e of stageEvents) {
    if (!ids.has(e.entityId)) continue;
    const to = (e.data as { to?: string } | null)?.to;
    if (to && rank(to) > (furthest.get(e.entityId) ?? 0)) furthest.set(e.entityId, rank(to));
  }
  for (const a of appts) {
    if (!ids.has(a.prospectId)) continue;
    const r = rank(a.status === "completed" ? "visited" : "appointment");
    if (r > (furthest.get(a.prospectId) ?? 0)) furthest.set(a.prospectId, r);
  }
  const funnel = FUNNEL.map((stage, i) => {
    const count = [...furthest.values()].filter((r) => r >= i).length;
    return { stage, count, pct: cohort.length ? count / cohort.length : 0 };
  });

  const lostReasons = new Map<string, number>();
  for (const e of stageEvents) {
    const d = e.data as { to?: string; reason?: string } | null;
    if (ids.has(e.entityId) && d?.to === "lost") {
      const reason = d.reason?.trim() || "Sin motivo";
      lostReasons.set(reason, (lostReasons.get(reason) ?? 0) + 1);
    }
  }

  // ── Tiempos de respuesta ──
  const convByProspect = new Map(convs.filter((c) => ids.has(c.prospectId)).map((c) => [c.id, c]));
  const firstIn = new Map<string, number>();
  const aiFirst: number[] = [];
  const humanAfter = new Map<string, number>(); // conversación → primer mensaje de asesor
  const answered = new Set<string>();
  for (const m of msgs) {
    if (!convByProspect.has(m.conversationId)) continue;
    if (m.direction === "in" && !firstIn.has(m.conversationId)) firstIn.set(m.conversationId, m.createdAt);
    if (m.direction === "out" && firstIn.has(m.conversationId) && !answered.has(m.conversationId)) {
      answered.add(m.conversationId);
      if (m.author === "ai") aiFirst.push((m.createdAt - firstIn.get(m.conversationId)!) / 1000);
    }
    if (m.author === "user") humanAfter.set(m.conversationId, Math.min(humanAfter.get(m.conversationId) ?? Infinity, m.createdAt));
  }
  // Después de turnar a un asesor: cuánto tardó una persona en tomar la conversación o escribir. Se cuentan
  // solo minutos de oficina abierta (si hay horario): un turno a las 23:00 atendido a las 9:05 son 5 min.
  const officeClosed = new Set(
    (await timeOffBetween(db, tenant.id, fromDate, today)).filter((t) => t.userId === null).flatMap((t) => {
      const dates: string[] = [];
      for (let d = t.startDate < fromDate ? fromDate : t.startDate; d <= t.endDate && d <= today; d = addDays(d, 1)) dates.push(d);
      return dates;
    }),
  );
  const advisorMinutes: number[] = [];
  let handoffsPending = 0;
  const handoffReasons = new Map<string, number>();
  for (const p of cohort) {
    if (!p.handoffAt) continue;
    handoffReasons.set(p.handoffReason ?? "otro", (handoffReasons.get(p.handoffReason ?? "otro") ?? 0) + 1);
    const conv = [...convByProspect.values()].find((c) => c.prospectId === p.id);
    const times = [conv?.takenAt, conv ? humanAfter.get(conv.id) : undefined].filter((t): t is number => typeof t === "number" && t >= p.handoffAt!);
    if (times.length === 0) handoffsPending++;
    else advisorMinutes.push(openMinutesBetween(tenant.businessHours, tz, p.handoffAt, Math.min(...times), officeClosed));
  }

  // ── Citas del periodo (por fecha de la cita) ──
  const inPeriod = appts.filter((a) => a.startsAt >= start && a.startsAt < end);
  const apptCount = (status: string) => inPeriod.filter((a) => a.status === status).length;
  const completed = apptCount("completed");
  const noShow = apptCount("no_show");

  // ── Por vendedor ──
  const sellers = team
    .filter((u) => u.role === "seller" && (!sellerId || u.id === sellerId))
    .map((u) => {
      const mine = cohort.filter((p) => p.assignedUserId === u.id);
      return {
        userId: u.id,
        name: u.name,
        prospects: mine.length,
        appointments: appts.filter((a) => a.userId === u.id && ids.has(a.prospectId)).length,
        won: mine.filter((p) => p.stage === "won").length,
        lost: mine.filter((p) => p.stage === "lost").length,
      };
    });

  return {
    period: { from: fromDate, to: today, days },
    prospects: {
      total: cohort.length,
      whatsapp: cohort.filter((p) => p.source === "whatsapp").length,
      simulator: cohort.filter((p) => p.source === "simulator").length,
      won: cohort.filter((p) => p.stage === "won").length,
      lost: cohort.filter((p) => p.stage === "lost").length,
    },
    funnel,
    lostReasons: [...lostReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    response: {
      aiMedianSeconds: median(aiFirst),
      aiSamples: aiFirst.length,
      advisorMedianMinutes: median(advisorMinutes),
      /** true: los tiempos del asesor cuentan solo el horario de oficina. */
      advisorBusinessHours: Boolean(tenant.businessHours?.length),
      advisorWithin30Min: advisorMinutes.length ? advisorMinutes.filter((m) => m <= 30).length / advisorMinutes.length : null,
      handoffs: cohort.filter((p) => p.handoffAt).length,
      handoffsPending,
      handoffReasons: [...handoffReasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    },
    appointments: {
      total: inPeriod.length,
      scheduled: apptCount("scheduled"),
      completed,
      noShow,
      cancelled: apptCount("cancelled"),
      showRate: completed + noShow ? completed / (completed + noShow) : null,
    },
    sellers,
  };
}
