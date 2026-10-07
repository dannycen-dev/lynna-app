import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "./api-client";
import type { Me, Tenant, UserRole } from "./types";

// La sesión vive en una cookie HttpOnly que pone la API: el JavaScript de la página nunca ve
// el token. Aquí solo se guarda qué desarrolladora está viendo el usuario (si tiene varias).

const TENANT_KEY = "lynna.tenant";
const ROLE_LABEL: Record<UserRole, string> = { admin: "Ignia", owner: "Dueño", manager: "Gerente", seller: "Vendedor" };

function readTenant(): string | null {
  try {
    return sessionStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

function writeTenant(value: string) {
  try {
    sessionStorage.setItem(TENANT_KEY, value);
  } catch {
    // Almacenamiento bloqueado: la selección dura lo que la pestaña.
  }
}

type Session = {
  status: "loading" | "signed-in" | "signed-out";
  me: Me | null;
  tenant: string;
  tenants: Tenant[];
  roleLabel: string;
  /** owner, manager y admin pueden modificar inventario y planes; seller solo consulta y cotiza. */
  canWrite: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (current: string, next: string) => Promise<void>;
  setTenant: (slug: string) => void;
  expire: () => void;
};

const SessionContext = createContext<Session | null>(null);
export const ME_KEY = ["me"] as const;

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await apiFetch<Me>("/api/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const [selected, setSelected] = useState(readTenant);

  const me = meQuery.data ?? null;
  const tenants = me?.tenants ?? [];
  const tenant = tenants.find((t) => t.slug === selected)?.slug ?? tenants[0]?.slug ?? "";

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await apiFetch<Me>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      qc.setQueryData(ME_KEY, result);
    },
    [qc],
  );

  const expire = useCallback(() => {
    // Primero la sesión (la UI regresa al login), luego se borra todo dato del negocio en caché.
    qc.setQueryData(ME_KEY, null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
  }, [qc]);

  const signOut = useCallback(async () => {
    try {
      await apiFetch<void>("/api/auth/logout", { method: "POST" });
    } finally {
      expire();
    }
  }, [expire]);

  const changePassword = useCallback(
    async (current: string, next: string) => {
      await apiFetch<void>("/api/auth/password", { method: "POST", body: JSON.stringify({ current, next }) });
      qc.setQueryData<Me | null>(ME_KEY, (prev) => (prev ? { ...prev, user: { ...prev.user, mustChangePassword: false } } : prev));
    },
    [qc],
  );

  const setTenant = useCallback((slug: string) => {
    writeTenant(slug);
    setSelected(slug);
  }, []);

  const value = useMemo<Session>(
    () => ({
      status: meQuery.isPending ? "loading" : me ? "signed-in" : "signed-out",
      me,
      tenant,
      tenants,
      roleLabel: me ? ROLE_LABEL[me.user.role] : "",
      canWrite: me ? me.user.role !== "seller" : false,
      signIn,
      signOut,
      changePassword,
      setTenant,
      expire,
    }),
    [meQuery.isPending, me, tenant, tenants, signIn, signOut, changePassword, setTenant, expire],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession fuera de SessionProvider");
  return ctx;
}
