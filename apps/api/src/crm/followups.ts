import { and, eq, gte, isNotNull, isNull, lte, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { appointments, conversations, developments, MESSAGE_STATUS_RANK, messages, prospects, tenants, type FollowupStep } from "../db/schema";
import { auditInsert } from "../lib/audit";
import { localParts } from "./agenda";
import { isOpen } from "./business-hours";
import { officeClosedDates } from "./time-off";

// Seguimientos automáticos: si un prospecto deja de responder, se le escribe tras X horas de silencio
// (pasos configurables por desarrolladora). La secuencia se detiene si responde (y vuelve a empezar desde
// el paso 1 la próxima vez que se quede callado), agenda cita, pide baja, se turna a un asesor, un asesor
// toma la conversación, alguien la pausa, o el prospecto ya apartó, compró o se perdió.
//
// Envío: fuera de la ventana de 24 h WhatsApp solo permite plantillas aprobadas por Meta (Fase 2). Mientras
// tanto el mensaje queda en la conversación como "simulado"; el resto de la lógica ya es la definitiva.

const H = 3_600_000;

export const DEFAULT_FOLLOWUP_STEPS: FollowupStep[] = [
  { afterHours: 24, text: "Hola {nombre}, ¿pudiste revisar la información de {desarrollo}? Si quieres, te comparto horarios para visitarlo. 🙂" },
  { afterHours: 72, text: "Hola {nombre}, seguimos teniendo lotes disponibles en {desarrollo}. ¿Te gustaría que un asesor te llame para resolver tus dudas?" },
  { afterHours: 168, text: "Hola {nombre}, te escribo por última vez para saber si sigues buscando terreno. Si en otro momento te interesa, aquí estamos." },
];

/** Fuera de horario de oficina (o, si no hay horario, antes de las 9:00 o después de las 20:00) no se escribe. */
function canWriteNow(tenant: { businessHours: typeof tenants.$inferSelect.businessHours; timezone: string }, now: number, closed: Set<string>) {
  if (closed.has(localParts(now, tenant.timezone).date)) return false; // día festivo / oficina cerrada
  if (tenant.businessHours?.length) return isOpen(tenant.businessHours, tenant.timezone, now);
  const [h] = localParts(now, tenant.timezone).time.split(":").map(Number);
  return h! >= 9 && h! < 20;
}

export function renderFollowup(text: string, data: { name: string | null; development: string | null }) {
  return text
    .replace(/\{nombre\}/g, data.name?.split(/\s+/)[0] ?? "")
    .replace(/\{desarrollo\}/g, data.development ?? "nuestros desarrollos")
    .replace(/Hola ,/g, "Hola,")
    .trim();
}

export type FollowupStatus =
  | { state: "disabled" }
  | { state: "stopped"; reason: string }
  | { state: "done"; step: number; total: number }
  | { state: "waiting"; step: number; total: number; nextAt: number };

/** Estado de la secuencia para un prospecto (para la ficha). Misma lógica que el cron. */
export function followupStatus(
  tenant: Pick<typeof tenants.$inferSelect, "followupsEnabled" | "followupSteps">,
  p: Pick<typeof prospects.$inferSelect, "stage" | "optedOutAt" | "handoffAt" | "followupStep" | "followupLastAt" | "followupsPausedAt" | "source">,
  conv: { aiPaused: boolean; lastInboundAt: number | null } | null,
  hasUpcomingAppointment: boolean,
): FollowupStatus {
  if (!tenant.followupsEnabled) return { state: "disabled" };
  const steps = tenant.followupSteps?.length ? tenant.followupSteps : DEFAULT_FOLLOWUP_STEPS;
  if (p.optedOutAt) return { state: "stopped", reason: "Pidió no recibir mensajes" };
  if (p.followupsPausedAt) return { state: "stopped", reason: "Pausados por el equipo" };
  if (["reserved", "won", "lost"].includes(p.stage)) return { state: "stopped", reason: "Ya apartó, compró o se perdió" };
  if (p.handoffAt) return { state: "stopped", reason: "Se turnó a un asesor" };
  if (conv?.aiPaused) return { state: "stopped", reason: "Lo atiende un asesor" };
  if (hasUpcomingAppointment) return { state: "stopped", reason: "Tiene una cita agendada" };
  if (!conv?.lastInboundAt) return { state: "stopped", reason: "Sin conversación" };
  // Si respondió después del último seguimiento, la secuencia vuelve a empezar.
  const step = p.followupLastAt && conv.lastInboundAt > p.followupLastAt ? 0 : p.followupStep;
  if (step >= steps.length) return { state: "done", step, total: steps.length };
  const base = step === 0 ? conv.lastInboundAt : (p.followupLastAt ?? conv.lastInboundAt);
  return { state: "waiting", step, total: steps.length, nextAt: base + steps[step]!.afterHours * H };
}

/** Cron: manda los seguimientos que tocan. Devuelve cuántos se mandaron. */
export async function processFollowups(db: Db, now = Date.now()) {
  const enabled = await db.select().from(tenants).where(eq(tenants.followupsEnabled, true));
  let sent = 0;
  for (const tenant of enabled) {
    if (!canWriteNow(tenant, now, await officeClosedDates(db, tenant.id, tenant.timezone, now, 0))) continue;
    const steps = tenant.followupSteps?.length ? tenant.followupSteps : DEFAULT_FOLLOWUP_STEPS;
    const minSilence = Math.min(...steps.map((s) => s.afterHours)) * H;
    const candidates = await db
      .select({ prospect: prospects, conversation: conversations, development: developments.name })
      .from(prospects)
      .innerJoin(conversations, eq(conversations.prospectId, prospects.id))
      .leftJoin(developments, eq(developments.id, prospects.interestDevelopmentId))
      .where(
        and(
          eq(prospects.tenantId, tenant.id),
          eq(prospects.source, "whatsapp"),
          isNull(prospects.optedOutAt),
          isNull(prospects.followupsPausedAt),
          isNull(prospects.handoffAt),
          notInArray(prospects.stage, ["reserved", "won", "lost"]),
          eq(conversations.aiPaused, false),
          isNotNull(conversations.lastInboundAt),
          lte(conversations.lastInboundAt, now - minSilence),
        ),
      )
      .limit(200);
    const withAppointment = new Set(
      (
        await db
          .select({ prospectId: appointments.prospectId })
          .from(appointments)
          .where(and(eq(appointments.tenantId, tenant.id), eq(appointments.status, "scheduled"), gte(appointments.endsAt, now)))
      ).map((a) => a.prospectId),
    );

    for (const { prospect: p, conversation: conv, development } of candidates) {
      const status = followupStatus(tenant, p, conv, withAppointment.has(p.id));
      if (status.state !== "waiting" || status.nextAt > now) {
        // Respondió después del último seguimiento: se deja listo para empezar de nuevo desde el paso 1.
        if (p.followupStep !== 0 && p.followupLastAt && conv.lastInboundAt! > p.followupLastAt) {
          await db.update(prospects).set({ followupStep: 0 }).where(eq(prospects.id, p.id));
        }
        continue;
      }
      const body = renderFollowup(steps[status.step]!.text, { name: p.name ?? p.profileName, development });
      await db.batch([
        db.insert(messages).values({
          tenantId: tenant.id,
          conversationId: conv.id,
          wamid: `sim.followup.${crypto.randomUUID()}`,
          direction: "out",
          author: "system",
          type: "template",
          body,
          // Fase 2: se enviará como plantilla aprobada de Meta. Hoy queda como simulado.
          status: "simulated",
          statusRank: MESSAGE_STATUS_RANK.simulated,
          createdAt: now,
        }),
        db.update(conversations).set({ lastOutboundAt: now }).where(eq(conversations.id, conv.id)),
        db.update(prospects).set({ followupStep: status.step + 1, followupLastAt: now }).where(eq(prospects.id, p.id)),
        auditInsert(db, { tenantId: tenant.id, actor: "system", entity: "prospect", entityId: p.id, action: "followup_sent", data: { step: status.step + 1, of: steps.length, text: body } }),
      ]);
      sent++;
    }
  }
  return sent;
}
