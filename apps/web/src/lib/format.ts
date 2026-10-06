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
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
