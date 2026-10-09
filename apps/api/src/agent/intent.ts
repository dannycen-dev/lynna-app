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
      // "¿me lo apartas?", "apártamelo", "apártenlo", "lo aparto ya"
      /\b(me |lo |la )?aparta(s|n|me|melo|mela|nlo|nla|rlo|rla)?\b/,
      /\baparto\b/,
      /\bme (lo|la) quedo\b/,
      /\bver (el )?contrato\b/,
      /\b(puedo|podria) pagar (hoy|ya|ahorita)\b/,
      /\bque (necesito|se necesita|requisitos?) para escriturar\b/,
      /\bcerrar (el )?trato\b/,
    ],
  },
  {
    reason: "descuento",
    patterns: [/\bdescuento\b/, /\bprecio especial\b/, /\b(rebaja|rebajar)\b/, /\bnegociar\b/, /\bme lo (deja|dejas|dejan) en\b/],
  },
  {
    reason: "pago",
    patterns: [
      /\bya (pague|deposite|transferi)\b/,
      /\b(te|les|le) (transfiero|deposito|pago|mando el dinero)\b/,
      /\b(hago|hacer|mandar) (la |una )?(transferencia|deposito)\b/,
      /\bcomprobante\b/,
      /\b(mi|el) pago\b/,
      /\bfactura\b/,
    ],
  },
  {
    reason: "legal",
    // Escrituras (fechas, entrega, si ya está escriturado): tema legal; "qué necesito para escriturar" es compra (arriba).
    patterns: [/\babogado\b/, /\blegal(es|mente)?\b/, /\bdemanda\b/, /\bejido\b/, /\bregimen de propiedad\b/, /\bescritur\w*/],
  },
  { reason: "queja", patterns: [/\bqueja\b/, /\b(fraude|estafa)\b/, /\bpesimo\b/, /\bmolest[oa]\b/, /\bprofeco\b/] },
  {
    // Pide hablar con una persona: se le da, aunque no sea un tema de los que el cliente pidió turnar.
    reason: "otro",
    patterns: [
      /\b(hablar|comunicarme|platicar) con (un|una|algun|alguna|el|la|tu|su)? ?(asesor|asesora|vendedor|vendedora|persona|humano|ejecutivo|ejecutiva|gerente)\b/,
      /\b(me|nos) (puede|pueden|puedes|podria|podrian|podrias) (marcar|llamar|contactar|hablar)\b/,
      /\b(quiero|necesito|prefiero) (un|una|que me atienda un|que me atienda una|que me llame un|que me llame una) (asesor|asesora|vendedor|vendedora|persona|humano)\b/,
      /\b(pasame|comunicame|comunicarme) con\b/,
      /\bllamenme\b|\bmarquenme\b/,
    ],
  },
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

export type MaterialRequest = "fotos" | "plano" | "ubicacion";

/** Qué material pidió el prospecto ("mándame fotos", "¿tienes el plano?", "¿cómo llego?"). */
export function requestedMaterial(text: string): MaterialRequest[] {
  const t = strip(text);
  const out: MaterialRequest[] = [];
  if (/\b(fotos?|imagen(es)?|renders?|como (se ve|es el desarrollo|luce))\b/.test(t)) out.push("fotos");
  if (/\b(plano|planos|masterplan|plano maestro|lotificacion)\b/.test(t)) out.push("plano");
  if (/\b(ubicacion|como llego|como llegar|mapa|pin|google maps|donde (esta|queda|se ubica))\b/.test(t)) out.push("ubicacion");
  return out;
}

/** La respuesta dice que ya se envió material ("te envío las fotos", "te acabo de mandar el plano"). */
export function claimsMaterialSent(reply: string): boolean {
  const t = strip(reply);
  return /\b(te (envio|mando|comparto|acabo de (enviar|mandar|compartir))|aqui (tienes|te dejo)|ya te (envie|mande|comparti))\b[^.?!]{0,60}\b(fotos?|imagen(es)?|plano|ubicacion|mapa|pin|material)\b/.test(t);
}

// Muletillas con las que la gente abre una ráfaga ("oye", "hola", "una pregunta") antes de escribir lo que quiere.
const FILLER = /^(oye|oiga|hola|holi|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|una pregunta|una duda|tengo una duda|disculpa|disculpe|mira|fijate|este|ey|hey|hi|ola)( (oye|una pregunta|una duda|disculpa))?$/;

/** ¿El mensaje es solo una muletilla de apertura? (para esperar a que llegue la pregunta de verdad) */
export function isFiller(text: string | null | undefined): boolean {
  if (!text) return false;
  return FILLER.test(strip(text).replace(/[¡!¿?.,;:]/g, "").replace(/\s+/g, " ").trim());
}

/** "te transfiero", "ya deposité", "¿a qué cuenta pago?", "te mando el dinero"… */
export function mentionsMoneyTransfer(text: string): boolean {
  const t = strip(text);
  return /\b(transfier\w*|transferencia|deposit\w*|deposito|spei|cuenta bancaria|numero de cuenta|clabe|mando el dinero|te pago|les pago|a que cuenta)\b/.test(t);
}

