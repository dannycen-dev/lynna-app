import type { paymentPlans } from "../db/schema";

/** Campos del plan que usa el motor (una fila de payment_plans cumple este tipo). */
export type PlanInput = Pick<
  typeof paymentPlans.$inferSelect,
  | "calculationType"
  | "listPriceType"
  | "discountType"
  | "discountBp"
  | "discountFixedCents"
  | "reservationCents"
  | "openingFeeCents"
  | "downPaymentType"
  | "downPaymentBp"
  | "downPaymentFixedCents"
  | "downPaymentInstallments"
  | "months"
  | "annualInterestBp"
  | "monthlyType"
  | "monthlyBp"
  | "monthlyFixedCents"
  | "onDeliveryType"
  | "onDeliveryBp"
  | "onDeliveryFixedCents"
  | "onDeliveryInstallments"
  | "roundingAbsorber"
  | "deliveryDate"
>;

export type LotInput = {
  totalPriceCents: number;
  pricePerM2Cents?: number | null;
  areaM2?: number | null;
};

export type Pricing = {
  listPriceCents: number;
  discountCents: number;
  /** Descuento efectivo en puntos base (informativo cuando el descuento es fijo). */
  discountBp: number;
  salePriceCents: number;
  adjustedPricePerM2Cents?: number;
};

export type Breakdown = Pricing & {
  calculationType: PlanInput["calculationType"];
  openingFeeCents: number;
  reservationCents: number;
  downPaymentTotalCents: number;
  downPaymentInstallments: number;
  downPaymentPerInstallmentCents: number;
  monthlyTotalCents: number;
  monthlyInstallments: number;
  monthlyPaymentCents: number;
  onDeliveryTotalCents: number;
  onDeliveryInstallments: number;
  onDeliveryPerInstallmentCents: number;
  financedCents: number;
  annualInterestBp: number;
  totalInterestCents: number;
};

export const LINE_TYPES = [
  "opening_fee",
  "reservation",
  "down_payment",
  // Renglón informativo (with_interest con apartado): repite el enganche total; NO es un pago.
  "down_payment_total",
  "installment",
  "on_delivery",
] as const;
export type LineType = (typeof LINE_TYPES)[number];

export type ScheduleLine = {
  lineType: LineType;
  period: number;
  paymentDate: string; // YYYY-MM-DD
  paymentCents: number;
  principalCents: number;
  interestCents: number;
  balanceCents: number;
};

export type Simulation = { breakdown: Breakdown; lines: ScheduleLine[] };

/** Error de configuración del plan o de datos del lote; el mensaje es apto para el usuario. */
export class PlanError extends Error {
  override name = "PlanError";
}
