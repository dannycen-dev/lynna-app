// Fechas de calendario como "YYYY-MM-DD" (sin zona horaria: son fechas de pago, no instantes).

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError(`Fecha inválida (se espera YYYY-MM-DD): ${value}`);
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new RangeError(`Fecha inválida: ${value}`);
  }
  return { y, m, d };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Como relativedelta(months=n): conserva el día y lo recorta al último del mes destino. */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parseIsoDate(date);
  const totalMonths = y * 12 + (m - 1) + months;
  const ty = Math.floor(totalMonths / 12);
  const tm = (totalMonths % 12) + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return format(ty, tm, Math.min(d, lastDay));
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseIsoDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Fecha de hoy en la zona horaria del negocio (por omisión, Ciudad de México). */
export function todayIn(timeZone = "America/Mexico_City", now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
