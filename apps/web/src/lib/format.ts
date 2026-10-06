import type { LineType, LotStatus } from "./types";

const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: 2 });
const mxnShort = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("es-MX", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("es-MX", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Mexico_City" });

export const money = (cents: number) => mxn.format(cents / 100);
export const moneyShort = (cents: number) => mxnShort.format(cents / 100);
export const area = (m2: number) => `${number.format(m2)} m²`;
export const pct = (bp: number) => `${number.format(bp / 100)} %`;
export const num = (n: number) => number.format(n);

/** "2026-10-06" → "06 oct 2026" (fecha de calendario, sin desfase de zona horaria). */
export const isoDate = (iso: string) => dateFmt.format(new Date(`${iso}T00:00:00Z`));
export const dateTime = (ms: number) => dateTimeFmt.format(new Date(ms));

export const STATUS_LABEL: Record<LotStatus, string> = {
  available: "Disponible",
  reserved: "Apartado",
  sold: "Vendido",
  blocked: "Bloqueado",
};

export const LINE_LABEL: Record<LineType, string> = {
  opening_fee: "Cuota de apertura",
  reservation: "Apartado",
  down_payment: "Enganche",
  down_payment_total: "Total enganche",
  installment: "Mensualidad",
  on_delivery: "Contra entrega",
};

export const STAGE_LABEL: Record<string, string> = {
  new: "Nuevo",
  qualified: "Calificado",
  appointment: "Cita agendada",
  visited: "Visitó",
  negotiation: "Negociación",
  ready_to_buy: "Listo para comprar",
  reserved: "Apartado",
  won: "Vendido",
  lost: "Perdido",
};

/** Hoy en Ciudad de México como YYYY-MM-DD. */
export function todayMx(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** Orden natural de lotes: A-2 antes que A-10. */
export function compareLots(a: { block: string; number: string }, b: { block: string; number: string }) {
  return a.block.localeCompare(b.block, "es", { numeric: true }) || a.number.localeCompare(b.number, "es", { numeric: true });
}

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const PURPOSE_LABEL: Record<string, string> = { vivienda: "Para vivir", inversion: "Inversión", otro: "Otro" };
export const TIMEFRAME_LABEL: Record<string, string> = {
  inmediato: "Inmediato",
  "1-3_meses": "1 a 3 meses",
  "3-6_meses": "3 a 6 meses",
  mas_6_meses: "Más de 6 meses",
  explorando: "Solo explorando",
};
export const HANDOFF_LABEL: Record<string, string> = {
  compra: "Quiere comprar",
  descuento: "Pide descuento",
  legal: "Tema legal",
  pago: "Tema de pagos",
  queja: "Queja",
  documentos: "Envió documentos",
  otro: "Requiere asesor",
};
export const TOOL_LABEL: Record<string, string> = {
  listar_desarrollos: "Consultó desarrollos",
  buscar_lotes: "Buscó lotes disponibles",
  detalle_lote: "Consultó un lote",
  planes_de_pago: "Consultó planes de pago",
  simular_plan: "Simuló un plan",
  actualizar_prospecto: "Guardó datos del prospecto",
  escalar_a_asesor: "Turnó a un asesor",
};

/** Calificación por puntaje (misma regla que la API: agent/qualification.ts). */
export function temperature(score: number): { label: string; tone: "sold" | "info" | "reserved" | "available" } {
  if (score >= 100) return { label: "Listo para comprar", tone: "available" };
  if (score >= 60) return { label: "Caliente", tone: "reserved" };
  if (score >= 30) return { label: "Tibio", tone: "info" };
  return { label: "Frío", tone: "sold" };
}

/** Orden del tablero (igual al flujo de venta de Lynna). */
export const STAGE_ORDER = ["new", "qualified", "appointment", "visited", "negotiation", "ready_to_buy", "reserved", "won", "lost"] as const;

export const HISTORY_LABEL: Record<string, string> = {
  stage_change: "Cambió la etapa",
  handoff: "Turnó a un asesor",
  taken_over: "Tomó la conversación",
  returned_to_ai: "Devolvió la conversación a la IA",
  opted_out: "El prospecto pidió no recibir mensajes",
};

/** "hace 5 min", "hace 2 h", "ayer"… */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "ayer" : `hace ${d} días`;
}
