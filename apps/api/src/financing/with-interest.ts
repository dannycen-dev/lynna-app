// Cálculo clásico con intereses: enganche + amortización francesa mensual (calculator_with_interest.py).

import { addDays, addMonths } from "./dates";
import { applyBp, roundCents } from "./money";
import { applyListPriceDiscount } from "./pricing";
import { PlanError, type Breakdown, type LotInput, type PlanInput, type ScheduleLine, type Simulation } from "./types";

type AmortizationRow = Omit<ScheduleLine, "lineType">;

export function validateWithInterest(plan: PlanInput): void {
  if (plan.months <= 0) throw new PlanError("El plazo en meses debe ser mayor a cero.");
}

export function simulateWithInterest(plan: PlanInput, lot: LotInput, quoteDate: string): Simulation {
  validateWithInterest(plan);
  const pricing = applyListPriceDiscount(plan, lot);
  const downPayment = applyBp(pricing.salePriceCents, plan.downPaymentBp);
  const financed = pricing.salePriceCents - downPayment;
  const reservation = plan.reservationCents;

  if (reservation && reservation > downPayment) {
    throw new PlanError("El apartado no puede ser mayor al enganche total del plan.");
  }

  const { rows, monthlyPayment, totalInterest } = amortize(financed, plan.months, plan.annualInterestBp, quoteDate);

  const breakdown: Breakdown = {
    ...pricing,
    calculationType: "with_interest",
    openingFeeCents: 0,
    reservationCents: reservation,
    downPaymentTotalCents: downPayment,
    downPaymentInstallments: 1,
    downPaymentPerInstallmentCents: downPayment,
    monthlyTotalCents: financed,
    monthlyInstallments: plan.months,
    monthlyPaymentCents: monthlyPayment,
    onDeliveryTotalCents: 0,
    onDeliveryInstallments: 0,
    onDeliveryPerInstallmentCents: 0,
    financedCents: financed,
    annualInterestBp: plan.annualInterestBp,
    totalInterestCents: totalInterest,
  };

  const lines: ScheduleLine[] = [];
  let period = 1;
  const remainingDown = downPayment - reservation;
  const downDate = addDays(quoteDate, 7);
  const push = (line: Omit<ScheduleLine, "period">) => lines.push({ ...line, period: period++ });

  if (reservation) {
    push({ lineType: "reservation", paymentDate: quoteDate, paymentCents: reservation, principalCents: reservation, interestCents: 0, balanceCents: remainingDown });
    if (remainingDown > 0) {
      push({ lineType: "down_payment", paymentDate: downDate, paymentCents: remainingDown, principalCents: remainingDown, interestCents: 0, balanceCents: financed });
    }
    push({ lineType: "down_payment_total", paymentDate: downDate, paymentCents: downPayment, principalCents: downPayment, interestCents: 0, balanceCents: financed });
  } else {
    push({ lineType: "down_payment", paymentDate: downDate, paymentCents: downPayment, principalCents: downPayment, interestCents: 0, balanceCents: financed });
  }
  for (const row of rows) push({ ...row, lineType: "installment" });

  return { breakdown, lines };
}

/** Tabla de amortización (tasa anual, pagos mensuales); el último pago liquida el saldo exacto. */
function amortize(principal: number, months: number, annualBp: number, quoteDate: string) {
  const monthlyRate = annualBp / 10_000 / 12;
  let payment: number;
  if (monthlyRate <= 0) {
    payment = roundCents(principal / months);
  } else {
    const factor = (1 + monthlyRate) ** months;
    payment = roundCents((principal * monthlyRate * factor) / (factor - 1));
  }
  const monthlyPayment = payment;

  let balance = principal;
  let totalInterest = 0;
  const rows: AmortizationRow[] = [];
  for (let p = 1; p <= months; p++) {
    const interest = roundCents(balance * monthlyRate);
    let principalPart = payment - interest;
    let rowPayment = payment;
    if (p === months) {
      principalPart = balance;
      rowPayment = principalPart + interest;
      balance = 0;
    } else {
      balance -= principalPart;
    }
    totalInterest += interest;
    rows.push({
      period: p,
      paymentDate: addMonths(quoteDate, p),
      paymentCents: rowPayment,
      principalCents: principalPart,
      interestCents: interest,
      balanceCents: balance,
    });
  }
  return { rows, monthlyPayment, totalInterest };
}
