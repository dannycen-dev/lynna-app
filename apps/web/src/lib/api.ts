import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { ApiError, apiFetch, apiFetchWithTotal } from "./api-client";
import { useSession } from "./session";

export { ApiError } from "./api-client";
import type {
  ManagedUser,
  UsersResponse,
  Metrics,
  AgentSettings,
  PrivacySettings,
  KbArticle,
  KbSearch,
  AgendaItem,
  Availability,
  AvailabilityRule,
  Slot,
  Development,
  ImportResult,
  Lot,
  LotStatus,
  Media,
  PaymentPlan,
  Prospect,
  Simulation,
  AppNotification,
  AssignmentSettings,
  TeamMember,
  ProspectDetail,
  ProspectStage,
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
export type ProspectFilters = {
  q?: string;
  development?: string;
  temperature?: "frio" | "tibio" | "caliente" | "listo";
  stage?: string;
  owner?: string;
  source?: "whatsapp" | "simulator";
  from?: string;
  to?: string;
};

/** Quita los filtros vacíos y arma el query string. */
export function filtersQuery(f: ProspectFilters): string {
  const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);
  return params.toString();
}

/** Prospectos con filtros del lado del servidor; `total` dice cuántos hay aunque la lista venga recortada. */
export function useProspects(filters: ProspectFilters = {}) {
  const { tenant, expire } = useSession();
  const qs = filtersQuery(filters);
  return useQuery({
    queryKey: [tenant, "prospects", qs],
    queryFn: async () => {
      try {
        return await apiFetchWithTotal<Prospect[]>(`/api/admin/tenants/${encodeURIComponent(tenant)}/prospects${qs ? `?${qs}` : ""}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) expire();
        throw err;
      }
    },
    enabled: tenant !== "",
    placeholderData: (prev) => prev, // al cambiar filtros no parpadea la lista
    refetchInterval: 30_000, // llegan prospectos nuevos por WhatsApp sin recargar
  });
}

/** URL de descarga del CSV con los mismos filtros (la cookie viaja sola: mismo origen). */
export function useProspectsCsvUrl(filters: ProspectFilters) {
  const { tenant } = useSession();
  const qs = filtersQuery(filters);
  return `/api/admin/tenants/${encodeURIComponent(tenant)}/exports/prospects.csv${qs ? `?${qs}` : ""}`;
}

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

// ── CRM ───────────────────────────────────────────────────────────────────────

export function useProspect(id: string | undefined) {
  const { call, tenant } = useApi();
  return useQuery({
    queryKey: [tenant, "prospect", id],
    queryFn: () => call<ProspectDetail>(`/prospects/${encodeURIComponent(id!)}`),
    enabled: Boolean(id && tenant),
    // Mensajes nuevos del prospecto (o de la IA) sin recargar.
    refetchInterval: 10_000,
  });
}

export function useChangeStage() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, stage, reason }: { id: string; stage: ProspectStage; reason?: string }) =>
      call(`/prospects/${encodeURIComponent(id)}/stage`, { method: "PATCH", body: JSON.stringify({ stage, ...(reason ? { reason } : {}) }) }),
    onSuccess: () => invalidate("prospects", "prospect", "summary"),
  });
}

export function useAddNote(id: string) {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: string) => call(`/prospects/${encodeURIComponent(id)}/notes`, { method: "POST", body: JSON.stringify({ body }) }),
    onSuccess: () => invalidate("prospect"),
  });
}

export function useTakeover() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ conversationId, take }: { conversationId: string; take: boolean }) =>
      call(`/conversations/${encodeURIComponent(conversationId)}/${take ? "takeover" : "release"}`, { method: "POST" }),
    onSuccess: () => invalidate("prospect", "prospects"),
  });
}

export function useSendHumanMessage() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ conversationId, body }: { conversationId: string; body: string }) =>
      call(`/conversations/${encodeURIComponent(conversationId)}/messages`, { method: "POST", body: JSON.stringify({ body }) }),
    onSettled: () => invalidate("prospect", "prospects"),
  });
}

export function useNotifications() {
  const { call, tenant } = useApi();
  return useQuery({
    queryKey: [tenant, "notifications"],
    queryFn: () => call<{ unread: number; items: AppNotification[] }>("/notifications"),
    enabled: tenant !== "",
    refetchInterval: 10_000,
  });
}

export function useMarkNotificationsRead() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (ids?: string[]) => call("/notifications/read", { method: "POST", body: JSON.stringify(ids ? { ids } : {}) }),
    onSuccess: () => invalidate("notifications"),
  });
}

// ── Asignación y equipo ────────────────────────────────────────────────────────

export const useTeam = () => useApiQuery<TeamMember[]>(["team"], "/team");
export const useAssignmentSettings = () => useApiQuery<AssignmentSettings>(["assignment-settings"], "/settings/assignment");

export function useAssign() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, userId }: { id: string; userId: string | null }) =>
      call(`/prospects/${encodeURIComponent(id)}/assign`, { method: "PATCH", body: JSON.stringify({ userId }) }),
    onSuccess: () => invalidate("prospect", "prospects"),
  });
}

export function useUpdateAssignmentSettings() {
  const { call, tenant } = useApi();
  const qc = useQueryClient();
  const key = [tenant, "assignment-settings"];
  return useMutation({
    mutationFn: (data: Partial<AssignmentSettings>) => call<AssignmentSettings>("/settings/assignment", { method: "PATCH", body: JSON.stringify(data) }),
    // Optimista: el control cambia al instante; si el servidor falla, se revierte.
    onMutate: async (data) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<AssignmentSettings>(key);
      if (previous) qc.setQueryData(key, { ...previous, ...data });
      return { previous };
    },
    onError: (_err, _data, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSuccess: (saved) => qc.setQueryData(key, saved),
  });
}

export function useUpdateTeamMember() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, receivesLeads }: { id: string; receivesLeads: boolean }) =>
      call(`/team/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ receivesLeads }) }),
    onSuccess: () => invalidate("team"),
  });
}

