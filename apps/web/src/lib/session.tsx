import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// Sesión provisional: el token de administración vive en sessionStorage (se borra al cerrar la pestaña).
// En la Fase 4 se reemplaza por login con usuarios (Better Auth) y cookie httpOnly.

const TOKEN_KEY = "lynna.adminToken";
const TENANT_KEY = "lynna.tenant";

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Navegación privada o almacenamiento bloqueado: la sesión dura lo que la pestaña.
  }
}

type Session = {
  token: string | null;
  tenant: string;
  signIn: (token: string, tenant: string) => void;
  signOut: () => void;
  setTenant: (tenant: string) => void;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(() => read(TOKEN_KEY));
  const [tenant, setTenantState] = useState(() => read(TENANT_KEY) ?? "demo");

  const signIn = useCallback((newToken: string, newTenant: string) => {
    write(TOKEN_KEY, newToken);
    write(TENANT_KEY, newTenant);
    setToken(newToken);
    setTenantState(newTenant);
  }, []);

  const signOut = useCallback(() => {
    write(TOKEN_KEY, null);
    setToken(null);
  }, []);

  const setTenant = useCallback((value: string) => {
    write(TENANT_KEY, value);
    setTenantState(value);
  }, []);

  const value = useMemo(() => ({ token, tenant, signIn, signOut, setTenant }), [token, tenant, signIn, signOut, setTenant]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession fuera de SessionProvider");
  return ctx;
}
