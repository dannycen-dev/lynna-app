import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { LineType, Simulation } from "../financing";

// Cotización en PDF con la tabla de pagos completa (la que calcula src/financing). Se manda por WhatsApp
// como documento; los montos salen del motor, nunca del modelo. Fuentes estándar (WinAnsi): sin emojis.

export type QuoteInput = {
  companyName: string;
  /** PNG o JPG del logo de la desarrolladora (opcional). */
  logo?: { bytes: Uint8Array; mime: string } | null;
  /** Colores de marca en hex ("#1B3A6B"); por omisión, azul marino y dorado. */
  primary?: string | null;
  accent?: string | null;
  development: { name: string; address: string | null; city: string | null; state: string | null };
  lot: { block: string; number: string; areaM2: number; frontM: number | null; depthM: number | null; pricePerM2Cents: number };
  planName: string;
  simulation: Simulation;
  /** Fecha de la cotización, YYYY-MM-DD. */
  quoteDate: string;
  folio: string;
  prospectName?: string | null;
  advisorNote?: string;
};

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const LINE_LABEL: Record<LineType, string> = {
  opening_fee: "Gastos de apertura",
  reservation: "Apartado",
  down_payment: "Enganche",
  down_payment_total: "Enganche total (informativo)",
  installment: "Mensualidad",
  on_delivery: "Contra entrega",
};

export const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
};

/** Solo caracteres que Helvetica (WinAnsi) puede dibujar. */
const safe = (s: string) =>
  s
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "")
    .trim();

function hex(color: string | null | undefined, fallback: [number, number, number]) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  const [r, g, b] = m ? [m[1], m[2], m[3]].map((x) => parseInt(x!, 16) / 255) : fallback.map((x) => x / 255);
  return rgb(r!, g!, b!);
}