// ── Agenda de citas ────────────────────────────────────────────────────────────

export const useAgenda = (from: string, days: number, userId: string | null) =>
  useApiQuery<AgendaItem[]>(["agenda", from, days, userId], `/appointments?${new URLSearchParams({ from, days: String(days), ...(userId ? { userId } : {}) })}`);

export const useSlots = (date: string | null, prospectId: string | undefined, userId?: string | null) =>
  useApiQuery<Slot[]>(
    ["slots", date, prospectId, userId],
    date ? `/appointments/slots?${new URLSearchParams({ date, ...(prospectId ? { prospectId } : {}), ...(userId ? { userId } : {}) })}` : null,
  );

export const useAvailability = () => useApiQuery<Availability>(["availability"], "/availability");

export function useBookAppointment() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { prospectId: string; startsAt: number; userId?: string; notes?: string }) =>
      call("/appointments", { method: "POST", body: JSON.stringify(data) }),
    onSettled: () => invalidate("agenda", "slots", "prospect", "prospects", "summary"),
  });
}

export function useSetAppointmentStatus() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; status: "completed" | "no_show" | "cancelled"; reason?: string }) =>
      call(`/appointments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("agenda", "slots", "prospect", "prospects", "summary"),
  });
}

export function useSaveAvailability() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ userId, rules }: { userId: string; rules: AvailabilityRule[] }) =>
      call(`/availability/${encodeURIComponent(userId)}`, { method: "PUT", body: JSON.stringify({ rules }) }),
    onSuccess: () => invalidate("availability", "slots"),
  });
}

export function useSaveAppointmentSettings() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { appointmentMinutes: number }) => call("/settings/appointments", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("availability", "slots"),
  });
}

// ── Base de conocimiento ───────────────────────────────────────────────────────

export const useKnowledge = () => useApiQuery<KbArticle[]>(["knowledge"], "/knowledge");
export const useKnowledgeSearch = (q: string) =>
  useApiQuery<KbSearch>(["knowledge-search", q], q.trim().length >= 3 ? `/knowledge/search?${new URLSearchParams({ q })}` : null);

type KbInput = Pick<KbArticle, "title" | "body" | "keywords" | "category" | "developmentId" | "status">;

export function useSaveArticle() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<KbInput> & { id?: string }) =>
      id
        ? call<KbArticle>(`/knowledge/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) })
        : call<KbArticle>("/knowledge", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("knowledge", "knowledge-search"),
  });
}

export function useDeleteArticle() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => call<void>(`/knowledge/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => invalidate("knowledge", "knowledge-search"),
  });
}

// ── Privacidad ────────────────────────────────────────────────────────────────

export const usePrivacySettings = () => useApiQuery<PrivacySettings>(["privacy-settings"], "/settings/privacy");

export function useSavePrivacySettings() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: PrivacySettings) => call<PrivacySettings>("/settings/privacy", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("privacy-settings"),
  });
}

/** URL de descarga del expediente del prospecto (la cookie de sesión viaja sola: mismo origen). */
export function useProspectExportUrl(id: string) {
  const { tenant } = useApi();
  return `/api/admin/tenants/${encodeURIComponent(tenant)}/prospects/${encodeURIComponent(id)}/export`;
}

export function useDeleteProspect() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      call<void>(`/prospects/${encodeURIComponent(id)}`, { method: "DELETE", body: JSON.stringify({ reason }) }),
    onSuccess: () => invalidate("prospects", "summary", "agenda", "notifications"),
  });
}

// ── Asistente y horario de atención ────────────────────────────────────────────

export const useAgentSettings = () => useApiQuery<AgentSettings>(["agent-settings"], "/settings/agent");

export function useSaveAgentSettings() {
  const { call, tenant } = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Pick<AgentSettings, "assistantName" | "businessHours">>) =>
      call<AgentSettings>("/settings/agent", { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: (saved) => qc.setQueryData([tenant, "agent-settings"], saved),
  });
}

export const useMetrics = (days: 7 | 30 | 90) => useApiQuery<Metrics>(["metrics", days], `/metrics?days=${days}`);

// ── Usuarios ──────────────────────────────────────────────────────────────────

export const useUsers = (enabled = true) => useApiQuery<UsersResponse>(["users"], enabled ? "/users" : null);

export function useCreateUser() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (data: { name: string; email: string; role: string }) =>
      call<{ user: ManagedUser; temporaryPassword: string }>("/users", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("users", "team", "availability"),
  });
}

export function useUpdateUser() {
  const { call } = useApi();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; role?: string; active?: boolean }) =>
      call<{ user: ManagedUser; openProspects: number }>(`/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => invalidate("users", "team", "availability"),
  });
}

export function useResetPassword() {
  const { call } = useApi();
  return useMutation({
    mutationFn: (id: string) => call<{ temporaryPassword: string }>(`/users/${encodeURIComponent(id)}/reset-password`, { method: "POST" }),
  });
}
