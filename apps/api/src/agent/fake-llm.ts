import type { ChatMessage, Completion, LlmClient } from "./llm";

// LLM falso y determinista para pruebas E2E y desarrollo sin red (AI_MODEL=fake, solo ENVIRONMENT=local).
// Recorre el mismo ciclo que un modelo real: pide herramientas y redacta con lo que devuelven.

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

let seq = 0;
const call = (name: string, args: Record<string, unknown>): Completion => ({
  content: null,
  toolCalls: [{ id: `fake_${++seq}`, name, args }],
  neurons: 0,
});
const say = (content: string): Completion => ({ content, toolCalls: [], neurons: 0 });

export const fakeLlm: LlmClient = {
  model: "fake",
  async complete({ messages, tools }) {
    // Extractor de datos (sin herramientas, prompt de extracción): responde JSON determinista.
    if (tools.length === 0 && messages[0]?.role === "system" && String(messages[0].content).startsWith("Extrae datos")) {
      const t = strip(String(messages.at(-1)?.content ?? ""));
      const nombre = /me llamo ([a-z]+(?: [a-z]+)?)/.exec(t)?.[1];
      return say(JSON.stringify({ nombre: nombre ? nombre.replace(/\b\w/g, (c) => c.toUpperCase()) : null, uso: /invertir|inversion/.test(t) ? "inversion" : /vivir|casa/.test(t) ? "vivienda" : null }));
    }
    let lastIdx = -1;
    messages.forEach((m, i) => {
      if (m.role === "user") lastIdx = i;
    });
    const lastUser = lastIdx >= 0 ? messages[lastIdx] : undefined;
    const text = strip(lastUser && typeof lastUser.content === "string" ? lastUser.content : "");
    const toolResults = messages.slice(lastIdx + 1).filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
    const result = (name: string) => toolResults.find((t) => t.name === name)?.content;

    if (/\b(comprar|apartar|aparto)\b/.test(text)) {
      if (!result("escalar_a_asesor")) return call("escalar_a_asesor", { motivo: "compra", detalle: "Quiere comprar (modelo de prueba)." });
      return say("¡Qué gusto! Un asesor te contactará en breve para ayudarte con el apartado.");
    }
    if (/\b(lote|lotes|terreno|terrenos|disponible)\b/.test(text)) {
      const found = result("buscar_lotes");
      if (!found) return call("buscar_lotes", {});
      const lots = (JSON.parse(found).lotes ?? []) as { lote: string; precio_total: string }[];
      if (lots.length === 0) return say("Por ahora no tengo lotes disponibles con esos criterios.");
      return say(`Tengo disponible ${lots[0]!.lote} por ${lots[0]!.precio_total}. ¿Te platico de los planes de pago?`);
    }
    return say("¡Hola! Soy Lynna (modelo de prueba). ¿Buscas un terreno para vivir o para invertir?");
  },
};
