import { ArrowLeft, Bot, CalendarCheck, Download, History, MessageCircle, Send, ShieldCheck, StickyNote, Trash2, UserCheck, UserRoundCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Dialog, Empty, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import {
  useAddNote,
  useAssign,
  useBookAppointment,
  useChangeStage,
  useDeleteProspect,
  useProspect,
  useProspectExportUrl,
  useSendHumanMessage,
  useSlots,
  useTakeover,
  useTeam,
} from "../lib/api";
import {
  addDaysIso,
  APPOINTMENT_STATUS_LABEL,
  capitalize,
  dateTime,
  HANDOFF_LABEL,
  HISTORY_LABEL,
  money,
  PURPOSE_LABEL,
  STAGE_LABEL,
  STAGE_ORDER,
  temperature,
  TIMEFRAME_LABEL,
  timeAgo,
  todayMx,
} from "../lib/format";
import { useSession } from "../lib/session";
import type { HistoryItem, Message, Prospect, ProspectDetail, ProspectStage } from "../lib/types";
import { STATUS_TONE } from "./Agenda";
import { displayName, formatPhone } from "./Prospectos";

const AUTHOR_LABEL: Record<Message["author"], string> = { prospect: "Prospecto", ai: "IA", user: "Asesor", system: "Sistema" };

export function ProspectoFicha() {
  const { id } = useParams();
  const detail = useProspect(id);
  const { me } = useSession();

  if (detail.isPending) return <Spinner />;
  if (!detail.data) {
    return (
      <div className="page">
        <ErrorAlert error={detail.error} />
        <Empty title="Prospecto no encontrado">
          <Link to="/prospectos">Volver a prospectos</Link>
        </Empty>
      </div>
    );
  }

  const { prospect, conversation, messages, notes, history } = detail.data;
  const t = temperature(prospect.score);

  return (
    <div className="page" style={{ maxWidth: 1360 }}>
      <Link to="/prospectos" className="backlink">
        <ArrowLeft size={16} /> Prospectos
      </Link>
      <PageHeader
        title={displayName(prospect)}
        subtitle={
          <span className="row" style={{ gap: 8 }}>
            <span className={`badge badge--${t.tone}`}>{t.label}</span>
            <span className="num">{prospect.score}/100</span>
            <span>·</span>
            <span>{prospect.source === "simulator" ? "Simulador" : formatPhone(prospect.phone)}</span>
            {prospect.handoffReason && <span className="badge badge--reserved">{HANDOFF_LABEL[prospect.handoffReason] ?? prospect.handoffReason}</span>}
          </span>
        }
        actions={<StageSelect id={prospect.id} stage={prospect.stage as ProspectStage} />}
      />

      <div className="sim">
        <section className="card sim__chat" aria-label="Conversación">
          {conversation ? (
            <Conversation
              conversationId={conversation.id}
              aiPaused={conversation.aiPaused}
              takenByName={conversation.takenByName}
              takenByMe={conversation.takenByUserId === me?.user.id}
              messages={messages}
              optedOut={Boolean(prospect.optedOutAt)}
            />
          ) : (
            <Empty icon={<MessageCircle size={40} />} title="Sin conversación" />
          )}
        </section>

        <aside className="stack">
          <div className="card">
            <div className="card__header">
              <UserCheck size={16} /> Datos del prospecto
            </div>
            <div className="card__body">
              <dl className="dl">
                <dt>Vendedor</dt>
                <dd>
                  <AssignSelect id={prospect.id} assignedUserId={prospect.assignedUserId} assignedName={prospect.assignedName} />
                </dd>
                <dt>Nombre</dt>
                <dd>{prospect.name ?? "—"}</dd>
                <dt>Perfil de WhatsApp</dt>
                <dd>{prospect.profileName ?? "—"}</dd>
                <dt>Correo</dt>
                <dd>{prospect.email ?? "—"}</dd>
                <dt>Ciudad</dt>
                <dd>{prospect.city ?? "—"}</dd>
                <dt>Presupuesto</dt>
                <dd className="num">{prospect.budgetCents ? money(prospect.budgetCents) : "—"}</dd>
                <dt>Enganche</dt>
                <dd className="num">{prospect.downPaymentCents ? money(prospect.downPaymentCents) : "—"}</dd>
                <dt>Uso</dt>
                <dd>{prospect.purpose ? PURPOSE_LABEL[prospect.purpose] : "—"}</dd>
                <dt>Plazo</dt>
                <dd>{prospect.timeframe ? TIMEFRAME_LABEL[prospect.timeframe] : "—"}</dd>
                <dt>Primer contacto</dt>
                <dd>{dateTime(prospect.createdAt)}</dd>
              </dl>
            </div>
          </div>
          <Appointments prospectId={prospect.id} appointments={detail.data.appointments} />
          <Privacy prospect={prospect} />
          <Notes prospectId={prospect.id} notes={notes} />
          <Timeline history={history} />
        </aside>
      </div>
    </div>
  );
}

function AssignSelect({ id, assignedUserId, assignedName }: { id: string; assignedUserId: string | null; assignedName: string | null }) {
  const { me } = useSession();
  const team = useTeam();
  const assign = useAssign();
  if (me?.user.role === "seller") return <>{assignedName ?? "Sin asignar"}</>;
  return (
    <>
      <select
        className="select"
        style={{ height: 32, maxWidth: 200 }}
        aria-label="Asignar vendedor"
        value={assignedUserId ?? ""}
        disabled={assign.isPending}
        onChange={(e) => assign.mutate({ id, userId: e.target.value || null })}
      >
        <option value="">Sin asignar</option>
        {team.data
          ?.filter((u) => u.active && u.role !== "admin")
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
      </select>
      <ErrorAlert error={assign.error} />
    </>
  );
}

function StageSelect({ id, stage }: { id: string; stage: ProspectStage }) {
  const change = useChangeStage();
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="stack" style={{ gap: 4, alignItems: "flex-end" }}>
      <label className="row" style={{ gap: 8 }}>
        <span className="muted">Etapa</span>
        <select
          className="select"
          style={{ width: 200 }}
          value={stage}
          disabled={change.isPending}
          onChange={(e) => {
            const next = e.target.value as ProspectStage;
            let reason: string | undefined;
            if (next === "lost") {
              reason = window.prompt("¿Por qué se perdió?")?.trim();
              if (!reason) return;
            }
            setError(null);
            change.mutate({ id, stage: next, ...(reason ? { reason } : {}) }, { onError: setError });
          }}
        >
          {STAGE_ORDER.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <ErrorAlert error={error} />
    </div>
  );
}

function Conversation(props: { conversationId: string; aiPaused: boolean; takenByName: string | null; takenByMe: boolean; messages: Message[]; optedOut: boolean }) {
  const takeover = useTakeover();
  const send = useSendHumanMessage();
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [props.messages.length]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    send.mutate({ conversationId: props.conversationId, body: text.trim() }, { onSuccess: () => setText("") });
  };

  return (
    <>
      <header className="sim__chat-header" style={{ justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 10 }}>
          <span className="sim__avatar">{props.aiPaused ? <UserRoundCheck size={18} /> : <Bot size={18} />}</span>
          <span>
            <strong>{props.aiPaused ? `Atiende ${props.takenByMe ? "tú" : (props.takenByName ?? "un asesor")}` : "Atiende la IA"}</strong>
            <span className="sim__status" style={{ display: "block" }}>
              {props.aiPaused ? "La IA está en pausa en esta conversación" : "Lynna responde automáticamente"}
            </span>
          </span>
        </span>
        <button
          className="navbar__btn"
          disabled={takeover.isPending}
          onClick={() => takeover.mutate({ conversationId: props.conversationId, take: !props.aiPaused })}
        >
          {props.aiPaused ? (
            <>
              <Bot size={16} /> Devolver a la IA
            </>
          ) : (
            <>
              <UserRoundCheck size={16} /> Tomar conversación
            </>
          )}
        </button>
      </header>

      <div className="sim__messages chat">
        {props.messages.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.direction === "in" ? "in" : "out"}${m.author === "user" ? " bubble--human" : ""}`}>
            {m.type !== "text" && <em className="muted">[{m.type === "image" ? "imagen" : "archivo"}] </em>}
            {m.body}
            <span className="bubble__meta">
              {m.direction === "out" && `${AUTHOR_LABEL[m.author]} · `}
              {dateTime(m.waTimestamp ?? m.createdAt)}
              {m.direction === "out" && m.status === "simulated" && " · simulado"}
              {m.status === "failed" && " · no enviado"}
            </span>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {props.optedOut ? (
        <div className="alert alert--warning" style={{ margin: 12 }}>
          El prospecto pidió no recibir más mensajes.
        </div>
      ) : (
        <form className="sim__composer" onSubmit={submit}>
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={props.aiPaused ? "Escribe tu respuesta" : "Escribe para tomar la conversación (la IA se pausará)"}
            aria-label="Respuesta del asesor"
            maxLength={4000}
            disabled={send.isPending}
          />
          <button className="btn btn--primary" type="submit" disabled={send.isPending || !text.trim()} aria-label="Enviar respuesta">
            <Send size={16} />
          </button>
        </form>
      )}
      <div style={{ padding: "0 12px 12px" }}>
        <ErrorAlert error={send.error ?? takeover.error} />
      </div>
    </>
  );
}

function Appointments({ prospectId, appointments }: { prospectId: string; appointments: ProspectDetail["appointments"] }) {
  const [open, setOpen] = useState(false);
  const upcoming = appointments.find((a) => a.status === "scheduled" && a.endsAt >= Date.now());
  return (
    <div className="card">
      <div className="card__header">
        <CalendarCheck size={16} /> Citas
        <button className="btn btn--sm" style={{ marginLeft: "auto" }} onClick={() => setOpen(true)}>
          {upcoming ? "Reagendar" : "Agendar cita"}
        </button>
      </div>
      <div className="card__body stack" style={{ gap: 8 }}>
        {appointments.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            Sin citas. La IA agenda cuando el prospecto quiere visitar el desarrollo.
          </p>
        )}
        {appointments.map((a) => (
          <div key={a.id} className="row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span>
              <strong>{capitalize(a.label)}</strong>
              <span className="muted" style={{ display: "block", fontSize: 12 }}>
                {a.sellerName}
                {a.source === "ai" ? " · la agendó la IA" : ""}
                {a.cancelReason ? ` · ${a.cancelReason}` : ""}
              </span>
            </span>
            <span className={`badge badge--${STATUS_TONE[a.status]}`}>{APPOINTMENT_STATUS_LABEL[a.status]}</span>
          </div>
        ))}
      </div>
      {open && <BookDialog prospectId={prospectId} rescheduling={Boolean(upcoming)} onClose={() => setOpen(false)} />}
    </div>
  );
}

function BookDialog({ prospectId, rescheduling, onClose }: { prospectId: string; rescheduling: boolean; onClose: () => void }) {
  const { me } = useSession();
  const team = useTeam();
  const [date, setDate] = useState(addDaysIso(todayMx(), 1));
  // "Cualquiera libre": el servidor ya propone primero al vendedor del prospecto si tiene horario.
  const [userId, setUserId] = useState<string>("");
  const slots = useSlots(date, prospectId, me?.user.role === "seller" ? null : userId || null);
  const book = useBookAppointment();
  return (
    <Dialog open onClose={onClose} title={rescheduling ? "Reagendar la cita" : "Agendar cita"} footer={<button className="btn" onClick={onClose}>Cerrar</button>}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="row" style={{ gap: 12, alignItems: "flex-end" }}>
          <div className="field">
            <label htmlFor="appt-date">Día</label>
            <input id="appt-date" className="input" type="date" min={todayMx()} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          {me?.user.role !== "seller" && (
            <div className="field">
              <label htmlFor="appt-seller">Vendedor</label>
              <select id="appt-seller" className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Cualquiera libre</option>
                {team.data
                  ?.filter((u) => u.active && u.role !== "admin")
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
        </div>
        {slots.isPending && <Spinner label="Buscando horarios…" />}
        <ErrorAlert error={slots.error ?? book.error} />
        {slots.data?.length === 0 && <p className="muted" style={{ margin: 0 }}>No hay horarios libres ese día. Prueba otro día o revisa los horarios en Configuración.</p>}
        <div className="slots" role="list" aria-label="Horarios libres">
          {slots.data?.map((s) => (
            <button
              key={`${s.userId}-${s.startsAt}`}
              role="listitem"
              className="btn btn--sm"
              disabled={book.isPending}
              onClick={() => book.mutate({ prospectId, startsAt: s.startsAt, userId: s.userId }, { onSuccess: onClose })}
            >
              {s.time}
              {!userId && me?.user.role !== "seller" ? ` · ${s.userName}` : ""}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function Privacy({ prospect }: { prospect: ProspectDetail["prospect"] }) {
  const { canWrite } = useSession();
  const exportUrl = useProspectExportUrl(prospect.id);
  const remove = useDeleteProspect();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState("");
  const pending = prospect.pendingFinancial;
  const consent = prospect.consentAt
    ? { tone: "available", label: "Autorizó", detail: `${dateTime(prospect.consentAt)}${prospect.consentText ? ` · respondió "${prospect.consentText}"` : ""}` }
    : prospect.consentDeniedAt
      ? { tone: "sold", label: "No autorizó", detail: dateTime(prospect.consentDeniedAt) }
      : prospect.consentRequestedAt
        ? { tone: "reserved", label: "Pendiente", detail: `Se le preguntó ${timeAgo(prospect.consentRequestedAt)}` }
        : { tone: "info", label: "No se ha pedido", detail: "Se pide cuando comparte presupuesto o enganche" };
  return (
    <div className="card">
      <div className="card__header">
        <ShieldCheck size={16} /> Privacidad
      </div>
      <div className="card__body stack" style={{ gap: 10 }}>
        <dl className="dl">
          <dt>Aviso de privacidad</dt>
          <dd>{prospect.privacyNoticeAt ? `Enviado ${dateTime(prospect.privacyNoticeAt)}` : "Aún no se envía"}</dd>
          <dt>Datos financieros</dt>
          <dd>
            <span className={`badge badge--${consent.tone}`}>{consent.label}</span>
            <span className="muted" style={{ display: "block", fontSize: 12 }}>
              {consent.detail}
            </span>
          </dd>
          {pending && (pending.budgetCents || pending.downPaymentCents !== undefined) && (
            <>
              <dt>Sin guardar</dt>
              <dd className="muted">
                {[pending.budgetCents ? `presupuesto ${money(pending.budgetCents)}` : null, pending.downPaymentCents !== undefined ? `enganche ${money(pending.downPaymentCents)}` : null]
                  .filter(Boolean)
                  .join(" y ")}{" "}
                — esperando su autorización
              </dd>
            </>
          )}
        </dl>
        {canWrite && (
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn--sm" href={exportUrl} download>
              <Download size={14} /> Exportar datos (ARCO)
            </a>
            <button className="btn btn--sm btn--ghost" onClick={() => setDeleting(true)}>
              <Trash2 size={14} /> Eliminar datos (ARCO)
            </button>
          </div>
        )}
      </div>
      {deleting && (
        <Dialog
          open
          onClose={() => setDeleting(false)}
          title="Eliminar todos los datos del prospecto"
          footer={
            <>
              <button className="btn" onClick={() => setDeleting(false)}>
                Cancelar
              </button>
              <button
                className="btn btn--primary"
                disabled={reason.trim().length < 5 || remove.isPending}
                onClick={() => remove.mutate({ id: prospect.id, reason: reason.trim() }, { onSuccess: () => navigate("/prospectos") })}
              >
                Eliminar definitivamente
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            Se borran la conversación, notas, citas, avisos e historial de <strong>{displayName(prospect)}</strong>. No se puede deshacer. Exporta sus datos antes si el titular
            los pidió.
          </p>
          <div className="field">
            <label htmlFor="arco-reason">Motivo</label>
            <textarea id="arco-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Solicitud de cancelación del titular recibida por correo el 7 de octubre" />
          </div>
          <ErrorAlert error={remove.error} />
        </Dialog>
      )}
    </div>
  );
}

function Notes({ prospectId, notes }: { prospectId: string; notes: { id: string; body: string; createdAt: number; authorName: string | null }[] }) {
  const add = useAddNote(prospectId);
  const [text, setText] = useState("");
  return (
    <div className="card">
      <div className="card__header">
        <StickyNote size={16} /> Notas del equipo
      </div>
      <div className="card__body stack" style={{ gap: 10 }}>
        <form
          className="stack"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate(text.trim(), { onSuccess: () => setText("") });
          }}
        >
          <textarea className="textarea" style={{ minHeight: 64 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Agregar una nota (no la ve el prospecto)" aria-label="Nueva nota" />
          <button className="btn btn--sm" type="submit" disabled={add.isPending || !text.trim()} style={{ alignSelf: "flex-end" }}>
            Guardar nota
          </button>
        </form>
        <ErrorAlert error={add.error} />
        {notes.length === 0 && <p className="muted" style={{ margin: 0 }}>Sin notas.</p>}
        {notes.map((n) => (
          <div key={n.id} className="note">
            <div style={{ whiteSpace: "pre-wrap" }}>{n.body}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {n.authorName ?? "Automatización"} · {timeAgo(n.createdAt)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function describe(h: HistoryItem): string {
  const label = HISTORY_LABEL[h.action] ?? h.action;
  const d = h.data ?? {};
  if (h.action === "stage_change") {
    const reason = d.reason ? ` — ${String(d.reason)}` : "";
    return `${label}: ${STAGE_LABEL[String(d.from)] ?? d.from} → ${STAGE_LABEL[String(d.to)] ?? d.to}${reason}`;
  }
  if (h.action === "assigned" || h.action === "reassigned") return `${label}${d.reason ? ` — ${String(d.reason)}` : ""}`;
  if (h.action.startsWith("appointment_")) return `${label}${d.label ? `: ${String(d.label)}` : ""}${d.reason ? ` — ${String(d.reason)}` : ""}`;
  if (h.action === "handoff") return `${label}: ${HANDOFF_LABEL[String(d.reason)] ?? d.reason}${d.detail ? ` — ${String(d.detail)}` : ""}`;
  return label;
}

function Timeline({ history }: { history: HistoryItem[] }) {
  return (
    <div className="card">
      <div className="card__header">
        <History size={16} /> Historial
      </div>
      <div className="card__body">
        {history.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Sin movimientos.
          </p>
        ) : (
          <ol className="timeline">
            {history.map((h) => (
              <li key={h.id}>
                <div>{describe(h)}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {h.actorName} · {dateTime(h.createdAt)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
