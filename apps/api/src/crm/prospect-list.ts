import { and, desc, eq, gte, isNull, like, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Principal } from "../auth/middleware";
import type { Db } from "../db/client";
import { appointments, conversations, developments, messages, PROSPECT_STAGES, prospects, tenants, users } from "../db/schema";
import { addDays } from "../financing/dates";
import { localToEpoch } from "./agenda";
import { prospectScope } from "./assignment";

// Listado de prospectos con filtros del lado del servidor (lo usan el tablero, la lista y la exportación CSV).

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export const prospectFilters = z.object({
  q: z.string().trim().max(100).optional(),
  development: z.string().max(80).optional(), // id del desarrollo de interés, o "none"
  temperature: z.enum(["frio", "tibio", "caliente", "listo"]).optional(),
  stage: z.enum(PROSPECT_STAGES).optional(),
  owner: z.string().max(80).optional(), // id del vendedor, o "none"
  source: z.enum(["whatsapp", "simulator"]).optional(),
  from: z.string().regex(ISO).optional(), // fecha de primer contacto (hora local de la desarrolladora)
  to: z.string().regex(ISO).optional(),
});
export type ProspectFilters = z.infer<typeof prospectFilters>;

/** Mismos cortes que agent/qualification.ts → temperature(). */
const SCORE_RANGE: Record<NonNullable<ProspectFilters["temperature"]>, [number, number]> = {
  frio: [0, 30],
  tibio: [30, 60],
  caliente: [60, 100],
  listo: [100, 1000],
};

const assignee = alias(users, "assignee");

export function prospectWhere(tenant: Pick<typeof tenants.$inferSelect, "id" | "timezone">, principal: Principal, f: ProspectFilters) {
  const q = f.q?.trim();
  const digits = q?.replace(/\D/g, "") ?? "";
  const range = f.temperature ? SCORE_RANGE[f.temperature] : null;
  return and(
    eq(prospects.tenantId, tenant.id),
    prospectScope(principal),
    q
      ? or(
          like(prospects.name, `%${q}%`),
          like(prospects.profileName, `%${q}%`),
          like(prospects.email, `%${q}%`),
          digits.length >= 4 ? like(prospects.phone, `%${digits}%`) : undefined,
        )
      : undefined,
    f.development === "none" ? isNull(prospects.interestDevelopmentId) : f.development ? eq(prospects.interestDevelopmentId, f.development) : undefined,
    range ? and(gte(prospects.score, range[0]), lt(prospects.score, range[1])) : undefined,
    f.stage ? eq(prospects.stage, f.stage) : undefined,
    f.owner === "none" ? isNull(prospects.assignedUserId) : f.owner ? eq(prospects.assignedUserId, f.owner) : undefined,
    f.source ? eq(prospects.source, f.source) : undefined,
    f.from ? gte(prospects.createdAt, localToEpoch(f.from, 0, tenant.timezone)) : undefined,
    f.to ? lt(prospects.createdAt, localToEpoch(addDays(f.to, 1), 0, tenant.timezone)) : undefined,
  );
}

export async function listProspects(db: Db, tenant: Pick<typeof tenants.$inferSelect, "id" | "timezone">, principal: Principal, f: ProspectFilters, limit = 500) {
  const where = prospectWhere(tenant, principal, f);
  const [rows, total] = await Promise.all([
    db
      .select({
        id: prospects.id,
        phone: prospects.phone,
        name: prospects.name,
        profileName: prospects.profileName,
        email: prospects.email,
        stage: prospects.stage,
        score: prospects.score,
        city: prospects.city,
        purpose: prospects.purpose,
        budgetCents: prospects.budgetCents,
        downPaymentCents: prospects.downPaymentCents,
        timeframe: prospects.timeframe,
        interestDevelopmentId: prospects.interestDevelopmentId,
        developmentName: developments.name,
        handoffAt: prospects.handoffAt,
        handoffReason: prospects.handoffReason,
        optedOutAt: prospects.optedOutAt,
        consentAt: prospects.consentAt,
        source: prospects.source,
        createdAt: prospects.createdAt,
        conversationId: conversations.id,
        aiPaused: conversations.aiPaused,
        takenByUserId: conversations.takenByUserId,
        lastOutboundAt: conversations.lastOutboundAt,
        assignedUserId: prospects.assignedUserId,
        assignedName: assignee.name,
        updatedAt: prospects.updatedAt,
        lastInboundAt: conversations.lastInboundAt,
        messageCount: sql<number>`(SELECT count(*) FROM ${messages} WHERE ${messages.conversationId} = ${conversations.id})`,
        nextAppointmentAt: sql<number | null>`(SELECT min(${appointments.startsAt}) FROM ${appointments} WHERE ${appointments.prospectId} = ${prospects.id} AND ${appointments.status} = 'scheduled' AND ${appointments.endsAt} >= ${Date.now()})`,
      })
      .from(prospects)
      .leftJoin(conversations, eq(conversations.prospectId, prospects.id))
      .leftJoin(assignee, eq(assignee.id, prospects.assignedUserId))
      .leftJoin(developments, eq(developments.id, prospects.interestDevelopmentId))
      .where(where)
      .orderBy(desc(sql`coalesce(${conversations.lastInboundAt}, ${prospects.createdAt})`))
      .limit(limit),
    db.$count(prospects, where),
  ]);
  return { rows, total };
}
