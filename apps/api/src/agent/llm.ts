// Cliente de Workers AI con function calling. Normaliza las dos familias de respuesta:
// - estilo OpenAI:           { choices: [{ message: { content, tool_calls: [{ id, function: { name, arguments: "json" } }] } }] }
// - clásico de Workers AI:   { response, tool_calls: [{ name, arguments: {…} }] }
// El formato se detecta por la forma de la respuesta, no por el nombre del modelo.

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: RawToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export type RawToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ToolSpec = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Completion = {
  content: string | null;
  toolCalls: ToolCall[];
  neurons: number;
  /** Fragmento de la respuesta cruda, solo para diagnosticar respuestas vacías. */
  raw?: string;
  /** Modelo que respondió (difiere del principal si entró el de respaldo). */
  model?: string;
  /** El modelo se quedó sin tokens (finish_reason "length"): el texto viene cortado. */
  truncated?: boolean;
};

export interface LlmClient {
  readonly model: string;
  complete(input: { messages: ChatMessage[]; tools: ToolSpec[] }): Promise<Completion>;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Extrae contenido y tool calls de cualquiera de los dos formatos. Exportado para pruebas. */
export function normalizeCompletion(result: unknown): Completion {
  const r = (result ?? {}) as Record<string, any>;
  const neurons = Number(r.usage?.neurons ?? 0) || 0;

  const message = r.choices?.[0]?.message;
  if (message) {
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any, i: number) => ({
      id: String(tc.id ?? `call_${i}`),
      name: String(tc.function?.name ?? tc.name ?? ""),
      args: parseArgs(tc.function?.arguments ?? tc.arguments),
    }));
    const content = typeof message.content === "string" ? message.content : null;
    const truncated = r.choices?.[0]?.finish_reason === "length";
    return { content, toolCalls, neurons, ...(truncated ? { truncated } : {}), ...(content ? {} : { raw: JSON.stringify(r.choices?.[0]).slice(0, 800) }) };
  }

  const toolCalls: ToolCall[] = (r.tool_calls ?? []).map((tc: any, i: number) => ({
    id: String(tc.id ?? `call_${i}`),
    name: String(tc.name ?? tc.function?.name ?? ""),
    args: parseArgs(tc.arguments ?? tc.function?.arguments),
  }));
  const content = typeof r.response === "string" ? r.response : null;
  return { content, toolCalls, neurons, ...(content ? {} : { raw: JSON.stringify(r).slice(0, 800) }) };
}

/** thinking: undefined = lo que diga el modelo; false = sin razonamiento (más rápido, sin texto truncado). */
export function workersAiClient(ai: Ai, model: string, gatewayId?: string, options: { thinking?: boolean } = {}): LlmClient {
  return {
    model: options.thinking === false ? `${model} (sin razonamiento)` : model,
    async complete({ messages, tools }) {
      const result = await ai.run(
        model as Parameters<Ai["run"]>[0],
        {
          messages,
          tools: tools.map((t) => ({ type: "function", function: t })),
          // Holgado: modelos que razonan (Gemma 4) gastan tokens antes del texto visible.
          max_tokens: 1500,
          temperature: 0.3,
          // Solo se envía si se configuró: otros modelos podrían rechazar el parámetro.
          ...(options.thinking !== undefined ? { chat_template_kwargs: { enable_thinking: options.thinking } } : {}),
        } as never,
        gatewayId ? { gateway: { id: gatewayId } } : undefined,
      );
      return normalizeCompletion(result);
    },
  };
}

/**
 * Si el modelo principal falla (caída, límite de neuronas), se usa el de respaldo en esa llamada.
 * El validador de salida aplica igual a ambos.
 */
export function withFallback(primary: LlmClient, fallback: LlmClient | null, onFallback?: (err: unknown) => void): LlmClient {
  if (!fallback || fallback.model === primary.model) return primary;
  return {
    model: primary.model,
    async complete(input) {
      try {
        return { ...(await primary.complete(input)), model: primary.model };
      } catch (err) {
        onFallback?.(err);
        return { ...(await fallback.complete(input)), model: fallback.model };
      }
    },
  };
}
