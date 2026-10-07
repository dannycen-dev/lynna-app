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
    if (/\b(visita|visitar|cita|agendar|agenda|agendame)\b/.test(text)) {
      if (/\bcancel/.test(text)) {
        if (!result("cancelar_cita")) return call("cancelar_cita", { motivo: "El prospecto la canceló (modelo de prueba)." });
        return say("Listo, cancelé tu visita. Cuando quieras la reagendamos.");
      }
      const booking = /(\d{4}-\d{2}-\d{2})\D+(\d{1,2}:\d{2})/.exec(text);
      if (booking) {
        const booked = result("agendar_visita");
        if (!booked) return call("agendar_visita", { fecha: booking[1], hora: booking[2] });
        const parsed = JSON.parse(booked) as { ok?: boolean; cita?: string };
        return say(parsed.ok ? `¡Listo! Tu visita quedó agendada para el ${parsed.cita}. Un asesor te recibirá.` : "Ese horario ya no está disponible. ¿Te busco otro?");
      }
      const slots = result("horarios_disponibles");
      if (!slots) return call("horarios_disponibles", {});
      const horarios = (JSON.parse(slots).horarios ?? []) as { fecha: string; hora: string; etiqueta: string }[];
      if (horarios.length === 0) return say("Por ahora no tengo horarios de visita; un asesor te contactará para agendar.");
      return say(`Tengo estos horarios para visitar el desarrollo: ${horarios.slice(0, 3).map((h) => `${h.etiqueta} (${h.fecha} ${h.hora})`).join("; ")}. ¿Cuál te acomoda?`);
    }
    if (/\b(agua|luz|drenaje|servicios|efectivo|requisitos|reglamento|construir|oficina|mascotas)\b/.test(text)) {
      const info = result("consultar_informacion");
      if (!info) return call("consultar_informacion", { pregunta: text });
      const articulos = (JSON.parse(info).articulos ?? []) as { titulo: string; contenido: string }[];
      if (articulos.length === 0) return say("No tengo esa información confirmada; un asesor te la puede confirmar.");
      return say(`Según la información de la desarrolladora: ${articulos[0]!.contenido}`);
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
