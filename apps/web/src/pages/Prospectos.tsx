import { Bot, CalendarCheck, Columns3, Download, List, MessageCircle, UserRoundCheck, Users, X } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Dialog, Empty, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useChangeStage, useDevelopments, useProspects, useProspectsCsvUrl, useTeam, type ProspectFilters } from "../lib/api";
import { dateTime, HANDOFF_LABEL, initials, money, num, shortDateTime, STAGE_LABEL, STAGE_ORDER, temperature, timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import type { Prospect, ProspectStage } from "../lib/types";

export function formatPhone(wa: string): string {
  // 5219991234567 → +52 1 999 123 4567 (formato legible MX)
  const m = /^52(1?)(\d{3})(\d{3})(\d{4})$/.exec(wa);
  return m ? `+52 ${m[1] ? "1 " : ""}${m[2]} ${m[3]} ${m[4]}` : `+${wa}`;
}

export const displayName = (p: Pick<Prospect, "name" | "profileName">) => p.name ?? p.profileName ?? "Sin nombre";

type View = "tablero" | "lista";

const FILTER_KEYS = ["q", "development", "temperature", "source", "owner", "from", "to"] as const;

export function Prospectos() {
  const navigate = useNavigate();
  const { me, canWrite } = useSession();
  const isSellerUser = me?.user.role === "seller";
  const team = useTeam();
  const developments = useDevelopments();
  const [view, setView] = useState<View>("tablero");
  // Filtros en la URL: sobreviven al ir a una ficha y volver, y se pueden compartir.
  const [params, setParams] = useSearchParams();
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? undefined])) as ProspectFilters;
  const setFilter = (key: (typeof FILTER_KEYS)[number], value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  // La búsqueda espera a que dejes de escribir.
  const [search, setSearch] = useState(filters.q ?? "");
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? "") !== search.trim()) setFilter("q", search.trim());
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters.q]);
  const prospects = useProspects(filters);
  const csvUrl = useProspectsCsvUrl(filters);
  const items = prospects.data?.items ?? [];
  const total = prospects.data?.total ?? items.length;
  const filtered = FILTER_KEYS.some((k) => filters[k]);

  return (
    <div className="page" style={{ maxWidth: view === "tablero" ? "none" : undefined }}>
      <PageHeader
        title="Prospectos"
        subtitle={
          isSellerUser
            ? "Tus prospectos asignados. La calificación la calcula el sistema con lo que el prospecto le contó a la IA."
            : "Llegan por WhatsApp (o del simulador del agente) y se reparten entre los vendedores. La calificación la calcula el sistema."
        }
        actions={
          canWrite && (
            <a className="btn" href={csvUrl} download>
              <Download size={16} /> Exportar CSV
            </a>
          )
        }
      />
      <div className="filters" role="search" aria-label="Filtros de prospectos">
        <input className="input" type="search" placeholder="Buscar por nombre, teléfono o correo" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar prospecto" />
        <select className="select" value={filters.development ?? ""} onChange={(e) => setFilter("development", e.target.value)} aria-label="Filtrar por desarrollo">
          <option value="">Todos los desarrollos</option>
          {developments.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
          <option value="none">Sin desarrollo de interés</option>
        </select>
        <select className="select" value={filters.temperature ?? ""} onChange={(e) => setFilter("temperature", e.target.value)} aria-label="Filtrar por calificación">
          <option value="">Toda calificación</option>
          <option value="listo">Listo para comprar</option>
          <option value="caliente">Caliente</option>
          <option value="tibio">Tibio</option>
          <option value="frio">Frío</option>
        </select>
        <select className="select" value={filters.source ?? ""} onChange={(e) => setFilter("source", e.target.value)} aria-label="Filtrar por origen">
          <option value="">WhatsApp y simulador</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="simulator">Simulador</option>
        </select>
        {!isSellerUser && (
          <select className="select" value={filters.owner ?? ""} onChange={(e) => setFilter("owner", e.target.value)} aria-label="Filtrar por vendedor">
            <option value="">Todos los vendedores</option>
            <option value="none">Sin asignar</option>
            {team.data
              ?.filter((u) => u.active)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        )}
        <label className="filters__date">
          <span className="muted">Desde</span>
          <input className="input" type="date" value={filters.from ?? ""} onChange={(e) => setFilter("from", e.target.value)} aria-label="Primer contacto desde" />
        </label>
        <label className="filters__date">
          <span className="muted">Hasta</span>
          <input className="input" type="date" value={filters.to ?? ""} onChange={(e) => setFilter("to", e.target.value)} aria-label="Primer contacto hasta" />
        </label>
        {filtered && (
          <button
            className="btn btn--ghost"
            onClick={() => {
              setSearch("");
              setParams(new URLSearchParams(), { replace: true });
            }}
          >
            <X size={14} /> Limpiar
          </button>
        )}
      </div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={view === "tablero"} className={`tabs__btn${view === "tablero" ? " active" : ""}`} onClick={() => setView("tablero")}>
            <Columns3 size={16} /> Tablero
          </button>
          <button role="tab" aria-selected={view === "lista"} className={`tabs__btn${view === "lista" ? " active" : ""}`} onClick={() => setView("lista")}>
            <List size={16} /> Lista
          </button>
        </div>
        {prospects.data && (
          <span className="muted" aria-live="polite">
            {total > items.length ? `Mostrando ${num(items.length)} de ${num(total)} — usa los filtros para acotar` : `${num(total)} prospecto${total === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
      {prospects.isPending && <Spinner />}
      <ErrorAlert error={prospects.error} />
      {prospects.data && items.length === 0 && (
        <Empty icon={<Users size={40} />} title={filtered ? "Ningún prospecto con estos filtros" : "Aún no hay prospectos"}>
          {filtered ? "Prueba con otros filtros o límpialos." : "Aparecerán aquí en cuanto alguien escriba al número de WhatsApp conectado o pruebes el agente en el simulador."}
        </Empty>
      )}
      {items.length > 0 && (view === "tablero" ? <Board prospects={items} /> : <ProspectTable prospects={items} onOpen={(p) => navigate(`/prospectos/${p.id}`)} />)}
    </div>
  );
}

function Board({ prospects }: { prospects: Prospect[] }) {
  const navigate = useNavigate();
  const changeStage = useChangeStage();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<ProspectStage | null>(null);
  const [losing, setLosing] = useState<Prospect | null>(null);
  const [reason, setReason] = useState("");

  const columns = useMemo(() => {
    const byStage = new Map<ProspectStage, Prospect[]>(STAGE_ORDER.map((s) => [s, []]));
    for (const p of prospects) byStage.get(p.stage as ProspectStage)?.push(p);
    for (const list of byStage.values()) list.sort((a, b) => (b.lastInboundAt ?? b.updatedAt) - (a.lastInboundAt ?? a.updatedAt));
    return byStage;
  }, [prospects]);

  const move = (prospect: Prospect, stage: ProspectStage) => {
    if (prospect.stage === stage) return;
    if (stage === "lost") {
      setLosing(prospect);
      setReason("");
      return;
    }
    changeStage.mutate({ id: prospect.id, stage });
  };

  const onDrop = (e: DragEvent, stage: ProspectStage) => {
    e.preventDefault();
    setOver(null);
    const prospect = prospects.find((p) => p.id === e.dataTransfer.getData("text/plain"));
    if (prospect) move(prospect, stage);
  };

  return (
    <>
      <ErrorAlert error={changeStage.error} />
      <div className="board" aria-label="Tablero de prospectos">
        {STAGE_ORDER.map((stage) => {
          const items = columns.get(stage) ?? [];
          return (
            <section
              key={stage}
              className={`board__col${over === stage ? " board__col--over" : ""}`}
              aria-label={STAGE_LABEL[stage]}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(stage);
              }}
              onDragLeave={() => setOver((s) => (s === stage ? null : s))}
              onDrop={(e) => onDrop(e, stage)}
            >
              <header className="board__col-header">
                <span>{STAGE_LABEL[stage]}</span>
                <span className="board__count">{items.length}</span>
              </header>
              <div className="board__cards">
                {items.map((p) => {
                  const t = temperature(p.score);
                  return (
                    <article
                      key={p.id}
                      className={`board__card card${dragging === p.id ? " board__card--dragging" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", p.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(p.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => navigate(`/prospectos/${p.id}`)}
                      tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && navigate(`/prospectos/${p.id}`)}
                      aria-label={`${displayName(p)}, ${t.label}`}
                    >
                      <div className="row" style={{ justifyContent: "space-between", gap: 6 }}>
                        <strong className="board__name">{displayName(p)}</strong>
                        <span className={`badge badge--${t.tone}`}>{t.label}</span>
                      </div>
                      {p.budgetCents && <div className="muted num">Presupuesto {money(p.budgetCents)}</div>}
                      {p.nextAppointmentAt && (
                        <div className="row board__appt" style={{ gap: 4, fontSize: 12 }}>
                          <CalendarCheck size={12} /> Cita {shortDateTime(p.nextAppointmentAt)}
                        </div>
                      )}
                      <div className="row" style={{ gap: 4 }}>
                        {p.handoffReason && <span className="badge badge--reserved badge--plain">{HANDOFF_LABEL[p.handoffReason] ?? p.handoffReason}</span>}
                        {p.aiPaused ? (
                          <span className="badge badge--info badge--plain">
                            <UserRoundCheck size={12} /> Asesor
                          </span>
                        ) : (
                          p.conversationId && (
                            <span className="badge badge--sold badge--plain">
                              <Bot size={12} /> IA
                            </span>
                          )
                        )}
                        {p.source === "simulator" && <span className="badge badge--sold badge--plain">Simulador</span>}
                      </div>
                      <div className="muted board__meta">
                        <MessageCircle size={12} /> {num(p.messageCount)} · {p.lastInboundAt ? timeAgo(p.lastInboundAt) : "sin mensajes"}
                        <span className="board__owner" title={p.assignedName ? `Asignado a ${p.assignedName}` : "Sin asignar"}>
                          {p.assignedName ? initials(p.assignedName) : "—"}
                        </span>
                      </div>
                      {/* Alternativa al arrastre (teclado / móvil). */}
                      <label className="sr-only" htmlFor={`stage-${p.id}`}>
                        Mover a
                      </label>
                      <select
                        id={`stage-${p.id}`}
                        className="board__move"
                        value={p.stage}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => move(p, e.target.value as ProspectStage)}
                      >
                        {STAGE_ORDER.map((s) => (
                          <option key={s} value={s}>
                            {STAGE_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <Dialog
        open={losing !== null}
        onClose={() => setLosing(null)}
        title={`Marcar como perdido${losing ? `: ${displayName(losing)}` : ""}`}
        footer={
          <>
            <button className="btn" onClick={() => setLosing(null)}>
              Cancelar
            </button>
            <button
              className="btn btn--primary"
              disabled={reason.trim().length < 3 || changeStage.isPending}
              onClick={() => losing && changeStage.mutate({ id: losing.id, stage: "lost", reason: reason.trim() }, { onSuccess: () => setLosing(null) })}
            >
              Marcar como perdido
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="lost-reason">¿Por qué se perdió?</label>
          <textarea id="lost-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej. Compró en otro desarrollo" />
          <span className="field__hint">Ayuda a entender por qué no se cierran ventas.</span>
        </div>
      </Dialog>
    </>
  );
}

function ProspectTable({ prospects, onOpen }: { prospects: Prospect[]; onOpen: (p: Prospect) => void }) {
  return (
    <div className="card table-wrap">
      <table className="table table--hover">
        <thead>
          <tr>
            <th>Contacto</th>
            <th>Teléfono</th>
            <th>Calificación</th>
            <th>Etapa</th>
            <th className="right">Presupuesto</th>
            <th>Asesor</th>
            <th>Vendedor</th>
            <th className="right">Mensajes</th>
            <th>Último mensaje</th>
          </tr>
        </thead>
        <tbody>
          {prospects.map((p) => (
            <tr key={p.id} onClick={() => onOpen(p)}>
              <td>
                <strong>{displayName(p)}</strong>
                {p.source === "simulator" && (
                  <span className="badge badge--sold badge--plain" style={{ marginLeft: 6 }}>
                    Simulador
                  </span>
                )}
                {p.optedOutAt && (
                  <span className="badge badge--sold badge--plain" style={{ marginLeft: 6 }}>
                    Baja
                  </span>
                )}
              </td>
              <td className="num">{p.source === "simulator" ? "—" : formatPhone(p.phone)}</td>
              <td>
                <span className={`badge badge--${temperature(p.score).tone}`}>{temperature(p.score).label}</span>
              </td>
              <td>{STAGE_LABEL[p.stage] ?? p.stage}</td>
              <td className="right num">{p.budgetCents ? money(p.budgetCents) : "—"}</td>
              <td>{p.handoffReason ? <span className="badge badge--reserved">{HANDOFF_LABEL[p.handoffReason] ?? p.handoffReason}</span> : ""}</td>
              <td>{p.assignedName ?? <span className="muted">Sin asignar</span>}</td>
              <td className="right num">{num(p.messageCount)}</td>
              <td className="num muted">{p.lastInboundAt ? dateTime(p.lastInboundAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
