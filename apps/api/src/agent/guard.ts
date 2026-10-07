import type { Facts } from "./tools";

// Validador de salida: código que revisa CADA respuesta antes de enviarla. Independiente del prompt.
// Si algo no cuadra con lo que devolvieron las herramientas en este turno, la respuesta se bloquea.

export type GuardResult = { ok: true } | { ok: false; reasons: string[] };

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** Promesas o acciones que el cliente prohibió a la IA. */
const FORBIDDEN: { reason: string; pattern: RegExp }[] = [
  { reason: "ofrece o negocia un descuento", pattern: /\b(te|le|les) (puedo |podemos |podria |hago |damos |doy |ofrezco )?(dar |hacer |ofrecer )?(un |el )?descuento\b/ },
  { reason: "ofrece o negocia un descuento", pattern: /\b(puedo|podemos|podria|podriamos|te podemos|se puede) (ofrecer|dar|hacer|aplicar)(te|le|les)? (un |el |algun )?descuento\b/ },
  { reason: "ofrece precio especial", pattern: /\bprecio especial\b|\bte lo (dejo|dejamos) en\b/ },
  { reason: "confirma un apartado", pattern: /\b(ya )?(esta|queda|quedo|qued[oó]) apartad[oa]\b|\b(te|se) lo (aparto|apartamos)\b|\bapartado (confirmado|listo)\b/ },
  { reason: "confirma un pago", pattern: /\b(pago|deposito|transferencia) (recibid[oa]|confirmad[oa]|registrad[oa])\b|\b(recibimos|confirmamos) tu pago\b/ },
  { reason: "promete fecha de escrituración", pattern: /\bescritur\w* (sera|estara|queda|quedara|seria) (el|en|para|listo|lista)\b|\bescritur\w* (en|a mas tardar) \d/ },
  { reason: "garantiza disponibilidad", pattern: /\b(te )?(garantizo|aseguro|garantizamos|aseguramos) (que )?(el lote |que )?(esta|sigue|seguira) disponible\b/ },
  { reason: "modifica contrato", pattern: /\b(modific|cambi)\w* (el|tu) contrato\b/ },
];

/** "$768,000", "$21,682.30", "768 mil", "1.5 millones" → pesos enteros. */
export function extractAmounts(text: string): number[] {
  const t = strip(text);
  const out: number[] = [];
  for (const m of t.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/g)) {
    out.push(Math.round(Number(m[1]!.replace(/,/g, "") + (m[2] ? `.${m[2]}` : ""))));
  }
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(mil|millones|millon|mdp)\b/g)) {
    const n = Number(m[1]!.replace(",", "."));
    out.push(Math.round(m[2] === "mil" ? n * 1_000 : n * 1_000_000));
  }
  return out;
}

/** Montos menores a esto no se validan (días, porcentajes escritos como número, cantidades de pagos). */
const MIN_CHECKED_AMOUNT = 1_000;

function amountVerified(amount: number, facts: Facts): boolean {
  for (const f of facts.amounts) {
    if (Math.abs(f - amount) <= 1) return true;
    // "768 mil" o "1.5 millones" son redondeos válidos de un monto verificado.
    if (amount >= 10_000 && Math.abs(f - amount) / f <= 0.006) return true;
  }
  return false;
}

/** "manzana A, lote 7", "Mz B lote 3", "lote 10 de la manzana C" → "A-7". */
export function extractLots(text: string): { key: string | null; number: string }[] {
  const t = strip(text);
  const found: { key: string | null; number: string }[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(/\b(?:manzana|mz\.?)\s*([a-z0-9]{1,3})\s*,?\s*(?:y\s+)?(?:el\s+)?lote\s*(\d{1,4})\b/g)) {
    const key = `${m[1]!.toUpperCase()}-${m[2]}`;
    seen.add(`${m.index}`);
    found.push({ key, number: m[2]! });
  }
  for (const m of t.matchAll(/\blote\s*(\d{1,4})\s*(?:de la|,)\s*(?:manzana|mz\.?)\s*([a-z0-9]{1,3})\b/g)) {
    found.push({ key: `${m[2]!.toUpperCase()}-${m[1]}`, number: m[1]! });
  }
  // "lote 7" suelto (sin manzana): se valida contra el número.
  for (const m of t.matchAll(/\blote\s*(\d{1,4})\b/g)) {
    if (!found.some((f) => f.number === m[1])) found.push({ key: null, number: m[1]! });
  }
  return found;
}

