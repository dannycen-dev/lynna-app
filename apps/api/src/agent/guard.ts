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

export function validateReply(text: string, facts: Facts): GuardResult {
  const reasons: string[] = [];
  const t = strip(text);

  for (const rule of FORBIDDEN) if (rule.pattern.test(t)) reasons.push(rule.reason);

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
