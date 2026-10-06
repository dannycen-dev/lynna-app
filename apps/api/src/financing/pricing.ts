import { applyBp, roundCents } from "./money";
import { PlanError, type LotInput, type PlanInput, type Pricing } from "./types";

/** Precio de lista, descuento y precio de venta según `listPriceType` del plan (apply_list_price_discount). */
export function applyListPriceDiscount(plan: PlanInput, lot: LotInput): Pricing {
  if (plan.listPriceType === "total_m2") {
    const ppm = lot.pricePerM2Cents ?? 0;
    const m2 = lot.areaM2 ?? 0;
    if (!ppm || !m2) {
      throw new PlanError("Para tipo Precio Total M² se requiere precio por m² y superficie del lote.");
    }
    const listPriceCents = roundCents(ppm * m2);
    const adjustedPricePerM2Cents =
      plan.discountType === "fixed" ? ppm - plan.discountFixedCents : ppm - applyBp(ppm, plan.discountBp);
    const salePriceCents = roundCents(adjustedPricePerM2Cents * m2);
    const discountCents = listPriceCents - salePriceCents;
    return {
      listPriceCents,
      discountCents,
      discountBp: plan.discountType === "fixed" ? effectiveBp(discountCents, listPriceCents) : plan.discountBp,
      salePriceCents,
      adjustedPricePerM2Cents,
    };
  }

  const listPriceCents = lot.totalPriceCents;
  const discountCents = plan.discountType === "fixed" ? plan.discountFixedCents : applyBp(listPriceCents, plan.discountBp);
  return {
    listPriceCents,
    discountCents,
    discountBp: plan.discountType === "fixed" ? effectiveBp(discountCents, listPriceCents) : plan.discountBp,
    salePriceCents: listPriceCents - discountCents,
  };
}

function effectiveBp(discountCents: number, listCents: number): number {
  return listCents ? Math.round((discountCents / listCents) * 10_000) : 0;
}
