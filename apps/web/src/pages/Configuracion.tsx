import { Bot, CalendarClock, ShieldCheck, Shuffle, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorAlert, PageHeader, Spinner } from "../components/ui";
import {
  useAssignmentSettings,
  useAgentSettings,
  useAvailability,
  useSaveAgentSettings,
  usePrivacySettings,
  useSavePrivacySettings,
  useSaveAppointmentSettings,
  useSaveAvailability,
  useTeam,
  useUpdateAssignmentSettings,
  useUpdateTeamMember,
} from "../lib/api";
import { ROLE_LABEL, timeAgo } from "../lib/format";
import { useWeekHours, WeekHoursGrid } from "../components/WeekHours";
import type { AvailabilityRule } from "../lib/types";
import { useSession } from "../lib/session";

export function Configuracion() {
  const { canWrite } = useSession();
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHeader title="Configuración" subtitle="Cómo se reparten los prospectos y cuándo recibe visitas tu equipo." />
      {!canWrite && <div className="alert alert--info" style={{ marginBottom: 16 }}>Solo un gerente o dueño puede cambiar el reparto. Tu horario de citas sí lo puedes ajustar.</div>}
      <div className="stack">
        <AgentCard disabled={!canWrite} />
        <AssignmentCard disabled={!canWrite} />
        <TeamCard disabled={!canWrite} />
        <AvailabilityCard canWrite={canWrite} />
        <PrivacyCard disabled={!canWrite} />
      </div>
    </div>
  );
}

function AssignmentCard({ disabled }: { disabled: boolean }) {
  const settings = useAssignmentSettings();
  const update = useUpdateAssignmentSettings();
  const [minutes, setMinutes] = useState("");
  // Estado local: el radio cambia en el mismo clic; luego se guarda (y se revierte si falla).
  const [mode, setMode] = useState<"round_robin" | "manual">("round_robin");

  useEffect(() => {
    if (settings.data) {
      setMinutes(String(settings.data.reassignAfterMinutes));
      setMode(settings.data.assignmentMode);
    }
  }, [settings.data]);

  if (settings.isPending) return <Spinner />;
  const choose = (next: "round_robin" | "manual") => {
    const previous = mode;
    setMode(next);
    update.mutate({ assignmentMode: next }, { onError: () => setMode(previous) });
  };

  return (
    <div className="card">
      <div className="card__header">
        <Shuffle size={16} /> Asignación de prospectos
      </div>
      <div className="card__body stack">
        <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 10 }} disabled={disabled}>
          <legend className="sr-only">Modo de asignación</legend>
          <label className="row" style={{ alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input type="radio" name="mode" checked={mode === "round_robin"} onChange={() => choose("round_robin")} />
            <span>
              <strong>En turno (automático)</strong>
              <span className="muted" style={{ display: "block" }}>
                Cada prospecto nuevo se asigna al vendedor disponible que lleva más tiempo sin recibir uno.
              </span>
            </span>
          </label>
          <label className="row" style={{ alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input type="radio" name="mode" checked={mode === "manual"} onChange={() => choose("manual")} />
            <span>
              <strong>Manual</strong>
              <span className="muted" style={{ display: "block" }}>
                Los prospectos llegan sin vendedor y un gerente los asigna desde la ficha.
              </span>
            </span>
          </label>
        </fieldset>
        <form
          className="row"
          style={{ alignItems: "flex-end", gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ reassignAfterMinutes: Number(minutes) || 0 });
          }}
        >
          <div className="field" style={{ width: 260 }}>
            <label htmlFor="reassign">Reasignar si no atiende en (minutos)</label>
            <input id="reassign" className="input" type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={disabled} />
            <span className="field__hint">Si el prospecto pidió un asesor y nadie tomó la conversación. 0 = nunca. Máximo 2 reasignaciones.</span>
          </div>
          <button className="btn" type="submit" disabled={disabled || update.isPending || minutes === String(settings.data?.reassignAfterMinutes)}>
            Guardar
          </button>
        </form>
        <ErrorAlert error={update.error ?? settings.error} />
      </div>
    </div>
  );
}

