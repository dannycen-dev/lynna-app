import { z } from "zod";
import type { ChatMessage, LlmClient } from "./llm";

// Extracción de datos del prospecto, separada de la conversación. Corre DESPUÉS de responder y solo
// si el modelo conversacional no llamó actualizar_prospecto pero el mensaje parece traer datos.
// Así la calificación no depende de que el modelo "recuerde" usar la herramienta.

/** ¿El mensaje parece traer datos de calificación? Evita gastar neuronas en "hola" o "gracias". */
export function looksLikeProspectData(text: string): boolean {
  const t = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return (
    /\d/.test(t) ||
    /\b(me llamo|mi nombre|soy [a-z]|invertir|inversion|vivir|construir|mi casa|enganche|presupuesto|credito|infonavit|contado|de inmediato|meses|ano|correo|@)\b/.test(t)
  );
}

const extracted = z.object({
  nombre: z.string().trim().min(2).max(120).nullish(),
  correo: z.email().nullish(),
  ciudad: z.string().trim().min(2).max(120).nullish(),
  presupuesto_mxn: z.number().positive().max(1e9).nullish(),
  enganche_disponible_mxn: z.number().nonnegative().max(1e9).nullish(),
  plazo: z.enum(["inmediato", "1-3_meses", "3-6_meses", "mas_6_meses", "explorando"]).nullish(),
  uso: z.enum(["vivienda", "inversion", "otro"]).nullish(),
});

export type ExtractedData = z.infer<typeof extracted>;

const PROMPT = `Extrae datos que el PROSPECTO dijo explícitamente en su mensaje. No inventes ni deduzcas.
Responde SOLO un objeto JSON con estas claves (usa null si no lo dijo):
{"nombre": string|null, "correo": string|null, "ciudad": string|null,
 "presupuesto_mxn": number|null, "enganche_disponible_mxn": number|null,
 "plazo": "inmediato"|"1-3_meses"|"3-6_meses"|"mas_6_meses"|"explorando"|null,
 "uso": "vivienda"|"inversion"|"otro"|null}
Montos en pesos como número ("150 mil" = 150000, "1.2 millones" = 1200000). "para construir mi casa" = vivienda.`;

/** Devuelve solo los campos válidos y presentes; {} si no hay nada o el modelo falla. */
export async function extractProspectData(llm: LlmClient, prospectText: string): Promise<{ data: Partial<ExtractedData>; neurons: number }> {
  const messages: ChatMessage[] = [
    { role: "system", content: PROMPT },
    { role: "user", content: prospectText.slice(0, 2000) },
  ];
  try {
    const completion = await llm.complete({ messages, tools: [] });
    const json = completion.content?.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return { data: {}, neurons: completion.neurons };
    // Campo por campo: uno inválido no tira los demás.
    const raw = JSON.parse(json) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const key of Object.keys(extracted.shape) as (keyof ExtractedData)[]) {
      const field = extracted.shape[key].safeParse(raw[key]);
      if (field.success && field.data !== null && field.data !== undefined) data[key] = field.data;
    }
    return { data: data as Partial<ExtractedData>, neurons: completion.neurons };
  } catch {
    return { data: {}, neurons: 0 };
  }
}
