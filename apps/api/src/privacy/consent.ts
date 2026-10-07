import { eq } from "drizzle-orm";
import { computeScore } from "../agent/qualification";
import type { Db } from "../db/client";
import { prospects, tenants } from "../db/schema";
import { auditInsert } from "../lib/audit";

// Privacidad (LFPDPPP, DOF 20-03-2025). Interpretación técnica de Ignia, pendiente de validar con abogado:
// - Aviso de privacidad disponible desde el primer contacto (arts. 15 y 16): se agrega a la primera respuesta.
// - Datos financieros o patrimoniales (presupuesto, enganche) requieren consentimiento EXPRESO (art. 7):
//   la IA no los pide sin autorización; si el prospecto los da, se usan para responderle pero no se guardan
//   en el CRM hasta que diga que sí. Su respuesta queda como evidencia.

type Prospect = typeof prospects.$inferSelect;
type Tenant = Pick<typeof tenants.$inferSelect, "name" | "privacyNoticeUrl" | "privacyNoticeText">;

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();

export const CONSENT_QUESTION =
  "Para darte opciones de acuerdo con tu presupuesto y enganche, ¿me autorizas a guardar esos datos financieros conforme a nuestro aviso de privacidad? Responde *Sí* o *No*.";

/** Texto del aviso que acompaña la primera respuesta. */
export function privacyNotice(tenant: Tenant): string {
  if (tenant.privacyNoticeText?.trim()) {
    const text = tenant.privacyNoticeText.trim();
    return tenant.privacyNoticeUrl && !text.includes(tenant.privacyNoticeUrl) ? `${text} ${tenant.privacyNoticeUrl}` : text;
  }
  return tenant.privacyNoticeUrl
    ? `🔒 ${tenant.name} trata tus datos personales conforme a su aviso de privacidad: ${tenant.privacyNoticeUrl}`
    : `🔒 ${tenant.name} trata tus datos personales conforme a su aviso de privacidad; pídelo a tu asesor cuando quieras.`;
}

const clean = (text: string) =>
  strip(text)
    .replace(/[¡!¿?.,;:)(*_"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Solo cuenta una respuesta hecha ÚNICAMENTE de palabras afirmativas ("sí", "sí, acepto", "claro que sí,
// gracias"). "Si tengo 500 mil, ¿qué me alcanza?" empieza con "si" condicional y NO es consentimiento.
const YES_WORDS = "si|claro|claro que si|acepto|autorizo|de acuerdo|ok|okay|va|vale|esta bien|por supuesto|adelante|sale|perfecto|gracias|muchas gracias|por favor|con gusto";
const YES = new RegExp(`^(${YES_WORDS})( (${YES_WORDS}))*$`);
const NO = /^(no|nel|prefiero que no|no gracias|no acepto|no autorizo|no por ahora|mejor no)( (gracias|por ahora|por el momento))*$/;

/** "Sí", "sí, acepto", "claro, adelante"… */
export function isAffirmative(text: string): boolean {
  return YES.test(clean(text));
}

/** "No", "no, gracias", "prefiero que no"… */
export function isNegative(text: string): boolean {
  return NO.test(clean(text));
}

/** ¿El prospecto está compartiendo datos financieros (presupuesto, enganche, montos)? */
export function mentionsFinancialData(text: string): boolean {
  const t = strip(text);
  return (
    /\b(presupuesto|enganche|ahorrado|ahorros|credito|infonavit|fovissste|de contado)\b/.test(t) ||
    /\$\s?\d|\b\d+(?:[.,]\d+)?\s*(mil|millones|millon|mdp|pesos)\b/.test(t)
  );
}

/** Registra la respuesta al consentimiento. Si dijo que sí, guarda los datos financieros pendientes. */
export async function recordConsent(db: Db, input: { tenantId: string; prospect: Prospect; granted: boolean; text: string; now?: number }): Promise<Prospect> {
  const now = input.now ?? Date.now();
  const p = input.prospect;
  const pending = p.pendingFinancial ?? {};
  const financial = input.granted
    ? {
        ...(pending.budgetCents ? { budgetCents: pending.budgetCents } : {}),
        ...(pending.downPaymentCents !== undefined ? { downPaymentCents: pending.downPaymentCents } : {}),
      }
    : {};
  const next = { ...p, ...financial };
  const [updated] = await db.batch([
    db
      .update(prospects)
      .set({
        ...(input.granted ? { consentAt: now, ...financial, score: computeScore(next) } : { consentDeniedAt: now }),
        consentText: input.text.slice(0, 300),
        pendingFinancial: null,
        updatedAt: now,
      })
      .where(eq(prospects.id, p.id))
      .returning(),
    auditInsert(db, {
      tenantId: input.tenantId,
      actor: "prospect",
      entity: "prospect",
      entityId: p.id,
      action: input.granted ? "consent_given" : "consent_denied",
      data: { text: input.text.slice(0, 300), applied: Object.keys(financial) },
    }),
  ]);
  return updated[0]!;
}