function TeamCard({ disabled }: { disabled: boolean }) {
  const team = useTeam();
  const update = useUpdateTeamMember();
  return (
    <div className="card table-wrap">
      <div className="card__header">
        <Users size={16} /> Equipo
      </div>
      {team.isPending && <Spinner />}
      <table className="table">
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Rol</th>
            <th>Recibe prospectos</th>
            <th>Último asignado</th>
          </tr>
        </thead>
        <tbody>
          {team.data?.map((u) => (
            <tr key={u.id}>
              <td>
                <strong>{u.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {u.email}
                </div>
              </td>
              <td>{ROLE_LABEL[u.role] ?? u.role}</td>
              <td>
                {u.role === "seller" ? (
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={u.receivesLeads}
                      disabled={disabled || update.isPending || !u.active}
                      onChange={(e) => update.mutate({ id: u.id, receivesLeads: e.target.checked })}
                      aria-label={`${u.name} recibe prospectos`}
                    />
                    <span>{u.receivesLeads ? "Sí" : "No"}</span>
                  </label>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td className="muted">{u.lastAssignedAt ? timeAgo(u.lastAssignedAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ padding: "0 16px 16px" }}>
        <ErrorAlert error={update.error ?? team.error} />
      </div>
    </div>
  );
}

function AvailabilityCard({ canWrite }: { canWrite: boolean }) {
  const availability = useAvailability();
  const saveSettings = useSaveAppointmentSettings();
  if (availability.isPending) return <Spinner />;
  const data = availability.data;
  return (
    <div className="card">
      <div className="card__header">
        <CalendarClock size={16} /> Horarios de citas
      </div>
      <div className="card__body stack">
        <p className="muted" style={{ margin: 0 }}>
          La IA solo ofrece visitas en estos horarios y nunca empalma dos citas del mismo vendedor. Si el prospecto ya tiene vendedor con horario, se agenda con él; si no, con quien esté libre.
        </p>
        {data && (
          <div className="field" style={{ width: 260 }}>
            <label htmlFor="appt-minutes">Duración de cada cita</label>
            <select
              id="appt-minutes"
              className="select"
              value={data.appointmentMinutes}
              disabled={!canWrite || saveSettings.isPending}
              onChange={(e) => saveSettings.mutate({ appointmentMinutes: Number(e.target.value) })}
            >
              {[30, 45, 60, 90, 120].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutos` : m === 60 ? "1 hora" : `${m / 60} horas`}
                </option>
              ))}
            </select>
          </div>
        )}
        <ErrorAlert error={saveSettings.error ?? availability.error} />
        {data?.members.map((m) => <MemberSchedule key={m.id} member={m} />)}
        {data?.members.length === 0 && <p className="muted">No hay vendedores activos.</p>}
      </div>
    </div>
  );
}

function MemberSchedule({ member }: { member: { id: string; name: string; role: string; rules: AvailabilityRule[] } }) {
  const save = useSaveAvailability();
  const hours = useWeekHours(member.rules);
  const [saved, setSaved] = useState(false);
  return (
    <section className="note" aria-label={`Horario de ${member.name}`}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <strong>
          {member.name} <span className="muted" style={{ fontWeight: 400 }}>· {ROLE_LABEL[member.role] ?? member.role}</span>
        </strong>
        <span className="row" style={{ gap: 8 }}>
          {saved && !hours.dirty && <span className="muted">Guardado</span>}
          <button
            className="btn btn--sm btn--primary"
            disabled={save.isPending || hours.invalid}
            onClick={() => save.mutate({ userId: member.id, rules: hours.value() }, { onSuccess: () => setSaved(true) })}
          >
            Guardar horario
          </button>
        </span>
      </div>
      <WeekHoursGrid hours={hours} dayLabel={(day) => `${member.name} atiende el ${day}`} />
      <ErrorAlert error={save.error} />
    </section>
  );
}

function PrivacyCard({ disabled }: { disabled: boolean }) {
  const { tenants, tenant } = useSession();
  const settings = usePrivacySettings();
  const save = useSavePrivacySettings();
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) {
      setUrl(settings.data.privacyNoticeUrl ?? "");
      setText(settings.data.privacyNoticeText ?? "");
    }
  }, [settings.data]);
  const company = tenants.find((t) => t.slug === tenant)?.name ?? "La desarrolladora";
  // Misma regla que la API (privacy/consent.ts → privacyNotice).
  const preview = text.trim()
    ? url.trim() && !text.includes(url.trim())
      ? `${text.trim()} ${url.trim()}`
      : text.trim()
    : url.trim()
      ? `🔒 ${company} trata tus datos personales conforme a su aviso de privacidad: ${url.trim()}`
      : `🔒 ${company} trata tus datos personales conforme a su aviso de privacidad; pídelo a tu asesor cuando quieras.`;
  if (settings.isPending) return <Spinner />;
  return (
    <div className="card">
      <div className="card__header">
        <ShieldCheck size={16} /> Privacidad (LFPDPPP)
      </div>
      <form
        className="card__body stack"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ privacyNoticeUrl: url.trim() || null, privacyNoticeText: text.trim() || null }, { onSuccess: () => setSaved(true) });
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          La IA manda el aviso de privacidad en su primera respuesta a cada prospecto, y pide autorización antes de guardar presupuesto o enganche (datos financieros, art. 7).
        </p>
        <div className="field">
          <label htmlFor="privacy-url">Enlace al aviso de privacidad</label>
          <input id="privacy-url" className="input" type="url" placeholder="https://tudesarrolladora.mx/aviso-de-privacidad" value={url} onChange={(e) => setUrl(e.target.value)} disabled={disabled} />
          <span className="field__hint">Debe ser https. Si no hay enlace, el aviso dice que lo pidan a su asesor.</span>
        </div>
        <div className="field">
          <label htmlFor="privacy-text">Texto del aviso (opcional)</label>
          <textarea id="privacy-text" className="textarea" maxLength={500} value={text} onChange={(e) => setText(e.target.value)} disabled={disabled} placeholder="Déjalo vacío para usar el texto estándar." />
        </div>
        <div className="note">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Así lo verá el prospecto:
          </div>
          <div aria-label="Vista previa del aviso">{preview}</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--primary" type="submit" disabled={disabled || save.isPending}>
            Guardar
          </button>
          {saved && <span className="muted">Guardado</span>}
        </div>
        <ErrorAlert error={save.error ?? settings.error} />
      </form>
    </div>
  );
}

function AgentCard({ disabled }: { disabled: boolean }) {
  const settings = useAgentSettings();
  const save = useSaveAgentSettings();
  const [name, setName] = useState("");
  const hours = useWeekHours(settings.data?.businessHours);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setName(settings.data.assistantName);
  }, [settings.data]);
  if (settings.isPending) return <Spinner />;
  const eta = settings.data?.advisorEtaNow ?? "en breve";
  return (
    <div className="card">
      <div className="card__header">
        <Bot size={16} /> Asistente y horario de atención
      </div>
      <form
        className="card__body stack"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ assistantName: name.trim(), businessHours: hours.value() }, { onSuccess: () => setSaved(true) });
        }}
      >
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="assistant-name">Nombre del asistente</label>
          <input id="assistant-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} disabled={disabled} />
          <span className="field__hint">Así se presenta la IA por WhatsApp.</span>
        </div>
        <div>
          <strong>Horario de atención de los asesores</strong>
          <p className="muted" style={{ margin: "4px 0 10px" }}>
            La IA contesta a cualquier hora. Fuera de este horario, cuando turna a un asesor, le dice al prospecto cuándo lo van a contactar en lugar de "en breve". Sin horario, siempre dice "en breve".
          </p>
          <WeekHoursGrid hours={hours} dayLabel={(day) => `Oficina abierta el ${day}`} disabled={disabled} />
        </div>
        <div className="note" aria-label="Qué promete la IA ahora">
          Si alguien pide un asesor en este momento, la IA le dirá: <strong>"Un asesor te contactará {eta}."</strong>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--primary" type="submit" disabled={disabled || save.isPending || hours.invalid || name.trim().length < 2}>
            Guardar
          </button>
          {saved && <span className="muted">Guardado</span>}
        </div>
        <ErrorAlert error={save.error ?? settings.error} />
      </form>
    </div>
  );
}
