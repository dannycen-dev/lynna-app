import { Bot, CalendarClock, CalendarOff, MessageSquareReply, Plus, ShieldCheck, Shuffle, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorAlert, PageHeader, Spinner } from "../components/ui";
import {
  useAssignmentSettings,
  useAgentSettings,
  useFollowupSettings,
  useSaveFollowupSettings,
  useAvailability,
  useAddTimeOff,
  useRemoveTimeOff,
  useTimeOff,
  useSaveAgentSettings,
  usePrivacySettings,
  useSavePrivacySettings,
  useSaveAppointmentSettings,
  useSaveAvailability,
  useTeam,
  useUpdateAssignmentSettings,
  useUpdateTeamMember,
} from "../lib/api";
import { isoDate, ROLE_LABEL, timeAgo, todayMx } from "../lib/format";
import { useWeekHours, WeekHoursGrid } from "../components/WeekHours";
import type { AvailabilityRule, FollowupStep, TimeOffConflict } from "../lib/types";
import { useSession } from "../lib/session";

export function Configuracion() {
  const { canWrite } = useSession();
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHeader title="Configuración" subtitle="Cómo se reparten los prospectos y cuándo recibe visitas tu equipo." />
      {!canWrite && <div className="alert alert--info" style={{ marginBottom: 16 }}>Solo un gerente o dueño puede cambiar el reparto. Tu horario de citas sí lo puedes ajustar.</div>}
      <div className="stack">
        <AgentCard disabled={!canWrite} />
        <FollowupsCard disabled={!canWrite} />
        <AssignmentCard disabled={!canWrite} />
        <TeamCard disabled={!canWrite} />
        <AvailabilityCard canWrite={canWrite} />
        <TimeOffCard canWrite={canWrite} />
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

function TimeOffCard({ canWrite }: { canWrite: boolean }) {
  const { me } = useSession();
  const list = useTimeOff();
  const members = useAvailability().data?.members ?? [];
  const add = useAddTimeOff();
  const remove = useRemoveTimeOff();
  const myId = me?.user.id ?? "";
  // "" = toda la oficina (solo gerente o dueño); un vendedor solo registra los suyos.
  const [who, setWho] = useState(canWrite ? "" : myId);
  const [from, setFrom] = useState(todayMx());
  const [to, setTo] = useState(todayMx());
  const [reason, setReason] = useState("");
  const [conflicts, setConflicts] = useState<TimeOffConflict[] | null>(null);
  useEffect(() => {
    if (!canWrite && myId) setWho(myId);
  }, [canWrite, myId]);
  const invalid = !from || !to || to < from;
  const submit = () =>
    add.mutate(
      { userId: who || null, startDate: from, endDate: to, reason: reason.trim() || undefined },
      {
        onSuccess: (r) => {
          setConflicts(r.conflicts);
          setReason("");
        },
      },
    );
  const range = (a: string, b: string) => (a === b ? isoDate(a) : `${isoDate(a)} al ${isoDate(b)}`);
  return (
    <div className="card">
      <div className="card__header">
        <CalendarOff size={16} /> Días libres y días festivos
      </div>
      <div className="card__body stack">
        <p className="muted" style={{ margin: 0 }}>
          Vacaciones o permisos de un vendedor, o días en que cierra toda la oficina. Esos días la IA no ofrece visitas con esa persona; si cierra la oficina, tampoco promete que un asesor contactará ese día.
        </p>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="off-who">Quién</label>
            <select id="off-who" className="select" value={who} onChange={(e) => setWho(e.target.value)} disabled={!canWrite}>
              {canWrite && <option value="">Toda la oficina</option>}
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="off-from">Desde</label>
            <input id="off-from" className="input" type="date" value={from} min={todayMx()} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="off-to">Hasta</label>
            <input id="off-to" className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="off-reason">Motivo (opcional)</label>
            <input id="off-reason" className="input" value={reason} maxLength={120} placeholder="Vacaciones, día festivo…" onChange={(e) => setReason(e.target.value)} />
          </div>
          <button className="btn btn--primary" disabled={invalid || add.isPending} onClick={submit}>
            <Plus size={14} /> Agregar
          </button>
        </div>
        {invalid && from && to && <div className="alert alert--error">La fecha final no puede ser antes de la inicial.</div>}
        <ErrorAlert error={add.error ?? remove.error ?? list.error} />
        {conflicts && conflicts.length > 0 && (
          <div className="alert alert--warning" role="status">
            <strong>
              {conflicts.length === 1 ? "Hay 1 cita" : `Hay ${conflicts.length} citas`} en esos días. No se cancelan solas: muévelas desde Citas.
            </strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {conflicts.map((c) => (
                <li key={c.id}>
                  {c.label} — {c.prospectName ?? c.prospectPhone} con {c.userName}
                </li>
              ))}
            </ul>
          </div>
        )}
        {list.isPending ? (
          <Spinner />
        ) : list.data?.length ? (
          <ul className="list-plain" aria-label="Próximos días libres">
            {list.data.map((t) => (
              <li key={t.id} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "6px 0", borderTop: "1px solid var(--lynna-divider)" }}>
                <span>
                  <strong>{t.userName ?? "Toda la oficina"}</strong> · {range(t.startDate, t.endDate)}
                  {t.reason && <span className="muted"> · {t.reason}</span>}
                </span>
                {(canWrite || t.userId === myId) && (
                  <button className="btn btn--ghost btn--sm" disabled={remove.isPending} onClick={() => remove.mutate(t.id)} aria-label={`Quitar ${t.userName ?? "cierre de oficina"} ${range(t.startDate, t.endDate)}`}>
                    <Trash2 size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>No hay días libres registrados.</p>
        )}
      </div>
    </div>
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

const WAIT_OPTIONS = [4, 12, 24, 48, 72, 120, 168, 336];
const waitLabel = (h: number) => (h < 24 ? `${h} horas` : h === 24 ? "1 día" : `${h / 24} días`);

function FollowupsCard({ disabled }: { disabled: boolean }) {
  const settings = useFollowupSettings();
  const save = useSaveFollowupSettings();
  const [enabled, setEnabled] = useState(false);
  const [steps, setSteps] = useState<FollowupStep[]>([]);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) {
      setEnabled(settings.data.enabled);
      setSteps(settings.data.steps);
    }
  }, [settings.data]);
  if (settings.isPending) return <Spinner />;
  const setStep = (i: number, patch: Partial<FollowupStep>) => {
    setSaved(false);
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };
  const valid = steps.length > 0 && steps.every((s) => s.text.trim().length >= 10);
  return (
    <div className="card">
      <div className="card__header">
        <MessageSquareReply size={16} /> Seguimientos automáticos
      </div>
      <form
        className="card__body stack"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          save.mutate({ enabled, steps: steps.map((s) => ({ ...s, text: s.text.trim() })) }, { onSuccess: () => setSaved(true) });
        }}
      >
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={enabled} disabled={disabled} onChange={(e) => (setEnabled(e.target.checked), setSaved(false))} />
          <strong>Escribir a los prospectos que dejan de responder</strong>
        </label>
        <p className="muted" style={{ margin: 0 }}>
          Se detienen solos si el prospecto responde (y vuelven a empezar si después se queda callado), agenda cita, pide baja, se turna a un asesor o ya apartó. Solo se
          envían en horario de oficina. Usa <code>{"{nombre}"}</code> y <code>{"{desarrollo}"}</code> en el texto.
        </p>
        <div className="alert alert--info">
          Por ahora quedan como <strong>simulados</strong> en la conversación: fuera de las 24 h WhatsApp exige plantillas aprobadas por Meta, que se conectan en la fase de WhatsApp. Cada
          seguimiento será una plantilla de marketing (≈ $0.73 MXN en México, lo paga la desarrolladora a Meta).
        </div>
        {steps.map((s, i) => (
          <section key={i} className="note stack" style={{ gap: 8 }} aria-label={`Seguimiento ${i + 1}`}>
            <div className="row" style={{ gap: 8, justifyContent: "space-between" }}>
              <label className="row" style={{ gap: 8 }}>
                <strong>Seguimiento {i + 1}</strong>
                <span className="muted">{i === 0 ? "tras" : "otros"}</span>
                <select className="select" style={{ width: 130, height: 32 }} value={s.afterHours} disabled={disabled} onChange={(e) => setStep(i, { afterHours: Number(e.target.value) })} aria-label={`Espera del seguimiento ${i + 1}`}>
                  {[...new Set([...WAIT_OPTIONS, s.afterHours])].sort((a, b) => a - b).map((h) => (
                    <option key={h} value={h}>
                      {waitLabel(h)}
                    </option>
                  ))}
                </select>
                <span className="muted">sin respuesta</span>
              </label>
              {steps.length > 1 && (
                <button type="button" className="btn btn--sm btn--ghost" disabled={disabled} onClick={() => (setSteps(steps.filter((_, j) => j !== i)), setSaved(false))} aria-label={`Quitar seguimiento ${i + 1}`}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <textarea className="textarea" style={{ minHeight: 70 }} maxLength={600} value={s.text} disabled={disabled} onChange={(e) => setStep(i, { text: e.target.value })} aria-label={`Texto del seguimiento ${i + 1}`} />
          </section>
        ))}
        <div className="row" style={{ gap: 8 }}>
          {steps.length < 5 && (
            <button type="button" className="btn btn--sm" disabled={disabled} onClick={() => (setSteps([...steps, { afterHours: 72, text: "" }]), setSaved(false))}>
              <Plus size={14} /> Agregar seguimiento
            </button>
          )}
          <button className="btn btn--primary" type="submit" disabled={disabled || save.isPending || !valid}>
            Guardar
          </button>
          {saved && <span className="muted">Guardado</span>}
        </div>
        <ErrorAlert error={save.error ?? settings.error} />
      </form>
    </div>
  );
}
