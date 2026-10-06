import { Shuffle, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useAssignmentSettings, useTeam, useUpdateAssignmentSettings, useUpdateTeamMember } from "../lib/api";
import { ROLE_LABEL, timeAgo } from "../lib/format";
import { useSession } from "../lib/session";

export function Configuracion() {
  const { canWrite } = useSession();
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHeader title="Configuración" subtitle="Cómo se reparten los prospectos entre tu equipo de ventas." />
      {!canWrite && <div className="alert alert--info" style={{ marginBottom: 16 }}>Solo un gerente o dueño puede cambiar esta configuración.</div>}
      <div className="stack">
        <AssignmentCard disabled={!canWrite} />
        <TeamCard disabled={!canWrite} />
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
