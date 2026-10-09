import { and, desc, eq, gte, isNotNull, isNull, lte, notInArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { appointments, conversations, developments, MESSAGE_STATUS_RANK, messages, prospects, tenants, waAccounts, type FollowupStep } from "../db/schema";
import { auditInsert } from "../lib/audit";
import { localParts } from "./agenda";
import { isOpen } from "./business-hours";
import { officeClosedDates } from "./time-off";

// Seguimientos automáticos: si un prospecto deja de responder, se le escribe tras X horas de silencio
// (pasos configurables por desarrolladora). La secuencia se detiene si responde (y vuelve a empezar desde
// el paso 1 la próxima vez que se quede callado), agenda cita, pide baja, se turna a un asesor, un asesor
// toma la conversación, alguien la pausa, o el prospecto ya apartó, compró o se perdió.
//
// Envío, conforme a las políticas de WhatsApp Business:
// - Dentro de la ventana de 24 h desde el último mensaje del prospecto: texto libre (con botones).
// - Fuera de ella: SOLO plantillas aprobadas por Meta (categoría marketing) con botón para darse de baja.
//   Un paso sin plantilla se salta.
// - Calidad del número (bloqueos, reportes y mensajes no leídos la bajan): si no leyó el seguimiento anterior,
//   no se manda otro; si Meta aplica su tope diario de marketing (131049) se reintenta en 24 h; si el usuario
//   dejó de recibir marketing (131050) se registra como baja. Máximo 3 pasos y nunca fuera de horario.

const H = 3_600_000;
export const FOLLOWUP_TEMPLATE_LANGUAGE = "es_MX";
const MARGIN_MS = 30 * 60_000; // no apurar el final de la ventana de 24 h

/** Plantillas que crea `pnpm wa:templates`. El texto debe ser idéntico al registrado en Meta. */
export const FOLLOWUP_TEMPLATES: Record<string, { text: string; buttons: { title: string; reply: string }[] }> = {
  lynna_seguimiento_1: {
    text: "Hola {{1}}, seguimos teniendo lotes disponibles en {{2}}. ¿Te gustaría ver fotos o agendar una visita sin compromiso?",
    buttons: [
      { title: "Sí, me interesa", reply: "Sí, me interesa. Quiero ver fotos y opciones de lotes" },
      { title: "Ya no, gracias", reply: "Ya no me escriban, gracias" },
    ],
  },
  lynna_seguimiento_2: {
    text: "Hola {{1}}, este es nuestro último mensaje sobre {{2}}. Si más adelante quieres información, escríbenos y con gusto te atendemos.",
    buttons: [
      { title: "Quiero información", reply: "Quiero información de los lotes disponibles" },
      { title: "Ya no, gracias", reply: "Ya no me escriban, gracias" },
    ],
  },
};

export const DEFAULT_FOLLOWUP_STEPS: FollowupStep[] = [
  { afterHours: 4, text: "Hola {nombre}, ¿te quedó alguna duda sobre {desarrollo}? Si quieres, te mando fotos o te propongo horarios para visitarlo. 🙂" },
  { afterHours: 48, text: "Hola {nombre}, seguimos teniendo lotes disponibles en {desarrollo}. ¿Te gustaría ver fotos o agendar una visita sin compromiso?", template: "lynna_seguimiento_1" },
  { afterHours: 120, text: "Hola {nombre}, este es nuestro último mensaje sobre {desarrollo}. Si más adelante quieres información, escríbenos y con gusto te atendemos.", template: "lynna_seguimiento_2" },
];

/** Botones del seguimiento dentro de la ventana (texto libre). */
const inWindowButtons = (development: string | null) => [
  { title: "Ver fotos", reply: `Quiero ver fotos de ${development ?? "los desarrollos"}` },
  { title: "Agendar visita", reply: "Quiero agendar una visita" },
];

export type FollowupSend = {
  phoneNumberId: string;
  to: string;
  /** Dentro de la ventana de 24 h: texto libre con botones. */
  text: { body: string; buttons: { title: string; reply: string }[] } | null;
  /** Fuera de la ventana: plantilla aprobada. */
  template: { name: string; params: string[]; buttons: { title: string; reply: string }[] } | null;
};
export type FollowupSender = (msg: FollowupSend) => Promise<{ wamid: string }>;
/** Error de envío con el código de la Cloud API, si lo hay. */
export type FollowupSendError = { code: number | null; message: string };

/** Sin credenciales (o en pruebas): se guarda como simulado. */
const simulatedSender: FollowupSender = async () => ({ wamid: `sim.followup.${crypto.randomUUID()}` });

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

/** Cron: manda los seguimientos que tocan. Devuelve cuántos se mandaron. Sin `sender`, quedan simulados. */
export async function processFollowups(
  db: Db,
  now = Date.now(),
  sender?: FollowupSender,
  errorCode: (err: unknown) => number | null = () => null,
) {
  const real = Boolean(sender);
  const sendWith = sender ?? simulatedSender;
  const enabled = await db.select().from(tenants).where(eq(tenants.followupsEnabled, true));
  let sent = 0;
  for (const tenant of enabled) {
    if (!canWriteNow(tenant, now, await officeClosedDates(db, tenant.id, tenant.timezone, now, 0))) continue;
    const steps = tenant.followupSteps?.length ? tenant.followupSteps : DEFAULT_FOLLOWUP_STEPS;
    const minSilence = Math.min(...steps.map((s) => s.afterHours)) * H;
    const candidates = await db
      .select({ prospect: prospects, conversation: conversations, development: developments.name, phoneNumberId: waAccounts.phoneNumberId })
      .from(prospects)
      .innerJoin(conversations, eq(conversations.prospectId, prospects.id))
      .innerJoin(waAccounts, eq(waAccounts.id, conversations.waAccountId))
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

    for (const { prospect: p, conversation: conv, development, phoneNumberId } of candidates) {
      const status = followupStatus(tenant, p, conv, withAppointment.has(p.id));
      if (status.state !== "waiting" || status.nextAt > now) {
        // Respondió después del último seguimiento: se deja listo para empezar de nuevo desde el paso 1.
        if (p.followupStep !== 0 && p.followupLastAt && conv.lastInboundAt! > p.followupLastAt) {
          await db.update(prospects).set({ followupStep: 0 }).where(eq(prospects.id, p.id));
        }
        continue;
      }
      const step = steps[status.step]!;
      const name = p.name ?? p.profileName;

      // Calidad del número: el seguimiento anterior (real) debe haberse leído; un fallo reciente espera 24 h.
      const [last] = await db
        .select({ status: messages.status, statusRank: messages.statusRank, createdAt: messages.createdAt })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.author, "system"), eq(messages.type, "template")))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const repliedSinceLast = Boolean(last && conv.lastInboundAt! > last.createdAt);
      if (last?.status === "failed" && now - last.createdAt < 24 * H) continue;
      if (real && status.step > 0 && last && last.status !== "simulated" && last.status !== "failed" && last.statusRank < MESSAGE_STATUS_RANK.read && !repliedSinceLast) {
        await db.batch([
          db.update(prospects).set({ followupStep: steps.length }).where(eq(prospects.id, p.id)),
          auditInsert(db, { tenantId: tenant.id, actor: "system", entity: "prospect", entityId: p.id, action: "followup_stopped", data: { reason: "no leyó el seguimiento anterior" } }),
        ]);
        continue;
      }

      const inWindow = conv.lastInboundAt! > now - 24 * H + MARGIN_MS;
      const template = !inWindow && step.template ? FOLLOWUP_TEMPLATES[step.template] : undefined;
      if (!inWindow && !template) {
        // Fuera de la ventana y sin plantilla aprobada: no se puede escribir; se pasa al siguiente paso.
        await db.update(prospects).set({ followupStep: status.step + 1, followupLastAt: now }).where(eq(prospects.id, p.id));
        continue;
      }
      const params = [name?.split(/\s+/)[0] ?? "de nuevo", development ?? "nuestros desarrollos"];
      const body = template
        ? template.text.replace("{{1}}", params[0]!).replace("{{2}}", params[1]!)
        : renderFollowup(step.text, { name, development });

      let wamid = `sim.followup.${crypto.randomUUID()}`;
      let msgStatus: "accepted" | "simulated" | "failed" = "simulated";
      let error: string | undefined;
      try {
        ({ wamid } = await sendWith({
          phoneNumberId,
          to: p.phone,
          text: template ? null : { body, buttons: inWindowButtons(development) },
          template: template ? { name: step.template!, params, buttons: template.buttons } : null,
        }));
        if (real) msgStatus = "accepted";
      } catch (err) {
        msgStatus = "failed";
        error = err instanceof Error ? err.message.slice(0, 500) : String(err);
        const code = errorCode(err);
        if (code === 131050) {
          // El usuario dejó de recibir mensajes de marketing de este negocio: es una baja.
          await db.update(prospects).set({ optedOutAt: now }).where(eq(prospects.id, p.id));
        }
      }

      await db.batch([
        db.insert(messages).values({
          tenantId: tenant.id,
          conversationId: conv.id,
          wamid,
          direction: "out",
          author: "system",
          type: "template",
          body,
          status: msgStatus,
          statusRank: MESSAGE_STATUS_RANK[msgStatus],
          ...(error ? { error } : {}),
          createdAt: now,
        }),
        ...(msgStatus === "failed"
          ? []
          : [
              db.update(conversations).set({ lastOutboundAt: now }).where(eq(conversations.id, conv.id)),
              db.update(prospects).set({ followupStep: status.step + 1, followupLastAt: now }).where(eq(prospects.id, p.id)),
            ]),
        auditInsert(db, {
          tenantId: tenant.id,
          actor: "system",
          entity: "prospect",
          entityId: p.id,
          action: msgStatus === "failed" ? "followup_failed" : "followup_sent",
          data: { step: status.step + 1, of: steps.length, text: body, via: template ? `plantilla ${step.template}` : "texto (ventana 24 h)", ...(error ? { error } : {}) },
        }),
      ]);
      if (msgStatus !== "failed") sent++;
    }
  }
  return sent;
}
