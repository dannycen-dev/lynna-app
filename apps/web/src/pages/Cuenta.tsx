import { KeyRound, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorAlert, PageHeader } from "../components/ui";
import { ROLE_LABEL } from "../lib/format";
import { useSession } from "../lib/session";

const MIN = 10;

/** Formulario para cambiar mi contraseña (también la temporal). */
export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const { changePassword } = useSession();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await changePassword(current, next);
      setDone(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={submit}>
      <div className="field">
        <label htmlFor="pw-current">Contraseña actual</label>
        <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="pw-next">Nueva contraseña</label>
        <input id="pw-next" className="input" type="password" autoComplete="new-password" minLength={MIN} value={next} onChange={(e) => setNext(e.target.value)} required />
        <span className="field__hint">Al menos {MIN} caracteres. Se cerrarán tus sesiones en otros dispositivos.</span>
      </div>
      <div className="field">
        <label htmlFor="pw-confirm">Repite la nueva contraseña</label>
        <input id="pw-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {mismatch && <span className="field__hint" style={{ color: "var(--lynna-error, #ba1a1a)" }}>No coincide.</span>}
      </div>
      <ErrorAlert error={error} />
      {done && <div className="alert alert--info">Listo, tu contraseña se cambió.</div>}
      <button className="btn btn--primary" type="submit" disabled={busy || next.length < MIN || next !== confirm || !current}>
        Cambiar contraseña
      </button>
    </form>
  );
}

/** Pantalla obligatoria al entrar con una contraseña temporal. */
export function ForcedPasswordChange() {
  const { me, signOut } = useSession();
  return (
    <div className="login">
      <div className="card login__card" style={{ maxWidth: 440 }}>
        <div className="card__body stack" style={{ gap: 14 }}>
          <div className="row" style={{ gap: 8 }}>
            <ShieldAlert size={20} aria-hidden />
            <h1 style={{ margin: 0, fontSize: 20 }}>Cambia tu contraseña temporal</h1>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            Hola, {me?.user.name}. Entraste con una contraseña temporal: elige una nueva para continuar.
          </p>
          <ChangePasswordForm />
          <button className="btn btn--ghost" onClick={() => void signOut()}>
            Salir
          </button>
        </div>
      </div>
    </div>
  );
}

export function Cuenta() {
  const { me, roleLabel } = useSession();
  return (
    <div className="page" style={{ maxWidth: 560 }}>
      <PageHeader title="Mi cuenta" subtitle={me ? `${me.user.name} · ${me.user.email} · ${ROLE_LABEL[me.user.role] ?? roleLabel}` : " "} />
      <div className="card">
        <div className="card__header">
          <KeyRound size={16} /> Cambiar mi contraseña
        </div>
        <div className="card__body">
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
