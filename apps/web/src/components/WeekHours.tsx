import { Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { minutesToTime, timeToMinutes, WEEKDAY_LABEL } from "../lib/format";

// Editor de horario semanal: uno o varios tramos por día (p. ej. 9–14 y 16–19 con hora de comida). Lo usan
// el horario de citas de cada vendedor y el horario de atención de la oficina.

export type WeekRule = { weekday: number; startMinute: number; endMinute: number };
type Range = { start: string; end: string };
type DayDraft = { on: boolean; ranges: Range[] };

/** Lunes primero, como se lee una semana de trabajo. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** Igual que la API (crm/agenda.ts → weekRules). */
const MAX_RANGES = 4;

function toDraft(rules: WeekRule[]): Record<number, DayDraft> {
  const draft: Record<number, DayDraft> = {};
  for (const d of WEEK_ORDER) {
    const ranges = rules
      .filter((x) => x.weekday === d)
      .sort((a, b) => a.startMinute - b.startMinute)
      .map((r) => ({ start: minutesToTime(r.startMinute), end: minutesToTime(r.endMinute) }));
    draft[d] = ranges.length ? { on: true, ranges } : { on: false, ranges: [{ start: "09:00", end: "18:00" }] };
  }
  return draft;
}

/** Mensaje de error del día, o null si sus tramos son válidos. */
function dayError(day: DayDraft): string | null {
  if (!day.on) return null;
  const ranges = day.ranges.map((r) => ({ s: timeToMinutes(r.start), e: timeToMinutes(r.end) })).sort((a, b) => a.s - b.s);
  if (ranges.some((r) => r.e <= r.s)) return "La hora de fin debe ser mayor que la de inicio.";
  if (ranges.some((r, i) => i > 0 && r.s < ranges[i - 1]!.e)) return "Hay horarios que se empalman en el mismo día.";
  return null;
}

export function useWeekHours(rules: WeekRule[] | undefined) {
  const [draft, setDraft] = useState(() => toDraft(rules ?? []));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(toDraft(rules ?? []));
    setDirty(false);
  }, [rules]);
  const update = (day: number, fn: (d: DayDraft) => DayDraft) => {
    setDirty(true);
    setDraft((prev) => ({ ...prev, [day]: fn(prev[day]!) }));
  };
  const toggle = (day: number, on: boolean) => update(day, (d) => ({ ...d, on }));
  const setRange = (day: number, i: number, patch: Partial<Range>) =>
    update(day, (d) => ({ ...d, ranges: d.ranges.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  // El tramo nuevo empieza una hora después del último (si cabe en el día).
  const addRange = (day: number) =>
    update(day, (d) => {
      const lastEnd = timeToMinutes(d.ranges[d.ranges.length - 1]!.end);
      const start = Math.min(lastEnd + 60, 22 * 60);
      return { ...d, ranges: [...d.ranges, { start: minutesToTime(start), end: minutesToTime(Math.min(start + 180, 23 * 60 + 45)) }] };
    });
  const removeRange = (day: number, i: number) => update(day, (d) => ({ ...d, ranges: d.ranges.filter((_, j) => j !== i) }));
  const errors = Object.fromEntries(WEEK_ORDER.map((d) => [d, dayError(draft[d]!)])) as Record<number, string | null>;
  const invalid = WEEK_ORDER.some((d) => errors[d]);
  const value = (): WeekRule[] =>
    WEEK_ORDER.filter((d) => draft[d]!.on).flatMap((d) =>
      draft[d]!.ranges.map((r) => ({ weekday: d, startMinute: timeToMinutes(r.start), endMinute: timeToMinutes(r.end) })),
    );
  return { draft, toggle, setRange, addRange, removeRange, errors, invalid, value, dirty };
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
  const { draft, toggle, setRange, addRange, removeRange, errors } = hours;
  const firstError = WEEK_ORDER.map((d) => errors[d]).find(Boolean);
  return (
    <>
      <div className="availability-grid">
        {WEEK_ORDER.map((d) => {
          const day = draft[d]!;
          const name = WEEKDAY_LABEL[d]!;
          const off = disabled || !day.on;
          return (
            <div key={d} className="availability-day">
              <label className="row" style={{ gap: 6 }}>
                <input type="checkbox" checked={day.on} disabled={disabled} onChange={(e) => toggle(d, e.target.checked)} aria-label={dayLabel(name)} />
                {name}
              </label>
              <div className="availability-ranges">
                {day.ranges.map((r, i) => {
                  // El primer tramo conserva el nombre corto ("Lunes, desde"); los demás llevan su número.
                  const suffix = i === 0 ? "" : ` (tramo ${i + 1})`;
                  return (
                    <div key={i} className="availability-range" aria-invalid={Boolean(day.on && errors[d])}>
                      <input className="input" type="time" step={900} value={r.start} disabled={off} onChange={(e) => setRange(d, i, { start: e.target.value })} aria-label={`${name}, desde${suffix}`} />
                      <span className="muted">a</span>
                      <input className="input" type="time" step={900} value={r.end} disabled={off} onChange={(e) => setRange(d, i, { end: e.target.value })} aria-label={`${name}, hasta${suffix}`} />
                      {i > 0 && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={off} onClick={() => removeRange(d, i)} aria-label={`Quitar tramo ${i + 1} del ${name}`}>
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {day.ranges.length < MAX_RANGES ? (
                <button type="button" className="btn btn--ghost btn--sm" disabled={off} onClick={() => addRange(d)} aria-label={`Agregar otro horario el ${name}`} title="Agregar otro horario este día (p. ej. después de comer)">
                  <Plus size={14} /> Tramo
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
      {firstError && (
        <div className="alert alert--error" style={{ marginTop: 8 }}>
          {firstError}
        </div>
      )}
    </>
  );
}
