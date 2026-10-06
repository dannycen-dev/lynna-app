import { describe, expect, it } from "vitest";
import { addDays, addMonths } from "../src/financing/dates";
import { simulatePlan, totalPaidCents, validatePlan, type PlanInput } from "../src/financing";
import { splitAmount } from "../src/financing/money";

const basePlan: PlanInput = {
  calculationType: "with_interest",
  listPriceType: "list_price",
  discountType: "percentage",
  discountBp: 0,
  discountFixedCents: 0,
  reservationCents: 0,
  openingFeeCents: 0,
  downPaymentType: "percentage",
  downPaymentBp: 0,
  downPaymentFixedCents: 0,
  downPaymentInstallments: 1,
  months: 0,
  annualInterestBp: 0,
  monthlyType: "percentage",
  monthlyBp: 0,
  monthlyFixedCents: 0,
  onDeliveryType: "percentage",
  onDeliveryBp: 0,
  onDeliveryFixedCents: 0,
  onDeliveryInstallments: 1,
  roundingAbsorber: null,
  deliveryDate: null,
};
const plan = (p: Partial<PlanInput>): PlanInput => ({ ...basePlan, ...p });
const MXN = (pesos: number) => Math.round(pesos * 100);

describe("fechas", () => {
  it("addMonths recorta al último día del mes como relativedelta", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2026-01-31", 12)).toBe("2027-01-31");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
  });
  it("addDays cruza fin de año", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
  it("rechaza fechas inválidas", () => {
    expect(() => addMonths("2026-02-30", 1)).toThrow(RangeError);
  });
});

it("splitAmount: el último pago absorbe los centavos", () => {
  expect(splitAmount(1000, 3)).toEqual([333, 333, 334]);
  expect(splitAmount(0, 3)).toEqual([]);
});

describe("with_interest", () => {
  it("12 meses sin intereses con apartado: cuadra al centavo", () => {
    const sim = simulatePlan(
      plan({ downPaymentBp: 2000, months: 12, reservationCents: MXN(10_000) }),
      { totalPriceCents: MXN(1_000_000) },
      "2026-01-31",
    );
    const { breakdown, lines } = sim;
    expect(breakdown.downPaymentTotalCents).toBe(MXN(200_000));
    expect(breakdown.financedCents).toBe(MXN(800_000));
    expect(breakdown.monthlyPaymentCents).toBe(6_666_667);

    expect(lines.slice(0, 3)).toEqual([
      { lineType: "reservation", period: 1, paymentDate: "2026-01-31", paymentCents: MXN(10_000), principalCents: MXN(10_000), interestCents: 0, balanceCents: MXN(190_000) },
      { lineType: "down_payment", period: 2, paymentDate: "2026-02-07", paymentCents: MXN(190_000), principalCents: MXN(190_000), interestCents: 0, balanceCents: MXN(800_000) },
      { lineType: "down_payment_total", period: 3, paymentDate: "2026-02-07", paymentCents: MXN(200_000), principalCents: MXN(200_000), interestCents: 0, balanceCents: MXN(800_000) },
    ]);
    const installments = lines.filter((l) => l.lineType === "installment");
    expect(installments).toHaveLength(12);
    expect(installments[0]!.paymentDate).toBe("2026-02-28");
    expect(installments[1]!.paymentDate).toBe("2026-03-31");
    expect(installments[11]!).toMatchObject({ paymentCents: 6_666_663, balanceCents: 0 });
    expect(totalPaidCents(sim)).toBe(MXN(1_000_000));
  });

  it("amortización francesa: $100,000 al 12 % anual a 12 meses = $8,884.88", () => {
    const sim = simulatePlan(
      plan({ downPaymentBp: 2000, months: 12, annualInterestBp: 1200 }),
      { totalPriceCents: MXN(125_000) },
      "2026-03-10",
    );
    const { breakdown, lines } = sim;
    expect(breakdown.financedCents).toBe(MXN(100_000));
    expect(breakdown.monthlyPaymentCents).toBe(MXN(8_884.88));
    const first = lines.find((l) => l.lineType === "installment")!;
    expect(first).toMatchObject({ interestCents: MXN(1_000), principalCents: MXN(7_884.88), paymentDate: "2026-04-10" });
    expect(lines.at(-1)!.balanceCents).toBe(0);
    expect(totalPaidCents(sim)).toBe(MXN(125_000) + breakdown.totalInterestCents);
    expect(breakdown.totalInterestCents).toBeGreaterThan(MXN(6_600));
    expect(breakdown.totalInterestCents).toBeLessThan(MXN(6_700));
  });

  it("valida plazo y que el apartado no exceda el enganche", () => {
    expect(() => validatePlan(plan({ months: 0 }))).toThrow("plazo en meses");
    expect(() =>
      simulatePlan(plan({ months: 12, downPaymentBp: 1000, reservationCents: MXN(200_000) }), { totalPriceCents: MXN(1_000_000) }, "2026-01-01"),
    ).toThrow("apartado no puede ser mayor");
  });
});

