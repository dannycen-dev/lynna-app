import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./api-client";
import { useSession } from "./session";

export { ApiError } from "./api-client";
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
  SimulatorHistory,
  SimulatorTurn,
  Summary,
} from "./types";

/** Hook base: añade el token y el prefijo del tenant activo. */
function useApi() {
  const { tenant, expire } = useSession();
  const base = `/api/admin/tenants/${encodeURIComponent(tenant)}`;
  const call = async <T,>(path: string, init?: RequestInit) => {
    try {
      return await apiFetch<T>(path.startsWith("/api/") ? path : `${base}${path}`, init);
    } catch (err) {
      // Sesión vencida o revocada: de vuelta al login.
      if (err instanceof ApiError && err.status === 401) expire();
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
    enabled: path !== null && tenant !== "",
  });
}

// ── Lecturas ──────────────────────────────────────────────────────────────────

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

// ── Agente de IA (simulador) ───────────────────────────────────────────────────

export const useSimulatorHistory = () => useApiQuery<SimulatorHistory>(["simulator"], "/agent/simulator");

export function useSimulatorSend() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { message: string; type?: "text" | "image" | "document" }) =>
      call<SimulatorTurn>("/agent/simulator", { method: "POST", body: JSON.stringify(data) }),
    onSettled: () => invalidate("simulator", "prospects", "summary"),
  });
}

export function useSimulatorReset() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => call<void>("/agent/simulator", { method: "DELETE" }),
    onSuccess: () => invalidate("simulator", "prospects"),
  });
}
