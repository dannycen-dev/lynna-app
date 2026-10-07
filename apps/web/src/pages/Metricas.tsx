import { BarChart3, CalendarCheck, Clock, Trophy, Users } from "lucide-react";
import { useState } from "react";
import { ErrorAlert, Kpi, PageHeader, Spinner } from "../components/ui";
import { useMetrics } from "../lib/api";
import { HANDOFF_LABEL, isoDate, num, STAGE_LABEL } from "../lib/format";
import { useSession } from "../lib/session";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)} %`);

function seconds(s: number | null) {
  if (s === null) return "—";
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.round(s / 60)} min`;
}
function minutes(m: number | null) {
  if (m === null) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} días`;
}

/** Métricas del CRM: embudo, tiempos de respuesta, citas y vendedores. Un vendedor ve las suyas. */
export function Metricas() {
  const { me } = useSession();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const metrics = useMetrics(days);
  const m = metrics.data;
  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <PageHeader
        title="Métricas"
        subtitle={
          m
            ? `Prospectos cuyo primer contacto fue del ${isoDate(m.period.from)} al ${isoDate(m.period.to)}${me?.user.role === "seller" ? " (solo los tuyos)" : ""}.`
            : " "
        }
        actions={
          <div className="tabs" role="tablist" aria-label="Periodo" style={{ margin: 0 }}>
            {([7, 30, 90] as const).map((d) => (
              <button key={d} role="tab" aria-selected={days === d} className={`tabs__btn${days === d ? " active" : ""}`} onClick={() => setDays(d)}>
                {d} días
              </button>
            ))}
          </div>
        }
      />
      {metrics.isPending && <Spinner />}
      <ErrorAlert error={metrics.error} />
      {m && (
        <div className="stack">
          <div className="grid grid--kpis">
            <Kpi icon={<Users size={14} />} label="Prospectos nuevos" value={num(m.prospects.total)} hint={`${num(m.prospects.whatsapp)} por WhatsApp · ${num(m.prospects.simulator)} del simulador`} />
            <Kpi icon={<Trophy size={14} />} label="Vendidos" value={num(m.prospects.won)} hint={`${pct(m.prospects.total ? m.prospects.won / m.prospects.total : null)} de conversión · ${num(m.prospects.lost)} perdidos`} />
            <Kpi icon={<CalendarCheck size={14} />} label="Citas del periodo" value={num(m.appointments.total)} hint={`Asistencia: ${pct(m.appointments.showRate)} (${num(m.appointments.completed)} asistieron, ${num(m.appointments.noShow)} no)`} />
            <Kpi
              icon={<Clock size={14} />}
              label="Respuesta de la IA"
              value={seconds(m.response.aiMedianSeconds)}
              hint={`Mediana del primer mensaje · ${num(m.response.aiSamples)} conversaciones`}
            />
          </div>

          <div className="metrics-grid">
            <section className="card" aria-label="Embudo de conversión">
              <div className="card__header">
                <BarChart3 size={16} /> Embudo de conversión
              </div>
              <div className="card__body stack" style={{ gap: 8 }}>
                <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                  Hasta dónde llegó cada prospecto (aunque después se haya perdido).
                </p>
                {m.funnel.map((f) => (
                  <div key={f.stage} className="funnel__row">
                    <span className="funnel__label">{STAGE_LABEL[f.stage]}</span>
                    <span className="funnel__track" aria-hidden>
                      <span className="funnel__bar" style={{ width: `${Math.max(f.pct * 100, f.count ? 2 : 0)}%` }} />
                    </span>
                    <span className="funnel__value num">
                      {num(f.count)} <span className="muted">· {pct(f.pct)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </section>

            <section className="card" aria-label="Atención de asesores">
              <div className="card__header">
                <Clock size={16} /> Atención de asesores
              </div>
              <div className="card__body stack" style={{ gap: 10 }}>
                <dl className="dl">
                  <dt>Turnados a un asesor</dt>
                  <dd className="num">{num(m.response.handoffs)}</dd>
                  <dt>Tiempo hasta que un asesor atiende{m.response.advisorBusinessHours && <span className="muted"> (en horario de oficina)</span>}</dt>
                  <dd className="num">{m.response.advisorMedianMinutes === null ? "Sin datos aún" : `${minutes(m.response.advisorMedianMinutes)} (mediana)`}</dd>
                  <dt>Atendidos en 30 min o menos</dt>
                  <dd className="num">{pct(m.response.advisorWithin30Min)}</dd>
                  <dt>Sin atender todavía</dt>
                  <dd className="num">{num(m.response.handoffsPending)}</dd>
                </dl>
                {m.response.handoffReasons.length > 0 && (
                  <div>
                    <strong style={{ fontSize: 13 }}>Por qué se turnaron</strong>
                    <ul className="plain-list">
                      {m.response.handoffReasons.map((r) => (
                        <li key={r.reason}>
                          {HANDOFF_LABEL[r.reason] ?? r.reason} <span className="muted num">· {num(r.count)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Incluye horas fuera del horario de atención.
                </p>
              </div>
            </section>
          </div>

          <div className="metrics-grid">
            <section className="card table-wrap" aria-label="Por vendedor">
              <div className="card__header">
                <Users size={16} /> Por vendedor
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Vendedor</th>
                    <th className="right">Prospectos</th>
                    <th className="right">Citas</th>
                    <th className="right">Vendidos</th>
                    <th className="right">Perdidos</th>
                  </tr>
                </thead>
                <tbody>
                  {m.sellers.map((s) => (
                    <tr key={s.userId}>
                      <td>{s.name}</td>
                      <td className="right num">{num(s.prospects)}</td>
                      <td className="right num">{num(s.appointments)}</td>
                      <td className="right num">{num(s.won)}</td>
                      <td className="right num">{num(s.lost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card" aria-label="Motivos de pérdida">
              <div className="card__header">
                <Trophy size={16} /> Motivos de pérdida
              </div>
              <div className="card__body">
                {m.lostReasons.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    Sin prospectos perdidos en el periodo.
                  </p>
                ) : (
                  <ul className="plain-list">
                    {m.lostReasons.map((r) => (
                      <li key={r.reason}>
                        {r.reason} <span className="muted num">· {num(r.count)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
