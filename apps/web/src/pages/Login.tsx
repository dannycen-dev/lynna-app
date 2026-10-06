import { KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import { apiFetch } from "../lib/api";
import { useSession } from "../lib/session";
import type { Tenant } from "../lib/types";
import { ErrorAlert } from "../components/ui";

export function Login() {
  const { signIn, tenant } = useSession();
  const [token, setToken] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const tenants = await apiFetch<Tenant[]>(token.trim(), "/api/admin/tenants");
      const keep = tenants.find((t) => t.slug === tenant) ?? tenants[0];
      signIn(token.trim(), keep?.slug ?? "demo");
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login">
      <form className="card login__card" onSubmit={submit}>
        <div className="login__brand">
          <img src="/lynna-logo.png" alt="" />
          <h1>Lynna</h1>
          <p className="muted" style={{ margin: 0 }}>
            CRM y cotizador para desarrolladoras inmobiliarias
          </p>
        </div>
        <div className="stack">
          <div className="field">
            <label htmlFor="token">Clave de acceso</label>
            <input
              id="token"
              className="input"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Pega tu clave de administración"
              required
            />
            <span className="field__hint">Acceso provisional del equipo de Ignia. El login con usuarios llega en la siguiente fase.</span>
          </div>
          <ErrorAlert error={error} />
          <button className="btn btn--primary" type="submit" disabled={pending || token.trim().length === 0} style={{ height: 42 }}>
            <KeyRound size={16} />
            {pending ? "Verificando…" : "Entrar"}
          </button>
        </div>
      </form>
    </div>
  );
}
