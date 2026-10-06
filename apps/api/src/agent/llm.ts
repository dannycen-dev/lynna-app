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
    return { content, toolCalls, neurons, ...(content ? {} : { raw: JSON.stringify(r.choices?.[0]).slice(0, 800) }) };
  }

  const toolCalls: ToolCall[] = (r.tool_calls ?? []).map((tc: any, i: number) => ({
    id: String(tc.id ?? `call_${i}`),
    name: String(tc.name ?? tc.function?.name ?? ""),
    args: parseArgs(tc.arguments ?? tc.function?.arguments),
  }));
  const content = typeof r.response === "string" ? r.response : null;
  return { content, toolCalls, neurons, ...(content ? {} : { raw: JSON.stringify(r).slice(0, 800) }) };
}

export function workersAiClient(ai: Ai, model: string, gatewayId?: string): LlmClient {
  return {
    model,
    async complete({ messages, tools }) {
      const result = await ai.run(
        model as Parameters<Ai["run"]>[0],
        {
          messages,
          tools: tools.map((t) => ({ type: "function", function: t })),
          max_tokens: 700,
          temperature: 0.3,
        } as never,
        gatewayId ? { gateway: { id: gatewayId } } : undefined,
      );
      return normalizeCompletion(result);
    },
  };
}
