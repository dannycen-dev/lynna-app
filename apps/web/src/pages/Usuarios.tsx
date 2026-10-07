import { Copy, KeyRound, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Dialog, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useCreateUser, useResetPassword, useUpdateUser, useUsers } from "../lib/api";
import { ROLE_LABEL, timeAgo } from "../lib/format";
import type { ManagedUser, UserRole } from "../lib/types";

/** Contraseña temporal: se muestra una sola vez, con botón para copiarla. */
function TemporaryPassword({ email, password }: { email: string; password: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p style={{ margin: 0 }}>
        Comparte esta contraseña temporal con <strong>{email}</strong> por un medio seguro. <strong>Solo se muestra esta vez</strong>; al entrar tendrá que cambiarla.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <code className="temp-password" aria-label="Contraseña temporal generada">
          {password}
        </code>
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(password).then(() => setCopied(true));
          }}
        >
          <Copy size={14} /> {copied ? "Copiada" : "Copiar"}
        </button>
      </div>
    </div>
  );
}

export function Usuarios() {
  const users = useUsers();
  const update = useUpdateUser();
  const reset = useResetPassword();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const manageable = users.data?.manageableRoles ?? [];
  const canManage = (u: ManagedUser) => u.role !== "admin" && manageable.includes(u.role) && u.id !== users.data?.me;

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Usuarios"
        subtitle="Quién entra al panel y con qué rol. Las contraseñas nuevas o restablecidas son temporales: se cambian al entrar."
        actions={
          manageable.length > 0 && (
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <UserPlus size={16} /> Nuevo usuario
            </button>
          )
        }
      />
      {users.isPending && <Spinner />}
      <ErrorAlert error={users.error ?? update.error ?? reset.error} />
      {warning && (
        <div className="alert alert--warning" role="status" style={{ marginBottom: 12 }}>
          {warning} <Link to="/prospectos">Ir a prospectos</Link>
        </div>
      )}
      {users.data && (
        <div className="card table-wrap">
          <div className="card__header">
            <Users size={16} /> Equipo
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Rol</th>
                <th>Estado</th>
                <th>Último acceso</th>
                <th className="right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id} aria-label={u.name}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.id === users.data.me && <span className="muted"> (tú)</span>}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {u.email}
                    </div>
                  </td>
                  <td>
                    {canManage(u) ? (
                      <select
                        className="select"
                        style={{ height: 32, width: 140 }}
                        value={u.role}
                        aria-label={`Rol de ${u.name}`}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                      >
                        {manageable.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABEL[u.role]
                    )}
                  </td>
                  <td>
                    {u.active ? <span className="badge badge--available">Activo</span> : <span className="badge badge--sold">Inactivo</span>}
                    {u.active && u.mustChangePassword && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        Con contraseña temporal
                      </div>
                    )}
                  </td>
                  <td className="muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Nunca"}</td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    {canManage(u) && (
                      <>
                        <button
                          className="btn btn--sm btn--ghost"
                          disabled={reset.isPending || !u.active}
                          onClick={() => reset.mutate(u.id, { onSuccess: (r) => setShown({ email: u.email, password: r.temporaryPassword }) })}
                        >
                          <KeyRound size={14} /> Restablecer contraseña
                        </button>{" "}
                        <button
                          className="btn btn--sm"
                          disabled={update.isPending}
                          onClick={() =>
                            update.mutate(
                              { id: u.id, active: !u.active },
                              {
                                onSuccess: (r) =>
                                  setWarning(!r.user.active && r.openProspects > 0 ? `${u.name} tenía ${r.openProspects} prospecto${r.openProspects === 1 ? "" : "s"} abierto${r.openProspects === 1 ? "" : "s"}: reasígnalos.` : null),
                              },
                            )
                          }
                        >
                          {u.active ? "Desactivar" : "Reactivar"}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && <CreateUserDialog roles={manageable} onClose={() => setCreating(false)} onCreated={(email, password) => setShown({ email, password })} />}
      {shown && (
        <Dialog open onClose={() => setShown(null)} title="Contraseña temporal" footer={<button className="btn btn--primary" onClick={() => setShown(null)}>Listo, ya la guardé</button>}>
          <TemporaryPassword email={shown.email} password={shown.password} />
        </Dialog>
      )}
    </div>
  );
}

function CreateUserDialog({ roles, onClose, onCreated }: { roles: UserRole[]; onClose: () => void; onCreated: (email: string, password: string) => void }) {
  const create = useCreateUser();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>(roles.includes("seller") ? "seller" : roles[0]!);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Nuevo usuario"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="btn btn--primary"
            disabled={create.isPending || name.trim().length < 2 || !/^\S+@\S+\.\S+$/.test(email.trim())}
            onClick={() =>
              create.mutate(
                { name: name.trim(), email: email.trim(), role },
                {
                  onSuccess: (r) => {
                    onClose();
                    onCreated(r.user.email, r.temporaryPassword);
                  },
                },
              )
            }
          >
            Dar de alta
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12, minWidth: "min(420px, 80vw)" }}>
        <div className="field">
          <label htmlFor="new-name">Nombre</label>
          <input id="new-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-email">Correo</label>
          <input id="new-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-role">Rol</label>
          <select id="new-role" className="select" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          <span className="field__hint">Vendedor: sus prospectos y su agenda. Gerente: todo el equipo e inventario. Dueño: además administra gerentes.</span>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
