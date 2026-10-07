import {
  Bot,
  CalendarCheck,
  ChevronLeft,
  ChevronRight,
  Clock,
} from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Dialog,
  Empty,
  ErrorAlert,
  PageHeader,
  Spinner,
} from "../components/ui";
import {
  useAgenda,
  useAvailability,
  useSetAppointmentStatus,
  useTeam,
} from "../lib/api";
import {
  addDaysIso,
  APPOINTMENT_STATUS_LABEL,
  dayLabel,
  todayMx,
} from "../lib/format";
import { useSession } from "../lib/session";
import type { AgendaItem } from "../lib/types";

const DAYS = 7;
export const STATUS_TONE: Record<string, string> = {
  scheduled: "info",
  completed: "available",
  no_show: "reserved",
  cancelled: "sold",
};

/** Agenda de visitas: semana a semana, por vendedor. Un vendedor ve solo la suya. */
export function Agenda() {
  const { me } = useSession();
  const isSellerUser = me?.user.role === "seller";
  const [from, setFrom] = useState(todayMx());
  const [userId, setUserId] = useState<string>("");
  const agenda = useAgenda(from, DAYS, userId || null);
  const team = useTeam();
  const availability = useAvailability();
  const noSchedules =
    availability.data &&
    availability.data.members.every((m) => m.rules.length === 0);

  const byDay = useMemo(() => {
    const map = new Map<string, AgendaItem[]>();
    for (let i = 0; i < DAYS; i++) map.set(addDaysIso(from, i), []);
    for (const a of agenda.data ?? []) map.get(a.date)?.push(a);
    return [...map.entries()];
  }, [agenda.data, from]);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Citas"
        subtitle={
          isSellerUser
            ? "Tus visitas agendadas. La IA agenda en tus horarios libres."
            : "Visitas al desarrollo agendadas por la IA o por el equipo."
        }
        actions={
          <div className="row" style={{ gap: 8 }}>
            {!isSellerUser && (
              <select
                className="select"
                style={{ width: 200 }}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                aria-label="Filtrar por vendedor"
              >
                <option value="">Todo el equipo</option>
                {team.data
                  ?.filter((u) => u.active && u.role !== "admin")
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            )}
            <button
              className="btn btn--sm"
              onClick={() => setFrom(addDaysIso(from, -DAYS))}
              aria-label="Semana anterior"
            >
              <ChevronLeft size={16} />
            </button>
            <button className="btn btn--sm" onClick={() => setFrom(todayMx())}>
              Hoy
            </button>
            <button
              className="btn btn--sm"
              onClick={() => setFrom(addDaysIso(from, DAYS))}
              aria-label="Semana siguiente"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        }
      />
      {noSchedules && (
        <div className="alert alert--info" style={{ marginBottom: 16 }}>
          Nadie tiene horario de citas todavía, así que la IA no puede agendar.
          Configúralo en <Link to="/ajustes">Configuración</Link>.
        </div>
      )}
      {agenda.isPending && <Spinner />}
      <ErrorAlert error={agenda.error} />
      {agenda.data && (
        <div className="stack">
          {byDay.map(([date, items]) => (
            <section key={date} className="card" aria-label={dayLabel(date)}>
              <div className="card__header">
                <CalendarCheck size={16} /> {dayLabel(date)}
                <span
                  className="muted"
                  style={{ marginLeft: "auto", fontWeight: 400 }}
                >
                  {items.length === 0
                    ? "Sin citas"
                    : `${items.length} cita${items.length === 1 ? "" : "s"}`}
                </span>
              </div>
              {items.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {items.map((a) => (
                        <AgendaRow
                          key={a.id}
                          item={a}
                          showSeller={!isSellerUser}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
          {agenda.data.length === 0 && !noSchedules && (
            <Empty
              icon={<CalendarCheck size={40} />}
              title="Sin citas esta semana"
            >
              Las visitas que agende la IA o el equipo aparecerán aquí.
            </Empty>
          )}
        </div>
      )}
    </div>
  );
}

function AgendaRow({
  item,
  showSeller,
}: {
  item: AgendaItem;
  showSeller: boolean;
}) {
  const setStatus = useSetAppointmentStatus();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const started = item.startsAt <= Date.now();
  const scheduled = item.status === "scheduled";
  return (
    <tr>
      <td className="num" style={{ width: 80 }}>
        <strong>{item.time}</strong>
      </td>
      <td>
        <Link to={`/prospectos/${item.prospectId}`}>
          <strong>{item.prospectName}</strong>
        </Link>
        <div className="muted" style={{ fontSize: 12 }}>
          {[showSeller ? item.sellerName : null, item.developmentName]
            .filter(Boolean)
            .join(" · ")}
          {item.source === "ai" && (
            <span
              className="row"
              style={{
                display: "inline-flex",
                gap: 3,
                marginLeft: showSeller || item.developmentName ? 6 : 0,
              }}
            >
              <Bot size={12} /> la agendó la IA
            </span>
          )}
        </div>
      </td>
      <td style={{ width: 120 }}>
        <span className={`badge badge--${STATUS_TONE[item.status]}`}>
          {APPOINTMENT_STATUS_LABEL[item.status]}
        </span>
      </td>
      <td className="right" style={{ whiteSpace: "nowrap" }}>
        {scheduled && started && (
          <>
            <button
              className="btn btn--sm"
              disabled={setStatus.isPending}
              onClick={() =>
                setStatus.mutate({ id: item.id, status: "completed" })
              }
            >
              Asistió
            </button>{" "}
            <button
              className="btn btn--sm"
              disabled={setStatus.isPending}
              onClick={() =>
                setStatus.mutate({ id: item.id, status: "no_show" })
              }
            >
              No asistió
            </button>
          </>
        )}
        {scheduled && !started && (
          <button
            className="btn btn--sm btn--ghost"
            onClick={() => setCancelling(true)}
          >
            Cancelar
          </button>
        )}
        {!scheduled && item.status !== "cancelled" && (
          <span
            className="muted row"
            style={{ gap: 4, justifyContent: "flex-end" }}
          >
            <Clock size={12} /> registrada
          </span>
        )}
        <ErrorAlert error={setStatus.error} />
        {cancelling && (
          <Dialog
            open
            onClose={() => setCancelling(false)}
            title={`Cancelar la cita de ${item.prospectName}`}
            footer={
              <>
                <button className="btn" onClick={() => setCancelling(false)}>
                  Volver
                </button>
                <button
                  className="btn btn--primary"
                  disabled={setStatus.isPending}
                  onClick={() =>
                    setStatus.mutate(
                      {
                        id: item.id,
                        status: "cancelled",
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      },
                      { onSuccess: () => setCancelling(false) },
                    )
                  }
                >
                  Cancelar cita
                </button>
              </>
            }
          >
            <p style={{ marginTop: 0 }}>{item.label}</p>
            <div className="field">
              <label htmlFor={`reason-${item.id}`}>Motivo (opcional)</label>
              <textarea
                id={`reason-${item.id}`}
                className="textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ej. El prospecto pidió otro día"
              />
              <span className="field__hint">
                El prospecto no recibe aviso automático todavía; avísale por
                WhatsApp.
              </span>
            </div>
          </Dialog>
        )}
      </td>
    </tr>
  );
}
