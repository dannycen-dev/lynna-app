import { and, eq, gte, lt, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { aiAuditLog, conversations, messages, prospects, tenants } from "../db/schema";
import { localToEpoch } from "./agenda";

// Consumo del mes por desarrolladora, para facturar al costo (decisión de Ignia: la IA y WhatsApp los paga
// el cliente). Excluye el simulador (pruebas internas). WhatsApp es una ESTIMACIÓN: lo factura Meta directo.

/** Precio oficial de Workers AI: USD 0.011 por 1,000 neuronas (cloudflare.com, octubre 2026). */
export const USD_PER_1000_NEURONS = 0.011;
/** Tarifas de Meta para México vigentes desde el 1-oct-2026 (hoja oficial en MXN). */
export const META_MXN = { marketing: 0.7298, service: 0.1565, freeServicePerMonth: 1000 };

export type TenantUsage = {
  tenantId: string;
  name: string;
  slug: string;
  aiReplies: number;
  neurons: number;
  aiUsd: number;
  conversations: number;
  inbound: number;
  outboundReplies: number;
  templates: number;
  whatsappMxnEstimate: number;
};

/** "2026-10" → [inicio, fin) en epoch ms, en la zona de la desarrolladora. */
export function monthRange(month: string, timeZone: string): [number, number] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return [localToEpoch(`${month}-01`, 0, timeZone), localToEpoch(`${next}-01`, 0, timeZone)];
}

export async function computeUsage(db: Db, month: string, tenantId?: string): Promise<TenantUsage[]> {
  const list = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, timezone: tenants.timezone })
    .from(tenants)
    .where(tenantId ? eq(tenants.id, tenantId) : undefined)
    .orderBy(tenants.name);
  const out: TenantUsage[] = [];
  for (const t of list) {
    const [from, to] = monthRange(month, t.timezone);
    // Solo conversaciones reales (prospectos de WhatsApp), no las del simulador.
    const real = and(eq(prospects.tenantId, t.id), ne(prospects.source, "simulator"));
    const [ai, msgs] = await Promise.all([
      db
        .select({ replies: sql<number>`count(*)`, neurons: sql<number>`coalesce(sum(${aiAuditLog.neurons}), 0)` })
        .from(aiAuditLog)
        .innerJoin(conversations, eq(conversations.id, aiAuditLog.conversationId))
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(and(real, gte(aiAuditLog.createdAt, from), lt(aiAuditLog.createdAt, to)))
        .get(),
      db
        .select({
          conversations: sql<number>`count(distinct ${messages.conversationId})`,
          inbound: sql<number>`coalesce(sum(${messages.direction} = 'in'), 0)`,
          outboundReplies: sql<number>`coalesce(sum(${messages.direction} = 'out' AND ${messages.type} <> 'template'), 0)`,
          templates: sql<number>`coalesce(sum(${messages.direction} = 'out' AND ${messages.type} = 'template'), 0)`,
        })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(prospects, eq(prospects.id, conversations.prospectId))
        .where(and(real, gte(messages.createdAt, from), lt(messages.createdAt, to)))
        .get(),
    ]);
    const neurons = Number(ai?.neurons ?? 0);
    const outboundReplies = Number(msgs?.outboundReplies ?? 0);
    const templates = Number(msgs?.templates ?? 0);
    out.push({
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      aiReplies: Number(ai?.replies ?? 0),
      neurons: Math.round(neurons),
      aiUsd: Math.round((neurons / 1000) * USD_PER_1000_NEURONS * 100) / 100,
      conversations: Number(msgs?.conversations ?? 0),
      inbound: Number(msgs?.inbound ?? 0),
      outboundReplies,
      templates,
      whatsappMxnEstimate:
        Math.round((templates * META_MXN.marketing + Math.max(0, outboundReplies - META_MXN.freeServicePerMonth) * META_MXN.service) * 100) / 100,
    });
  }
  return out;
}
