import { AlertTriangle, Bot, ChevronDown, ChevronRight, Paperclip, RotateCcw, Send, ShieldCheck, UserCheck, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useSimulatorHistory, useSimulatorReset, useSimulatorSend } from "../lib/api";
import { dateTime, HANDOFF_LABEL, money, PURPOSE_LABEL, STAGE_LABEL, temperature, TIMEFRAME_LABEL, TOOL_LABEL } from "../lib/format";
import type { AiAudit, ToolTrace } from "../lib/types";

// Preguntas típicas del cliente, incluidas las que la IA NO debe resolver sola.
const SUGGESTIONS = [
  "Hola, ¿qué terrenos tienen?",
  "Busco algo de menos de 700 mil pesos",
  "¿Cuánto pagaría al mes a 12 meses sin intereses?",
  "Me llamo Ana, tengo 150 mil de enganche y es para vivir",
  "¿Me haces un descuento?",
  "¿Cuándo me entregan las escrituras?",
  "Quiero comprar, ¿cómo lo aparto?",
];

export function Simulador() {
  const history = useSimulatorHistory();
  const send = useSimulatorSend();
  const reset = useSimulatorReset();
  const [text, setText] = useState("");
  const [pendingText, setPendingText] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const messages = history.data?.messages ?? [];
  const audits = history.data?.audit ?? [];
  const lastAudit = audits[0];
  const prospect = send.data?.prospect ?? history.data?.prospect ?? null;

  useEffect(() => {
    // Con llaves: scrollIntoView devuelve una Promise en Chromium reciente y React la tomaría como cleanup.
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pendingText]);

  const submit = (message: string, type: "text" | "image" = "text") => {
    if (!message.trim() || send.isPending) return;
    setPendingText(message);
    setText("");
    send.mutate({ message, type }, { onSettled: () => setPendingText(null) });
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(text);
  };

  return (
    <div className="page" style={{ maxWidth: 1360 }}>
      <PageHeader
        title="Agente de IA"
        subtitle="Conversa con el agente como si fueras un prospecto por WhatsApp. Usa el mismo código, inventario y reglas que atenderán a los clientes reales."
        actions={
          <button className="btn" onClick={() => reset.mutate()} disabled={reset.isPending || messages.length === 0}>
            <RotateCcw size={16} /> Nueva conversación
          </button>
        }
      />

      <div className="sim">
        <section className="sim__chat card" aria-label="Conversación">
          <header className="sim__chat-header">
            <span className="sim__avatar">
              <Bot size={18} />
            </span>
            <div>
              <strong>Lynna</strong>
              <div className="sim__status">{send.isPending ? "escribiendo…" : "asistente virtual"}</div>
            </div>
          </header>

          <div className="sim__messages chat">
            {history.isPending && <Spinner />}
            {!history.isPending && messages.length === 0 && !pendingText && (
              <div className="sim__empty">
                <p>Escribe como lo haría un prospecto, o prueba una de estas:</p>
                <div className="chips" style={{ justifyContent: "center" }}>
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`bubble bubble--${m.direction === "in" ? "out" : "in"}`}>
                {m.type !== "text" && <em className="muted">[{m.type === "image" ? "imagen" : "archivo"}] </em>}
                {m.body}
                <span className="bubble__meta">{dateTime(m.createdAt)}</span>
              </div>
            ))}
            {pendingText && (
              <>
                <div className="bubble bubble--out">{pendingText}</div>
                <div className="bubble bubble--in sim__typing" aria-label="La IA está escribiendo">
                  <span />
                  <span />
                  <span />
                </div>
              </>
            )}
            <div ref={endRef} />
          </div>

          {messages.length > 0 && (
            <div className="sim__suggestions">
              {SUGGESTIONS.slice(1).map((s) => (
                <button key={s} className="chip" onClick={() => submit(s)} disabled={send.isPending}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <form className="sim__composer" onSubmit={onSubmit}>
            <button
              type="button"
              className="btn btn--ghost"
              title="Simular que el prospecto envía una foto de su INE"
              onClick={() => submit("Foto de mi INE", "image")}
              disabled={send.isPending}
            >
              <Paperclip size={18} />
            </button>
            <input
              className="input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escribe un mensaje"
              aria-label="Mensaje"
              disabled={send.isPending}
              maxLength={2000}
            />
            <button className="btn btn--primary" type="submit" disabled={send.isPending || !text.trim()} aria-label="Enviar">
              <Send size={16} />
            </button>
          </form>
          <div style={{ padding: "0 16px 12px" }}>
            <ErrorAlert error={send.error ?? reset.error} />
          </div>
        </section>

        <aside className="sim__inspector stack">
          <div className="card">
            <div className="card__header">
              <Wrench size={16} /> Qué hizo la IA
              {lastAudit && <span className="muted" style={{ marginLeft: "auto", fontWeight: 500, fontSize: 12 }}>último mensaje</span>}
            </div>
            <div className="card__body">
              {!lastAudit ? (
                <p className="muted" style={{ margin: 0 }}>
                  Aquí verás las herramientas que usó, qué bloqueó el validador y si turnó a un asesor.
                </p>
              ) : (
                <AuditDetail audit={lastAudit} />
              )}
            </div>
          </div>

          <div className="card">
            <div className="card__header">
              <UserCheck size={16} /> Prospecto
            </div>
            <div className="card__body">
              {!prospect ? (
                <p className="muted" style={{ margin: 0 }}>
                  Se crea con el primer mensaje.
                </p>
              ) : (
                <dl className="dl">
                  <dt>Calificación</dt>
                  <dd>
                    <span className={`badge badge--${temperature(prospect.score).tone}`}>{temperature(prospect.score).label}</span>{" "}
                    <span className="muted num">{prospect.score}/100</span>
                  </dd>
                  <dt>Etapa</dt>
                  <dd>{STAGE_LABEL[prospect.stage] ?? prospect.stage}</dd>
                  <dt>Nombre</dt>
                  <dd>{prospect.name ?? "—"}</dd>
                  <dt>Presupuesto</dt>
                  <dd className="num">{prospect.budgetCents ? money(prospect.budgetCents) : "—"}</dd>
                  <dt>Enganche</dt>
                  <dd className="num">{prospect.downPaymentCents ? money(prospect.downPaymentCents) : "—"}</dd>
                  <dt>Uso</dt>
                  <dd>{prospect.purpose ? PURPOSE_LABEL[prospect.purpose] : "—"}</dd>
                  <dt>Plazo</dt>
                  <dd>{prospect.timeframe ? TIMEFRAME_LABEL[prospect.timeframe] : "—"}</dd>
                  {prospect.handoffReason && (
                    <>
                      <dt>Asesor</dt>
                      <dd>
                        <span className="badge badge--reserved">{HANDOFF_LABEL[prospect.handoffReason] ?? prospect.handoffReason}</span>
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </div>
          </div>

          <div className="alert alert--info">
            <ShieldCheck size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              La IA no puede dar descuentos, apartar, confirmar pagos ni prometer fechas: esas acciones no existen para ella, y un validador revisa cada
              respuesta antes de enviarla.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AuditDetail({ audit }: { audit: AiAudit }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        {audit.escalation && <span className="badge badge--reserved">{HANDOFF_LABEL[audit.escalation] ?? audit.escalation} → asesor</span>}
        {audit.fallback && <span className="badge badge--sold">Mensaje de respaldo</span>}
        {audit.blocked.length === 0 && !audit.fallback && <span className="badge badge--available">Validada</span>}
      </div>
      {audit.toolCalls.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>
          Sin herramientas{audit.model === "ninguno" ? " (respuesta automática, sin IA)" : ""}.
        </p>
      ) : (
        <ol className="sim__tools">
          {audit.toolCalls.map((t, i) => (
            <ToolItem key={i} tool={t} />
          ))}
        </ol>
      )}
      {audit.blocked.length > 0 && (
        <div className="alert alert--warning">
          <AlertTriangle size={16} style={{ flex: "none", marginTop: 1 }} />
          <span>
            <strong>El validador bloqueó:</strong> {audit.blocked.join(" · ")}
          </span>
        </div>
      )}
      <div className="muted num" style={{ fontSize: 12 }}>
        {audit.model} · {(audit.latencyMs / 1000).toFixed(1)} s · {Math.round(audit.neurons)} neuronas
      </div>
    </div>
  );
}

function ToolItem({ tool }: { tool: ToolTrace }) {
  const [open, setOpen] = useState(false);
  let result: unknown = tool.result;
  try {
    result = JSON.parse(tool.result);
  } catch {
    // se muestra como texto
  }
  return (
    <li>
      <button className="sim__tool" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <strong>{TOOL_LABEL[tool.name] ?? tool.name}</strong>
        {Object.keys(tool.args).length > 0 && <span className="muted"> {JSON.stringify(tool.args)}</span>}
      </button>
      {open && <pre className="sim__json">{JSON.stringify(result, null, 2)}</pre>}
    </li>
  );
}
