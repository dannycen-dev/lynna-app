import { and, eq, gte, lte } from "drizzle-orm";
import type { Db } from "../db/client";
import { timeOff } from "../db/schema";
import { addDays, todayIn } from "../financing/dates";

// Días libres (vacaciones de un vendedor o cierre de la oficina). Las fechas son locales "AAAA-MM-DD" y la
// comparación de texto funciona porque el formato es fijo.

export type TimeOffRow = typeof timeOff.$inferSelect;

/** Días libres que tocan el rango [fromDate, toDate] (ambos inclusive). */
export async function timeOffBetween(db: Db, tenantId: string, fromDate: string, toDate: string): Promise<TimeOffRow[]> {
  return db
    .select()
    .from(timeOff)
    .where(and(eq(timeOff.tenantId, tenantId), lte(timeOff.startDate, toDate), gte(timeOff.endDate, fromDate)));
}

/** ¿Ese vendedor (o, con null, la oficina) descansa ese día? El cierre de oficina aplica a todos. */
export function isDayOff(rows: TimeOffRow[], userId: string | null, date: string) {
  return rows.some((r) => (r.userId === null || r.userId === userId) && r.startDate <= date && r.endDate >= date);
}

/** Fechas en que la oficina cierra durante los próximos `days` días (para el horario de atención). */
export async function officeClosedDates(db: Db, tenantId: string, timeZone: string, now = Date.now(), days = 32): Promise<Set<string>> {
  const today = todayIn(timeZone, new Date(now));
  const rows = (await timeOffBetween(db, tenantId, today, addDays(today, days))).filter((r) => r.userId === null);
  const closed = new Set<string>();
  for (let i = 0; i <= days; i++) {
    const date = addDays(today, i);
    if (isDayOff(rows, null, date)) closed.add(date);
  }
  return closed;
}
