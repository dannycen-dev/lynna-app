// Precio lista / contra entrega: enganche, mensualidades sin interés y pago(s) contra entrega
// (calculator_on_delivery.py).

import { addMonths } from "./dates";
import { applyBp } from "./money";
import { splitAmount } from "./money";
import { applyListPriceDiscount } from "./pricing";
import { PlanError, type Breakdown, type LotInput, type PlanInput, type ScheduleLine, type Simulation } from "./types";

type Segment = "down_payment" | "monthly" | "on_delivery";

function segmentConfig(plan: PlanInput, segment: Segment) {
  switch (segment) {
    case "down_payment":
      return { type: plan.downPaymentType, bp: plan.downPaymentBp, fixed: plan.downPaymentFixedCents };
    case "monthly":
      return { type: plan.monthlyType, bp: plan.monthlyBp, fixed: plan.monthlyFixedCents };
    case "on_delivery":
      return { type: plan.onDeliveryType, bp: plan.onDeliveryBp, fixed: plan.onDeliveryFixedCents };
  }
}

function segmentTotal(plan: PlanInput, segment: Segment, salePrice: number): number {
  const cfg = segmentConfig(plan, segment);
  return cfg.type === "fixed" ? cfg.fixed : applyBp(salePrice, cfg.bp);
}

export function validateOnDelivery(plan: PlanInput): void {
  const totalBp = plan.downPaymentBp + plan.monthlyBp + plan.onDeliveryBp;
  const onlyPercentage = [plan.downPaymentType, plan.monthlyType, plan.onDeliveryType].every((t) => t === "percentage");

  if (!plan.roundingAbsorber && onlyPercentage && Math.abs(totalBp - 10_000) > 1) {
    throw new PlanError("Enganche, mensualidades y contra entrega deben sumar 100 %.");
  }
  if (plan.roundingAbsorber && onlyPercentage && totalBp > 10_001) {
    throw new PlanError("La suma de enganche y mensualidades no puede superar 100 %.");
  }
  if (plan.monthlyBp > 0 && plan.months <= 0 && plan.monthlyType === "percentage") {
    throw new PlanError("Indique el número de mensualidades cuando el porcentaje es mayor a cero.");
  }
  if (plan.downPaymentBp > 0 && plan.downPaymentInstallments <= 0 && plan.downPaymentType === "percentage") {
    throw new PlanError("Indique el número de pagos de enganche cuando el porcentaje es mayor a cero.");
  }
  if (plan.onDeliveryBp > 0 && plan.onDeliveryInstallments <= 0 && plan.onDeliveryType === "percentage") {
    throw new PlanError("Indique el número de pagos contra entrega cuando el porcentaje es mayor a cero.");
  }
}

export function simulateOnDelivery(plan: PlanInput, lot: LotInput, quoteDate: string): Simulation {
  validateOnDelivery(plan);
  const pricing = applyListPriceDiscount(plan, lot);
  const sale = pricing.salePriceCents;

  let downTotal = segmentTotal(plan, "down_payment", sale);
  let monthlyTotal = segmentTotal(plan, "monthly", sale);
  let onDeliveryTotal = segmentTotal(plan, "on_delivery", sale);
  if (plan.roundingAbsorber === "down_payment") downTotal = sale - monthlyTotal - onDeliveryTotal;
  else if (plan.roundingAbsorber === "monthly") monthlyTotal = sale - downTotal - onDeliveryTotal;
  else if (plan.roundingAbsorber === "on_delivery") onDeliveryTotal = sale - downTotal - monthlyTotal;

  const reservation = plan.reservationCents;
  const openingFee = plan.openingFeeCents;
  const downInstallments = plan.downPaymentInstallments || 1;
  const monthlyInstallments = plan.months || 0;
  const deliveryInstallments = plan.onDeliveryInstallments || 1;

  if (reservation && reservation > downTotal) {
    throw new PlanError("El apartado no puede ser mayor al total de enganche del plan.");
  }

  const downRemaining = downTotal - reservation;
  const downPayments = splitAmount(downRemaining, downInstallments);
  const monthlyPayments = monthlyTotal && monthlyInstallments ? splitAmount(monthlyTotal, monthlyInstallments) : [];
  const deliveryPayments = splitAmount(onDeliveryTotal, deliveryInstallments);

  const breakdown: Breakdown = {
    ...pricing,
    calculationType: "on_delivery",
    openingFeeCents: openingFee,
    reservationCents: reservation,
    downPaymentTotalCents: downTotal,
    downPaymentInstallments: downInstallments,
    downPaymentPerInstallmentCents: downPayments[0] ?? downTotal,
    monthlyTotalCents: monthlyTotal,
    monthlyInstallments,
    monthlyPaymentCents: monthlyPayments[0] ?? 0,
    onDeliveryTotalCents: onDeliveryTotal,
    onDeliveryInstallments: deliveryInstallments,
    onDeliveryPerInstallmentCents: deliveryPayments[0] ?? onDeliveryTotal,
    financedCents: monthlyTotal,
    annualInterestBp: 0,
    totalInterestCents: 0,
  };

  const lines: ScheduleLine[] = [];
  let period = 1;
  let monthOffset = 0;
  const push = (line: Omit<ScheduleLine, "period" | "principalCents" | "interestCents">) =>
    lines.push({ ...line, period: period++, principalCents: line.paymentCents, interestCents: 0 });

  if (openingFee) {
    push({ lineType: "opening_fee", paymentDate: quoteDate, paymentCents: openingFee, balanceCents: downRemaining });
  }
  if (reservation) {
    push({ lineType: "reservation", paymentDate: addMonths(quoteDate, monthOffset++), paymentCents: reservation, balanceCents: downRemaining });
  }
  for (const payment of downPayments) {
    push({ lineType: "down_payment", paymentDate: addMonths(quoteDate, monthOffset++), paymentCents: payment, balanceCents: monthlyTotal + onDeliveryTotal });
  }
  let running = monthlyTotal;
  for (const payment of monthlyPayments) {
    running -= payment;
    push({ lineType: "installment", paymentDate: addMonths(quoteDate, monthOffset++), paymentCents: payment, balanceCents: Math.max(running, 0) });
  }
  let deliveryBalance = onDeliveryTotal;
  deliveryPayments.forEach((payment, i) => {
    deliveryBalance -= payment;
    const paymentDate = plan.deliveryDate ? addMonths(plan.deliveryDate, i) : addMonths(quoteDate, monthOffset + i);
    push({ lineType: "on_delivery", paymentDate, paymentCents: payment, balanceCents: Math.max(deliveryBalance, 0) });
  });

  return { breakdown, lines };
}
