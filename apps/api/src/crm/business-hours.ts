import type { BusinessHours } from "../db/schema";
import { addDays, todayIn } from "../financing/dates";
import { localParts, localToEpoch, weekdayOf } from "./agenda";

// Horario de atención de los asesores. La IA contesta a cualquier hora; esto solo decide qué le promete al
// prospecto cuando lo turna a un humano: "en breve" si la oficina está abierta, o cuándo abre si no.

const minutesOf = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** `closed`: fechas locales en que la oficina cierra (días festivos, vacaciones colectivas). */
export function isOpen(hours: BusinessHours | null | undefined, timeZone: string, now = Date.now(), closed?: Set<string>): boolean {
  if (!hours?.length) return true; // sin horario configurado: no se promete nada distinto
  const { date, time } = localParts(now, timeZone);
  if (closed?.has(date)) return false;
  const weekday = weekdayOf(date);
  const minute = minutesOf(time);
  return hours.some((h) => h.weekday === weekday && minute >= h.startMinute && minute < h.endMinute);
}

/** Próxima apertura (epoch ms) en los siguientes 31 días; null si el horario está vacío. */
export function nextOpening(hours: BusinessHours | null | undefined, timeZone: string, now = Date.now(), closed?: Set<string>): number | null {
  if (!hours?.length) return null;
  const today = todayIn(timeZone, new Date(now));
  for (let i = 0; i <= 31; i++) {
    const date = addDays(today, i);
    if (closed?.has(date)) continue;
    const weekday = weekdayOf(date);
    const starts = hours
      .filter((h) => h.weekday === weekday)
      .map((h) => localToEpoch(date, h.startMinute, timeZone))
      .filter((t) => t > now)
      .sort((a, b) => a - b);
    if (starts[0]) return starts[0];
  }
  return null;
}

/**
 * Cuándo contactará un asesor: "en breve" (oficina abierta o sin horario), o "hoy a partir de las 16:00",
 * "mañana a partir de las 9:00", "el lunes 12 de octubre a partir de las 9:00".
 */
export function advisorEta(hours: BusinessHours | null | undefined, timeZone: string, now = Date.now(), closed?: Set<string>): string {
  if (isOpen(hours, timeZone, now, closed)) return "en breve";
  const next = nextOpening(hours, timeZone, now, closed);
  if (!next) return "en breve";
  const { date, time } = localParts(next, timeZone);
  const today = todayIn(timeZone, new Date(now));
  const hour = time.replace(/^0/, "");
  if (date === today) return `hoy a partir de las ${hour}`;
  if (date === addDays(today, 1)) return `mañana a partir de las ${hour}`;
  const day = new Intl.DateTimeFormat("es-MX", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(new Date(next)).replace(",", "");
  return `el ${day} a partir de las ${hour}`;
}
