// Aritmética en centavos enteros. Equivale a `currency.round()` de Odoo (medio hacia arriba).

/** Redondea a centavos con mitades alejándose de cero (como float_round HALF-UP). */
export function roundCents(value: number): number {
  // El epsilon corrige representaciones binarias tipo 0.49999999 que deberían ser 0.5.
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) + 1e-9);
}

/** Aplica puntos base (1 % = 100 bp). */
export function applyBp(cents: number, bp: number): number {
  return roundCents((cents * bp) / 10_000);
}

/** Divide un monto en N pagos; el último absorbe los centavos de redondeo. */
export function splitAmount(totalCents: number, count: number): number[] {
  if (count <= 0 || totalCents <= 0) return [];
  const base = roundCents(totalCents / count);
  const payments = Array<number>(count).fill(base);
  payments[count - 1] = base + (totalCents - base * count);
  return payments;
}
