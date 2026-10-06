import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useSession } from "./session";
import type {
  Development,
  ImportResult,
  Lot,
  LotStatus,
  Media,
  Message,
  PaymentPlan,
  Prospect,
  Simulation,
  Summary,
  Tenant,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** Mensaje legible para el usuario a partir de la respuesta de la API. */
function describe(status: number, body: Record<string, unknown> | null): string {
  if (body?.message && typeof body.message === "string") return body.message;
  if (body?.issues && typeof body.issues === "object") {
    const fields = Object.entries(body.issues as Record<string, string[]>).map(([k, v]) => `${k}: ${v.join(", ")}`);
    if (fields.length) return `Revisa los datos — ${fields.join(" · ")}`;
  }
  if (status === 401) return "Tu sesión no es válida. Vuelve a entrar.";
  if (status === 404) return "No encontrado.";
  if (status === 503) return "Servicio no disponible en este entorno.";
  return "Ocurrió un error inesperado. Intenta de nuevo.";
}

export async function apiFetch<T>(token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const obj = (body && typeof body === "object" ? body : null) as Record<string, unknown> | null;
    throw new ApiError(res.status, String(obj?.error ?? res.status), describe(res.status, obj), body);
  }
  return body as T;
}

/** Hook base: añade el token y el prefijo del tenant activo. */
function useApi() {
  const { token, tenant, signOut } = useSession();
  const base = `/api/admin/tenants/${encodeURIComponent(tenant)}`;
  const call = async <T,>(path: string, init?: RequestInit) => {
    try {
      return await apiFetch<T>(token, path.startsWith("/api/") ? path : `${base}${path}`, init);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) signOut();
      throw err;
    }
  };
  return { call, tenant };
}

function useApiQuery<T>(key: QueryKey, path: string | null) {
  const { call, tenant } = useApi();
  return useQuery({
    queryKey: [tenant, ...key],
    queryFn: () => call<T>(path!),
    enabled: path !== null,
  });
}

// ── Lecturas ──────────────────────────────────────────────────────────────────

export const useTenants = () => useApiQuery<Tenant[]>(["tenants"], "/api/admin/tenants");
export const useSummary = () => useApiQuery<Summary>(["summary"], "/summary");
export const useDevelopments = () => useApiQuery<Development[]>(["developments"], "/developments");
export const useLots = (dev: string | undefined) =>
  useApiQuery<Lot[]>(["lots", dev], dev ? `/developments/${encodeURIComponent(dev)}/lots` : null);
export const useDevelopmentPlans = (dev: string | undefined) =>
  useApiQuery<PaymentPlan[]>(["dev-plans", dev], dev ? `/developments/${encodeURIComponent(dev)}/payment-plans` : null);
export const usePlans = () => useApiQuery<PaymentPlan[]>(["plans"], "/payment-plans");
export const useMedia = (dev: string | undefined) =>
  useApiQuery<Media[]>(["media", dev], dev ? `/developments/${encodeURIComponent(dev)}/media` : null);
export const useProspects = () => useApiQuery<Prospect[]>(["prospects"], "/prospects");
export const useMessages = (conversationId: string | undefined) =>
  useApiQuery<Message[]>(["messages", conversationId], conversationId ? `/conversations/${encodeURIComponent(conversationId)}/messages` : null);

export function useSimulation(lotId: string | undefined, planId: string | undefined, quoteDate: string) {
  const { call, tenant } = useApi();
  return useQuery({
    queryKey: [tenant, "simulate", lotId, planId, quoteDate],
    queryFn: () => call<Simulation>("/simulate", { method: "POST", body: JSON.stringify({ lotId, planId, quoteDate }) }),
    enabled: Boolean(lotId && planId),
    retry: false,
  });
}

// ── Escrituras ────────────────────────────────────────────────────────────────

function useInvalidate() {
  const qc = useQueryClient();
  const { tenant } = useApi();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [tenant, k] })));
}

export function useCreateDevelopment() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: Partial<Development> & { name: string; slug: string }) =>
      call<Development>("/developments", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("developments", "summary"),
  });
}

export function useChangeLotStatus() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ lotId, ...data }: { lotId: string; status: LotStatus; reason: string; reservedUntil?: string }) =>
      call<Lot>(`/lots/${encodeURIComponent(lotId)}/status`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("lots", "summary", "simulate"),
  });
}

export function useImportLots(dev: string) {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ csv, dryRun }: { csv: string; dryRun: boolean }) => {
      try {
        return await call<ImportResult>(`/developments/${encodeURIComponent(dev)}/lots/import?dryRun=${dryRun}`, {
          method: "POST",
          body: csv,
          headers: { "content-type": "text/csv" },
        });
      } catch (err) {
        // 422 trae la lista de errores por renglón: se muestra en lugar de lanzar.
        if (err instanceof ApiError && err.status === 422 && err.body) return err.body as ImportResult;
        throw err;
      }
    },
    onSuccess: (result) => {
      if (!result.dryRun && result.valid) void invalidate("lots", "summary");
    },
  });
}

export function useCreatePlan() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) => call<PaymentPlan>("/payment-plans", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("plans", "dev-plans"),
  });
}

export function useTogglePlan() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      call<PaymentPlan>(`/payment-plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ active }) }),
    onSuccess: () => invalidate("plans", "dev-plans"),
  });
}

export function useUploadMedia(dev: string) {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ file, kind, caption }: { file: File; kind: Media["kind"]; caption?: string }) => {
      const params = new URLSearchParams({ kind, ...(caption ? { caption } : {}) });
      return call<Media>(`/developments/${encodeURIComponent(dev)}/media?${params}`, {
        method: "POST",
        body: file,
        headers: { "content-type": file.type },
      });
    },
    onSuccess: () => invalidate("media"),
  });
}

export function useDeleteMedia() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => call<void>(`/media/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidate("media"),
  });
}