// Afirmaciones sobre la agenda. Cada una exige que la herramienta correspondiente haya respondido ok en
// este turno; así la IA no puede decir que agendó, cambió o canceló algo que no hizo.
/** "Tu visita quedó agendada": vale si se agendó en este turno o si ya tenía una cita (para recordarla). */
const BOOKING_CLAIM =
  /\b(cita|visita) (ya )?(quedo|queda|esta|ha quedado) (agendada|confirmada|programada|registrada|apartada|lista)\b|\b(agende|agendamos|programe|programamos|reserve|reservamos|confirme|confirmamos) (tu|la|su) (cita|visita)\b|\bte (agende|espero|esperamos) (el|este|ese|la|las|a las)\b/;
// Cancelar o cambiar: el modelo lo dice de muchas formas ("he procedido a cancelar tu visita", "ya quedó
// cancelada", "la moví al sábado"), así que se revisa cada ORACIÓN AFIRMATIVA que hable de la cita y use
// un verbo de cancelar/cambiar. Las preguntas ("¿quieres que la cancele?") no cuentan.
// Pasado o participio ("cancelé", "he cancelado", "quedó cancelada", "procedí a cancelar"); el infinitivo
// ("si necesitas cancelar") es un ofrecimiento, no una afirmación.
const CANCEL_VERB = /\b(cancele|cancelamos|cancelado|cancelada)\b|\b(procedi|procedido|procedimos) a cancelar/;
const CHANGE_VERB =
  /\b(cambie|cambiamos|cambiada|cambiado|movi|movimos|movida|movido|reagende|reagendamos|reagendada|reagendado|reprograme|reprogramamos|reprogramada|reprogramado)\b|\b(procedi|procedido|procedimos) a (cambiar|mover|reagendar|reprogramar)/;
const APPOINTMENT_WORD = /\b(cita|visita|la|lo)\b/;

/** Oraciones afirmativas (sin las preguntas). */
function statements(t: string): string[] {
  return t
    .split(/(?<=[.!?\n])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("¿") && !s.endsWith("?"));
}
/** Preguntar presupuesto, enganche o cuánto quiere invertir: requiere su consentimiento expreso (LFPDPPP art. 7). */
const ASKS_FINANCIAL =
  /\b(cual|de cuanto|que) (es |seria |sera )?(tu|su) (presupuesto|enganche)\b|\bcon cuanto (cuentas|cuenta|dispones|dispone)\b|\bcuanto (tienes|tiene|traes|piensas|planeas|quieres|quisieras|podrias|puedes) (de |para )?(el )?(enganche|presupuesto|invertir|gastar|destinar|pagar)\b|\b(tienes|tiene|cuentas con|cuenta con) (algun |un |el )?(presupuesto|enganche)\b|\b(que|cual) presupuesto (tienes|tiene|manejas|maneja|traes)\b|\bcuanto (te gustaria|quieres) (invertir|gastar)\b/;
