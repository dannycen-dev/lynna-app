// Cliente HTTP base. Mismo origen que la API: el navegador manda la cookie de sesión solo
// (credentials "same-origin" por omisión) y el header Origin en POST/PATCH/DELETE (anti-CSRF).

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
  if (status === 401) return "Tu sesión terminó. Vuelve a entrar.";
  if (status === 403) return "No tienes permiso para hacer esto.";
  if (status === 404) return "No encontrado.";
  if (status === 429) return "Demasiados intentos. Espera unos minutos.";
  if (status === 503) return "Servicio no disponible en este entorno.";
  return "Ocurrió un error inesperado. Intenta de nuevo.";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<{ body: T; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");

  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (res.status === 204) return { body: undefined as T, headers: res.headers };
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
  return { body: body as T, headers: res.headers };
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await request<T>(path, init)).body;
}

/** Igual que apiFetch, más el total que manda la API en `x-total-count` (listas con límite). */
export async function apiFetchWithTotal<T>(path: string, init: RequestInit = {}): Promise<{ items: T; total: number | null }> {
  const { body, headers } = await request<T>(path, init);
  const total = headers.get("x-total-count");
  return { items: body, total: total === null ? null : Number(total) };
}
