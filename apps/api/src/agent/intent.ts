// Red de seguridad determinista: detecta en el mensaje del prospecto las situaciones que el cliente
// pidió turnar a un humano. Si el modelo no llamó escalar_a_asesor, el runner escala de todos modos.

import type { EscalationReason } from "./tools";

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const RULES: { reason: EscalationReason; patterns: RegExp[] }[] = [
  {
    reason: "compra",
    patterns: [
      /\bquiero (lo )?comprar(lo)?\b/,
      /\bcomo (lo |la )?(puedo |podria )?apart(o|ar|arlo|arla)\b/,
      /\bquiero apartar/,
      /\bme (lo|la) quedo\b/,
      /\bver (el )?contrato\b/,
      /\b(puedo|podria) pagar (hoy|ya|ahorita)\b/,
      /\bque (necesito|se necesita|requisitos?) para escriturar\b/,
      /\bescritur(ar|acion)\b/,
      /\bcerrar (el )?trato\b/,
    ],
  },
  {
    reason: "descuento",
    patterns: [/\bdescuento\b/, /\bprecio especial\b/, /\b(rebaja|rebajar)\b/, /\bnegociar\b/, /\bme lo (deja|dejas|dejan) en\b/],
  },
  { reason: "pago", patterns: [/\bya (pague|deposite|transferi)\b/, /\bcomprobante\b/, /\b(mi|el) pago\b/, /\bfactura\b/] },
  { reason: "legal", patterns: [/\babogado\b/, /\blegal(es|mente)?\b/, /\bdemanda\b/, /\bejido\b/, /\bregimen de propiedad\b/] },
  { reason: "queja", patterns: [/\bqueja\b/, /\b(fraude|estafa)\b/, /\bpesimo\b/, /\bmolest[oa]\b/, /\bprofeco\b/] },
];

export function detectEscalation(text: string): EscalationReason | null {
  const t = strip(text);
  for (const rule of RULES) if (rule.patterns.some((p) => p.test(t))) return rule.reason;
  return null;
}

const OPT_OUT = [/^\s*(baja|stop|alto)\s*$/, /\bya no me (escriban|manden|envien|contacten)\b/, /\bno me (escriban|contacten) mas\b/, /\bdarme de baja\b/];

export function isOptOut(text: string): boolean {
  const t = strip(text);
  return OPT_OUT.some((p) => p.test(t));
}