export async function buildQuotePdf(q: QuoteInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(safe(`Cotización ${q.development.name} ${q.lot.block}-${q.lot.number}`));
  pdf.setAuthor(safe(q.companyName));
  pdf.setCreator("Lynna");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = hex(q.primary, [27, 58, 107]);
  const gold = hex(q.accent, [201, 162, 39]);
  const ink = rgb(0.13, 0.15, 0.2);
  const muted = rgb(0.42, 0.45, 0.52);
  const line = rgb(0.86, 0.87, 0.9);
  const zebra = rgb(0.965, 0.97, 0.98);

  let logo: PDFImage | null = null;
  if (q.logo) {
    try {
      logo = q.logo.mime === "image/png" ? await pdf.embedPng(q.logo.bytes) : await pdf.embedJpg(q.logo.bytes);
    } catch {
      logo = null; // un logo dañado no impide la cotización
    }
  }

  const W = 595.28;
  const H = 841.89;
  const M = 40;
  const pages: PDFPage[] = [];
  const text = (page: PDFPage, s: string, x: number, y: number, size = 10, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x, y, size, font: f, color });
  const right = (page: PDFPage, s: string, xRight: number, y: number, size = 10, f: PDFFont = font, color = ink) =>
    page.drawText(safe(s), { x: xRight - f.widthOfTextAtSize(safe(s), size), y, size, font: f, color });

  function newPage(): { page: PDFPage; y: number } {
    const page = pdf.addPage([W, H]);
    pages.push(page);
    // Encabezado: logo, nombre de la empresa y franja dorada.
    let x = M;
    if (logo) {
      const h = 54;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: M, y: H - M - h + 6, width: w, height: h });
      x = M + w + 10;
    } else {
      text(page, q.companyName, M, H - M - 20, 16, bold, navy);
    }
    right(page, "COTIZACIÓN INFORMATIVA", W - M, H - M - 12, 12, bold, navy);
    right(page, `Folio ${q.folio}  ·  ${shortDate(q.quoteDate)}`, W - M, H - M - 28, 9, font, muted);
    void x;
    page.drawRectangle({ x: M, y: H - M - 58, width: W - 2 * M, height: 2.5, color: gold });
    return { page, y: H - M - 80 };
  }

  let { page, y } = newPage();
  const b = q.simulation.breakdown;

  // Datos del lote.
  text(page, q.development.name, M, y, 16, bold, navy);
  y -= 16;
  const place = [q.development.address, q.development.city, q.development.state].filter(Boolean).join(", ");
  if (place) text(page, place, M, y, 9, font, muted);
  y -= 22;
  if (q.prospectName) {
    text(page, `Preparada para: ${q.prospectName}`, M, y, 10, font, ink);
    y -= 18;
  }

  const facts: [string, string][] = [
    ["Lote", `Manzana ${q.lot.block}, lote ${q.lot.number}`],
    ["Superficie", `${q.lot.areaM2.toLocaleString("en-US")} m²${q.lot.frontM && q.lot.depthM ? `  (${q.lot.frontM} x ${q.lot.depthM} m)` : ""}`],
    ["Precio por m²", money(q.lot.pricePerM2Cents)],
    ["Plan de pago", q.planName],
  ];
  const boxH = facts.length * 18 + 14;
  page.drawRectangle({ x: M, y: y - boxH + 12, width: W - 2 * M, height: boxH, color: zebra, borderColor: line, borderWidth: 0.8 });
  for (const [k, v] of facts) {
    text(page, k, M + 12, y - 4, 9, font, muted);
    text(page, v, M + 130, y - 4, 10, bold, ink);
    y -= 18;
  }
  y -= 20;

  // Resumen del plan.
  text(page, "Resumen", M, y, 12, bold, navy);
  y -= 16;
  const summary: [string, number, boolean?][] = [
    ["Precio de lista", b.listPriceCents],
    ...(b.discountCents > 0 ? ([["Descuento del plan", -b.discountCents]] as [string, number][]) : []),
    ["Precio final", b.salePriceCents, true],
    ...(b.openingFeeCents ? ([["Gastos de apertura", b.openingFeeCents]] as [string, number][]) : []),
    ...(b.reservationCents ? ([["Apartado", b.reservationCents]] as [string, number][]) : []),
    ...(b.downPaymentTotalCents
      ? ([[`Enganche${b.downPaymentInstallments > 1 ? ` (${b.downPaymentInstallments} pagos de ${money(b.downPaymentPerInstallmentCents)})` : ""}`, b.downPaymentTotalCents]] as [string, number][])
      : []),
    ...(b.monthlyInstallments ? ([[`${b.monthlyInstallments} mensualidades de ${money(b.monthlyPaymentCents)}`, b.monthlyTotalCents]] as [string, number][]) : []),
    ...(b.onDeliveryTotalCents ? ([["Contra entrega", b.onDeliveryTotalCents]] as [string, number][]) : []),
    ...(b.totalInterestCents ? ([[`Intereses (${b.annualInterestBp / 100} % anual)`, b.totalInterestCents]] as [string, number][]) : []),
    ["Total a pagar", b.salePriceCents + b.totalInterestCents + (b.openingFeeCents ?? 0), true],
  ];
  for (const [label, cents, strong] of summary) {
    text(page, label, M + 4, y, 10, strong ? bold : font, strong ? navy : ink);
    right(page, cents < 0 ? `-${money(-cents)}` : money(cents), W - M - 4, y, 10, strong ? bold : font, strong ? navy : ink);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: line });
    y -= 12;
  }
  y -= 14;

  // Tabla de pagos.
  const cols = [
    { title: "#", x: M + 4, w: 22, align: "left" as const },
    { title: "Concepto", x: M + 30, w: 120, align: "left" as const },
    { title: "Fecha", x: M + 160, w: 70, align: "left" as const },
    { title: "Pago", x: M + 300, w: 0, align: "right" as const },
    { title: "Capital", x: M + 375, w: 0, align: "right" as const },
    { title: "Interés", x: M + 440, w: 0, align: "right" as const },
    { title: "Saldo", x: W - M - 4, w: 0, align: "right" as const },
  ];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 20, color: navy });
    for (const c of cols) (c.align === "right" ? right : text)(page, c.title, c.x, y, 9, bold, rgb(1, 1, 1));
    y -= 22;
  };
  text(page, "Tabla de pagos", M, y, 12, bold, navy);
  y -= 20;
  header();
  const rows = q.simulation.lines;
  rows.forEach((l, i) => {
    if (y < M + 70) {
      ({ page, y } = newPage());
      header();
    }
    if (i % 2 === 1) page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 16, color: zebra });
    const info = l.lineType === "down_payment_total";
    const color = info ? muted : ink;
    text(page, String(l.period || i + 1), cols[0]!.x, y, 8.5, font, color);
    text(page, LINE_LABEL[l.lineType], cols[1]!.x, y, 8.5, font, color);
    text(page, shortDate(l.paymentDate), cols[2]!.x, y, 8.5, font, color);
    right(page, money(l.paymentCents), cols[3]!.x, y, 8.5, bold, color);
    right(page, money(l.principalCents), cols[4]!.x, y, 8.5, font, color);
    right(page, l.interestCents ? money(l.interestCents) : "-", cols[5]!.x, y, 8.5, font, color);
    right(page, money(l.balanceCents), cols[6]!.x, y, 8.5, font, color);
    y -= 16;
  });

  // Pie en todas las páginas.
  const note =
    q.advisorNote ??
    `Cotización informativa sujeta a disponibilidad y a confirmación por un asesor de ${q.companyName}. Vigencia: 7 días. Precios en pesos mexicanos.`;
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M + 26 }, end: { x: W - M, y: M + 26 }, thickness: 0.6, color: gold });
    p.drawText(safe(note), { x: M, y: M + 12, size: 7.5, font, color: muted, maxWidth: W - 2 * M - 60, lineHeight: 9 });
    right(p, `${i + 1} / ${pages.length}`, W - M, M + 12, 8, font, muted);
  });

  return pdf.save();
}
