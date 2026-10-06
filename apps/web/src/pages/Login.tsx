import { Eye, EyeOff, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorAlert } from "../components/ui";
import { useSession } from "../lib/session";

export function Login() {
  const { signIn } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(err);
      setPassword("");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login">
      <form className="card login__card" onSubmit={submit} noValidate>
        <div className="login__brand">
          <img src="/lynna-logo.png" alt="" />
          <h1>Lynna</h1>
          <p className="muted" style={{ margin: 0 }}>
            CRM y cotizador para desarrolladoras inmobiliarias
          </p>
        </div>
        <div className="stack">
          <div className="field">
            <label htmlFor="email">Correo</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@empresa.mx"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <div className="input-group">
              <input
                id="password"
                className="input"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="input-group__btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <ErrorAlert error={error} />
          <button className="btn btn--primary" type="submit" disabled={pending || !email.trim() || !password} style={{ height: 42 }}>
            <LogIn size={16} />
            {pending ? "Entrando…" : "Entrar"}
          </button>
          <p className="field__hint" style={{ textAlign: "center", margin: 0 }}>
            ¿Sin acceso? Pídelo al administrador de tu empresa.
          </p>
        </div>
      </form>
    </div>
  );
}
