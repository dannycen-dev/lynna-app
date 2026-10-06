import type { prospects } from "../db/schema";

// Calificación por reglas en código (no por el LLM): el modelo solo extrae datos con actualizar_prospecto.
// 0–29 frío · 30–59 tibio · 60–99 caliente · 100 listo para comprar (lo fija escalar_a_asesor con motivo "compra").

type Prospect = Pick<
  typeof prospects.$inferSelect,
  "name" | "budgetCents" | "downPaymentCents" | "timeframe" | "purpose" | "interestDevelopmentId" | "email" | "stage"
>;

export function computeScore(p: Prospect): number {
  if (p.stage === "ready_to_buy") return 100;
  let score = 0;
  if (p.budgetCents) score += 20;
  if (p.downPaymentCents) score += 15;
  if (p.timeframe === "inmediato" || p.timeframe === "1-3_meses") score += 20;
  else if (p.timeframe === "3-6_meses") score += 10;
  if (p.purpose) score += 10;
  if (p.interestDevelopmentId) score += 10;
  if (p.name) score += 10;
  if (p.email) score += 5;
  return Math.min(score, 99);
}

export type Temperature = "frio" | "tibio" | "caliente" | "listo";

export function temperature(score: number): Temperature {
  if (score >= 100) return "listo";
  if (score >= 60) return "caliente";
  if (score >= 30) return "tibio";
  return "frio";
}