/** Datos internos que nunca deben llegar al prospecto: JSON de las herramientas, ids, nombres de campos. */
const INTERNAL_DATA = /\{\s*"|"\s*:\s*["\[{\d]|\b(lote_id|plan_id|tool_call|precio_total|precio_m2|superficie_m2)\b|\b\w+_mxn\b|\blot-[a-z0-9]+-[a-z0-9]+\b/i;

/** "Dame un momento, déjame consultar": por WhatsApp nadie vuelve a escribir después; hay que hacerlo ahora. */
const DEFERS_ACTION =
  /\b(dame|deme|dame tantito|permiteme|permitame) (un )?(momento|momentito|segundo|minuto)\b|\b(dejame|permiteme|deja que|voy a) (consultar|revisar|checar|buscar|verificar)\b|\ben (un|unos) (momento|momentito|minutos?) te (digo|confirmo|comparto|aviso|paso)\b/;
const MONTHS = "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre";

/** "10:00", "4:30 pm" → "10:00", "16:30". */
export function extractTimes(text: string): string[] {
  const out: string[] = [];
  for (const m of strip(text).matchAll(/\b(\d{1,2}):(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?|hrs?\.?|horas)?/g)) {
    let h = Number(m[1]);
    const suffix = (m[3] ?? "").replace(/[\s.]/g, "");
    if (suffix.startsWith("pm") && h < 12) h += 12;
    if (suffix.startsWith("am") && h === 12) h = 0;
    if (h < 24 && Number(m[2]) < 60) out.push(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  return out;
}

export function validateReply(text: string, facts: Facts): GuardResult {
  const reasons: string[] = [];
  const t = strip(text);

  for (const rule of FORBIDDEN) if (rule.pattern.test(t)) reasons.push(rule.reason);

  // Sobre el texto original (con mayúsculas y comillas tal cual).
  if (INTERNAL_DATA.test(text) || /\b(herramienta|herramientas|tool|tools|funcion|json)\b/.test(t)) {
    reasons.push("la respuesta trae datos internos (JSON o campos de las herramientas)");
  }
  if (DEFERS_ACTION.test(t)) reasons.push("promete consultar después en lugar de usar las herramientas ahora");
  if (!facts.financialConsent && ASKS_FINANCIAL.test(t)) reasons.push("pide datos financieros sin la autorización del prospecto");
  if (BOOKING_CLAIM.test(t) && !facts.booked && !facts.existing) reasons.push("confirma una cita que no se agendó con agendar_visita");
  // Solo aplica si hay o hubo cita de por medio (una cita vigente o una herramienta de agenda en el turno).
  const agendaContext = facts.existing || facts.booked || facts.cancelled || /\b(cita|visita)\b/.test(t);
  if (agendaContext) {
    for (const s of statements(t)) {
      if (!APPOINTMENT_WORD.test(s)) continue;
      if (CANCEL_VERB.test(s) && !facts.cancelled && !/\bno (se )?(ha |han )?(cancel|pued)/.test(s)) reasons.push("dice que canceló la cita sin usar cancelar_cita");
      if (CHANGE_VERB.test(s) && /\b(cita|visita)\b/.test(s) && !facts.booked) reasons.push("dice que cambió la cita sin usar agendar_visita");
    }
  }
  for (const time of extractTimes(text)) {
    if (!facts.times.has(time)) reasons.push(`menciona el horario ${time} que no viene de la agenda`);
  }
  // Fechas de visitas: si habla de cita o visita, el día ("9 de octubre") debe venir de la agenda.
  if (/\b(cita|visita|agend)/.test(t)) {
    for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2}) de (${MONTHS})\\b`, "g"))) {
      if (!facts.dates.has(`${m[1]} de ${m[2]}`)) reasons.push(`menciona el ${m[1]} de ${m[2]} que no viene de la agenda`);
    }
  }

  for (const amount of extractAmounts(text)) {
    if (amount >= MIN_CHECKED_AMOUNT && !amountVerified(amount, facts)) {
      reasons.push(`menciona $${amount.toLocaleString("en-US")} que no viene de ninguna herramienta`);
    }
  }

  const lotNumbers = new Set([...facts.lots].map((k) => k.split("-")[1]));
  for (const lot of extractLots(text)) {
    const ok = lot.key ? facts.lots.has(lot.key) : lotNumbers.has(lot.number);
    if (!ok) reasons.push(`menciona el lote ${lot.key ?? lot.number} sin haberlo consultado`);
  }

  return reasons.length ? { ok: false, reasons: [...new Set(reasons)] } : { ok: true };
}