describe("on_delivery", () => {
  const onDelivery = plan({
    calculationType: "on_delivery",
    reservationCents: MXN(10_000),
    downPaymentBp: 3000,
    downPaymentInstallments: 2,
    monthlyBp: 5000,
    months: 10,
    onDeliveryBp: 2000,
    onDeliveryInstallments: 1,
    deliveryDate: "2027-06-01",
  });

  it("enganche en 2 pagos, 10 mensualidades y contra entrega en fecha de entrega", () => {
    const sim = simulatePlan(onDelivery, { totalPriceCents: MXN(1_000_000) }, "2026-03-15");
    const summary = sim.lines.map((l) => [l.lineType, l.paymentDate, l.paymentCents / 100]);
    expect(summary).toEqual([
      ["reservation", "2026-03-15", 10_000],
      ["down_payment", "2026-04-15", 145_000],
      ["down_payment", "2026-05-15", 145_000],
      ...Array.from({ length: 10 }, (_, i) => ["installment", addMonths("2026-06-15", i), 50_000]),
      ["on_delivery", "2027-06-01", 200_000],
    ]);
    expect(totalPaidCents(sim)).toBe(MXN(1_000_000));
    expect(sim.breakdown.totalInterestCents).toBe(0);
  });

  it("sin fecha de entrega, el pago final va al mes siguiente de la última mensualidad", () => {
    const sim = simulatePlan({ ...onDelivery, deliveryDate: null }, { totalPriceCents: MXN(1_000_000) }, "2026-03-15");
    expect(sim.lines.at(-1)).toMatchObject({ lineType: "on_delivery", paymentDate: "2027-04-15" });
  });

  it("el segmento absorbedor cuadra el redondeo al precio de venta", () => {
    const sim = simulatePlan(
      plan({ calculationType: "on_delivery", downPaymentBp: 3333, monthlyBp: 3333, months: 7, roundingAbsorber: "on_delivery" }),
      { totalPriceCents: 100_000_001 },
      "2026-01-01",
    );
    expect(sim.breakdown.downPaymentTotalCents).toBe(33_330_000);
    expect(sim.breakdown.onDeliveryTotalCents).toBe(33_340_001);
    expect(totalPaidCents(sim)).toBe(100_000_001);
  });

  it("cuota de apertura como primer renglón", () => {
    const sim = simulatePlan({ ...onDelivery, openingFeeCents: MXN(5_000) }, { totalPriceCents: MXN(1_000_000) }, "2026-03-15");
    expect(sim.lines[0]).toMatchObject({ lineType: "opening_fee", paymentCents: MXN(5_000), period: 1 });
  });

  it("exige que los porcentajes sumen 100 % si no hay absorbedor", () => {
    expect(() => validatePlan({ ...onDelivery, onDeliveryBp: 1500 })).toThrow("deben sumar 100 %");
    expect(() => validatePlan({ ...onDelivery, onDeliveryBp: 1500, roundingAbsorber: "on_delivery" })).not.toThrow();
    expect(() => validatePlan({ ...onDelivery, months: 0 })).toThrow("número de mensualidades");
  });
});

describe("precio por m² con descuento", () => {
  const lot = { totalPriceCents: MXN(800_000), pricePerM2Cents: MXN(3_200), areaM2: 250 };

  it("descuento porcentual sobre el precio por m²", () => {
    const sim = simulatePlan(plan({ listPriceType: "total_m2", discountBp: 500, months: 1, downPaymentBp: 10000 }), lot, "2026-01-01");
    expect(sim.breakdown).toMatchObject({
      listPriceCents: MXN(800_000),
      adjustedPricePerM2Cents: MXN(3_040),
      salePriceCents: MXN(760_000),
      discountCents: MXN(40_000),
      discountBp: 500,
    });
  });

  it("descuento fijo por m²", () => {
    const sim = simulatePlan(
      plan({ listPriceType: "total_m2", discountType: "fixed", discountFixedCents: MXN(100), months: 1, downPaymentBp: 10000 }),
      lot,
      "2026-01-01",
    );
    expect(sim.breakdown.salePriceCents).toBe(MXN(775_000));
    expect(sim.breakdown.discountBp).toBe(313); // 3.125 % redondeado
  });

  it("requiere precio por m² y superficie", () => {
    expect(() => simulatePlan(plan({ listPriceType: "total_m2", months: 1 }), { totalPriceCents: 1 }, "2026-01-01")).toThrow(
      "precio por m² y superficie",
    );
  });

  it("descuento fijo sobre el precio de lista", () => {
    const sim = simulatePlan(plan({ discountType: "fixed", discountFixedCents: MXN(50_000), months: 1, downPaymentBp: 10000 }), { totalPriceCents: MXN(1_000_000) }, "2026-01-01");
    expect(sim.breakdown).toMatchObject({ salePriceCents: MXN(950_000), discountBp: 500 });
  });
});
