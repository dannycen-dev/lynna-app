// Motor de planes de pago. Código puro y determinista: la IA lo invoca vía tool, nunca calcula montos ella misma.

import { simulateOnDelivery, validateOnDelivery } from "./on-delivery";
import type { LotInput, PlanInput, Simulation } from "./types";
import { simulateWithInterest, validateWithInterest } from "./with-interest";

export * from "./types";
export { todayIn } from "./dates";

const calculators = {
  with_interest: { simulate: simulateWithInterest, validate: validateWithInterest },
  on_delivery: { simulate: simulateOnDelivery, validate: validateOnDelivery },
} satisfies Record<PlanInput["calculationType"], unknown>;

export function simulatePlan(plan: PlanInput, lot: LotInput, quoteDate: string): Simulation {
  return calculators[plan.calculationType].simulate(plan, lot, quoteDate);
}

/** Lanza PlanError si la configuración del plan es inconsistente. */
export function validatePlan(plan: PlanInput): void {
  calculators[plan.calculationType].validate(plan);
}

/** Suma de lo que paga el cliente (excluye renglones informativos). */
export function totalPaidCents(sim: Simulation): number {
  return sim.lines.filter((l) => l.lineType !== "down_payment_total").reduce((acc, l) => acc + l.paymentCents, 0);
}
