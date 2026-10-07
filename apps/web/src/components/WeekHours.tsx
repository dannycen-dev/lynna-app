import { useEffect, useState } from "react";
import { minutesToTime, timeToMinutes, WEEKDAY_LABEL } from "../lib/format";

// Editor de horario semanal (un tramo por día). Lo usan el horario de citas de cada vendedor y el horario
// de atención de la oficina.

export type WeekRule = { weekday: number; startMinute: number; endMinute: number };
type DayDraft = { on: boolean; start: string; end: string };

/** Lunes primero, como se lee una semana de trabajo. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

function toDraft(rules: WeekRule[]): Record<number, DayDraft> {
  const draft: Record<number, DayDraft> = {};
  for (const d of WEEK_ORDER) {
    const r = rules.find((x) => x.weekday === d);
    draft[d] = r ? { on: true, start: minutesToTime(r.startMinute), end: minutesToTime(r.endMinute) } : { on: false, start: "09:00", end: "18:00" };
  }
  return draft;
}

export function useWeekHours(rules: WeekRule[] | undefined) {
  const [draft, setDraft] = useState(() => toDraft(rules ?? []));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(toDraft(rules ?? []));
    setDirty(false);
  }, [rules]);
  const set = (day: number, patch: Partial<DayDraft>) => {
    setDirty(true);
    setDraft((prev) => ({ ...prev, [day]: { ...prev[day]!, ...patch } }));
  };
  const invalid = WEEK_ORDER.some((d) => draft[d]!.on && timeToMinutes(draft[d]!.end) <= timeToMinutes(draft[d]!.start));
  const value = (): WeekRule[] =>
    WEEK_ORDER.filter((d) => draft[d]!.on).map((d) => ({ weekday: d, startMinute: timeToMinutes(draft[d]!.start), endMinute: timeToMinutes(draft[d]!.end) }));
  return { draft, set, invalid, value, dirty };
}

export function WeekHoursGrid({
  hours,
  dayLabel,
  disabled,
}: {
  hours: ReturnType<typeof useWeekHours>;
  /** Nombre accesible de la casilla de cada día ("Ana atiende el Lunes"). */
  dayLabel: (day: string) => string;
  disabled?: boolean;
}) {
  const { draft, set, invalid } = hours;
  return (
    <>
      <div className="availability-grid">
        {WEEK_ORDER.map((d) => (
          <div key={d} style={{ display: "contents" }}>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={draft[d]!.on} disabled={disabled} onChange={(e) => set(d, { on: e.target.checked })} aria-label={dayLabel(WEEKDAY_LABEL[d]!)} />
              {WEEKDAY_LABEL[d]}
            </label>
            <input className="input" type="time" step={900} value={draft[d]!.start} disabled={disabled || !draft[d]!.on} onChange={(e) => set(d, { start: e.target.value })} aria-label={`${WEEKDAY_LABEL[d]}, desde`} />
            <input className="input" type="time" step={900} value={draft[d]!.end} disabled={disabled || !draft[d]!.on} onChange={(e) => set(d, { end: e.target.value })} aria-label={`${WEEKDAY_LABEL[d]}, hasta`} />
          </div>
        ))}
      </div>
      {invalid && (
        <div className="alert alert--error" style={{ marginTop: 8 }}>
          La hora de fin debe ser mayor que la de inicio.
        </div>
      )}
    </>
  );
}
