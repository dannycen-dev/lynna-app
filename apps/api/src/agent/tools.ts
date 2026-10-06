import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { CatalogError, getLot, plansForDevelopment, searchAvailableLots, simulateForLot } from "../catalog/service";
import type { Db } from "../db/client";
import { developments, lots, paymentPlans, prospects } from "../db/schema";
import { todayIn, type Breakdown } from "../financing";

type PaymentPlan = typeof paymentPlans.$inferSelect;
import { auditInsert } from "../lib/audit";
import type { ToolSpec } from "./llm";
import { computeScore } from "./qualification";

// Herramientas del agente. Son TODO lo que la IA puede hacer: lo prohibido (descontar, apartar,
// confirmar pagos, tocar contratos) no existe aquí. Cada herramienta consulta D1 en vivo y anota en
// `facts` los lotes y montos verificados, que guard.ts usa para validar la respuesta antes de enviarla.

export type Facts = {
  /** Claves "A-1" (manzana-lote) de lotes devueltos por herramientas en este turno. */
  lots: Set<string>;
  /** Montos verificados, en pesos enteros. */
  amounts: Set<number>;
};

export const newFacts = (): Facts => ({ lots: new Set(), amounts: new Set() });

export type EscalationReason = "compra" | "descuento" | "legal" | "pago" | "queja" | "documentos" | "otro";

export type ToolContext = {
  db: Db;
  tenantId: string;
  prospectId: string;
  conversationId: string;
  facts: Facts;
  /** Se llena si la IA llamó escalar_a_asesor en este turno. */
  escalation: { reason: EscalationReason; detail: string } | null;
};

const pesos = (cents: number) => Math.round(cents / 100);
const fmt = (cents: number) => `$${pesos(cents).toLocaleString("en-US")} MXN`;
const lotLabel = (l: { block: string; number: string }) => `Manzana ${l.block}, lote ${l.number}`;

function remember(facts: Facts, ...cents: (number | null | undefined)[]) {
  for (const c of cents) if (c && c > 0) facts.amounts.add(pesos(c));
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

async function findDevelopment(db: Db, tenantId: string, query: string | undefined) {
  const all = await db
    .select()
    .from(developments)
    .where(and(eq(developments.tenantId, tenantId), eq(developments.status, "active")))
    .orderBy(asc(developments.name));
  if (!query) return { all, match: all.length === 1 ? all[0] : undefined };
  const q = norm(query);
  const match = all.find((d) => norm(d.slug) === q || norm(d.name) === q) ?? all.find((d) => norm(d.name).includes(q) || q.includes(norm(d.name)));
  return { all, match };
}

function describePlan(p: PaymentPlan): string {
  if (p.calculationType === "with_interest") {
    return `enganche ${p.downPaymentBp / 100} %, ${p.months} mensualidades${p.annualInterestBp ? ` con interés anual de ${p.annualInterestBp / 100} %` : " sin intereses"}`;
  }
  if (p.downPaymentBp === 10_000) return `pago único${p.discountBp ? ` con ${p.discountBp / 100} % de descuento` : ""}`;
  const parts = [
    p.downPaymentBp ? `enganche ${p.downPaymentBp / 100} %${p.downPaymentInstallments > 1 ? ` en ${p.downPaymentInstallments} pagos` : ""}` : null,
    p.monthlyBp ? `${p.monthlyBp / 100} % en ${p.months} mensualidades sin intereses` : null,
    p.onDeliveryBp ? `${p.onDeliveryBp / 100} % contra entrega${p.deliveryDate ? ` (${p.deliveryDate})` : ""}` : null,
    p.discountBp ? `${p.discountBp / 100} % de descuento` : null,
  ];
  return parts.filter(Boolean).join(", ");
}

function summarizeBreakdown(b: Breakdown) {
  return {
    precio_lista: fmt(b.listPriceCents),
    ...(b.discountCents > 0 ? { descuento_del_plan: fmt(b.discountCents) } : {}),
    precio_final: fmt(b.salePriceCents),
    ...(b.reservationCents ? { apartado: fmt(b.reservationCents) } : {}),
    ...(b.openingFeeCents ? { cuota_apertura: fmt(b.openingFeeCents) } : {}),
    enganche_total: fmt(b.downPaymentTotalCents),
    ...(b.downPaymentInstallments > 1 ? { enganche_en_pagos: `${b.downPaymentInstallments} pagos de ${fmt(b.downPaymentPerInstallmentCents)}` } : {}),
    ...(b.monthlyInstallments ? { mensualidades: `${b.monthlyInstallments} pagos de ${fmt(b.monthlyPaymentCents)}` } : {}),
    ...(b.annualInterestBp ? { interes_anual: `${b.annualInterestBp / 100} %`, intereses_totales: fmt(b.totalInterestCents) } : {}),
    ...(b.onDeliveryTotalCents ? { contra_entrega: fmt(b.onDeliveryTotalCents) } : {}),
    nota: "Cotización informativa, sujeta a confirmación por un asesor.",
  };
}

// ── Definiciones (lo que ve el modelo) ───────────────────────────────────────────

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "listar_desarrollos",
    description: "Lista los desarrollos a la venta con ubicación, amenidades, lotes disponibles y precio desde.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "buscar_lotes",
    description: "Busca lotes DISPONIBLES en este momento. Úsala antes de mencionar cualquier lote, precio o medida.",
    parameters: {
      type: "object",
      properties: {
        desarrollo: { type: "string", description: "Nombre del desarrollo (opcional si solo hay uno)." },
        presupuesto_max_mxn: { type: "number", description: "Precio total máximo en pesos." },
        superficie_min_m2: { type: "number", description: "Superficie mínima en m²." },
        manzana: { type: "string" },
      },
    },
  },
  {
    name: "detalle_lote",
    description: "Detalle y disponibilidad actual de un lote. Usa lote_id (de buscar_lotes) o manzana + lote si el prospecto pregunta por uno específico.",
    parameters: { type: "object", properties: { lote_id: { type: "string" }, manzana: { type: "string" }, lote: { type: "string" } } },
  },
  {
    name: "planes_de_pago",
    description: "Planes de pago vigentes de un desarrollo (enganche, mensualidades, contra entrega).",
    parameters: { type: "object", properties: { desarrollo: { type: "string" } } },
  },
  {
    name: "simular_plan",
    description: "Calcula enganche, mensualidades y montos de un plan para un lote disponible. Única fuente válida de montos de pago.",
    parameters: {
      type: "object",
      properties: { lote_id: { type: "string" }, plan_id: { type: "string" } },
      required: ["lote_id", "plan_id"],
    },
  },
  {
    name: "actualizar_prospecto",
    description: "Guarda datos que el prospecto mencionó. Llama solo con los campos que dijo.",
    parameters: {
      type: "object",
      properties: {
        nombre: { type: "string" },
        correo: { type: "string" },
        ciudad: { type: "string" },
        presupuesto_mxn: { type: "number" },
        enganche_disponible_mxn: { type: "number" },
        plazo: { type: "string", enum: ["inmediato", "1-3_meses", "3-6_meses", "mas_6_meses", "explorando"] },
        uso: { type: "string", enum: ["vivienda", "inversion", "otro"] },
        desarrollo_interes: { type: "string" },
      },
    },
  },
  {
    name: "escalar_a_asesor",
    description:
      "Turna la conversación a un asesor humano. Obligatorio si quiere comprar, apartar, pagar, ver el contrato, escriturar, pide descuento, temas legales o de pagos, queja, o quiere enviar documentos.",
    parameters: {
      type: "object",
      properties: {
        motivo: { type: "string", enum: ["compra", "descuento", "legal", "pago", "queja", "documentos", "otro"] },
        detalle: { type: "string", description: "Resumen breve para el asesor." },
      },
      required: ["motivo", "detalle"],
    },
  },
];

// ── Ejecución ───────────────────────────────────────────────────────────────────

const prospectArgs = z.object({
  nombre: z.string().trim().min(1).max(120).optional(),
  correo: z.email().max(200).optional(),
  ciudad: z.string().trim().min(1).max(120).optional(),
  presupuesto_mxn: z.number().positive().max(1e9).optional(),
  enganche_disponible_mxn: z.number().nonnegative().max(1e9).optional(),
  plazo: z.enum(["inmediato", "1-3_meses", "3-6_meses", "mas_6_meses", "explorando"]).optional(),
  uso: z.enum(["vivienda", "inversion", "otro"]).optional(),
  desarrollo_interes: z.string().max(120).optional(),
});

const ESCALATION_REASONS = ["compra", "descuento", "legal", "pago", "queja", "documentos", "otro"] as const;

/** Ejecuta una herramienta y devuelve el texto (JSON) que se le pasa al modelo. Nunca lanza. */
export async function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<string> {
  try {
    return JSON.stringify(await dispatch(ctx, name, args));
  } catch (err) {
    if (err instanceof CatalogError) return JSON.stringify({ error: err.message });
    return JSON.stringify({ error: "No se pudo consultar en este momento. Ofrece que un asesor confirme." });
  }
}

async function dispatch(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { db, tenantId, facts } = ctx;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined);

  switch (name) {
    case "listar_desarrollos": {
      const { all } = await findDevelopment(db, tenantId, undefined);
      const result = [];
      for (const d of all) {
        const available = await searchAvailableLots(db, tenantId, { developmentId: d.id, limit: 100 });
        const min = available[0]?.totalPriceCents;
        remember(facts, min);
        result.push({
          desarrollo: d.name,
          ubicacion: [d.address, d.city, d.state].filter(Boolean).join(", ") || null,
          amenidades: d.amenities ?? [],
          lotes_disponibles: available.length,
          precio_desde: min ? fmt(min) : null,
          descripcion: d.description,
        });
      }
      return result;
    }

    case "buscar_lotes": {
      const { match, all } = await findDevelopment(db, tenantId, str(args.desarrollo));
      if (str(args.desarrollo) && !match) return { error: "No encontré ese desarrollo.", desarrollos: all.map((d) => d.name) };
      const max = num(args.presupuesto_max_mxn);
      const minArea = num(args.superficie_min_m2);
      if (max) facts.amounts.add(Math.round(max));
      const found = await searchAvailableLots(db, tenantId, {
        ...(match ? { developmentId: match.id } : {}),
        ...(max ? { maxPriceCents: Math.round(max * 100) } : {}),
        ...(minArea ? { minAreaM2: minArea } : {}),
        ...(str(args.manzana) ? { block: str(args.manzana)!.toUpperCase() } : {}),
        limit: 6,
      });
      for (const l of found) {
        facts.lots.add(`${l.block}-${l.number}`.toUpperCase());
        remember(facts, l.totalPriceCents, l.pricePerM2Cents);
      }
      if (found.length === 0) return { lotes: [], mensaje: "No hay lotes disponibles con esos criterios." };
      return {
        lotes: found.map((l) => ({
          lote_id: l.id,
          lote: lotLabel(l),
          superficie_m2: l.areaM2,
          ...(l.frontM && l.depthM ? { medidas: `${l.frontM} x ${l.depthM} m` } : {}),
          precio_m2: fmt(l.pricePerM2Cents),
          precio_total: fmt(l.totalPriceCents),
          ...(l.features ? { caracteristicas: l.features } : {}),
        })),
        nota: "Solo se muestran lotes disponibles en este momento (máximo 6, del más económico al más caro).",
      };
    }

    case "detalle_lote": {
      let lot = str(args.lote_id) ? await getLot(db, tenantId, str(args.lote_id)!) : undefined;
      if (!lot && str(args.manzana) && (str(args.lote) ?? num(args.lote))) {
        // Búsqueda por manzana y número (cualquier estado: el prospecto puede preguntar por uno vendido).
        lot = await db
          .select()
          .from(lots)
          .where(and(eq(lots.tenantId, tenantId), eq(lots.block, str(args.manzana)!.toUpperCase()), eq(lots.number, String(args.lote).trim())))
          .get();
      }
      if (!lot) return { error: "Lote no encontrado." };
      // Se puede mencionar para decir que NO está disponible.
      facts.lots.add(`${lot.block}-${lot.number}`.toUpperCase());
      if (lot.status !== "available") return { lote: lotLabel(lot), disponible: false, mensaje: "Este lote ya no está disponible. No lo ofrezcas; sugiere otros con buscar_lotes." };
      remember(facts, lot.totalPriceCents, lot.pricePerM2Cents);
      const [dev] = await db.select().from(developments).where(eq(developments.id, lot.developmentId));
      return {
        lote_id: lot.id,
        lote: lotLabel(lot),
        desarrollo: dev?.name,
        disponible: true,
        superficie_m2: lot.areaM2,
        ...(lot.frontM && lot.depthM ? { medidas: `${lot.frontM} x ${lot.depthM} m` } : {}),
        precio_m2: fmt(lot.pricePerM2Cents),
        precio_total: fmt(lot.totalPriceCents),
        ...(lot.features ? { caracteristicas: lot.features } : {}),
      };
    }

    case "planes_de_pago": {
      const { match, all } = await findDevelopment(db, tenantId, str(args.desarrollo));
      if (!match) return { error: "Indica el desarrollo.", desarrollos: all.map((d) => d.name) };
      const plans = await plansForDevelopment(db, tenantId, match.id);
      for (const p of plans) remember(facts, p.reservationCents, p.openingFeeCents);
      return plans.map((p) => ({
        plan_id: p.id,
        plan: p.name,
        resumen: describePlan(p),
        ...(p.reservationCents ? { apartado: fmt(p.reservationCents) } : {}),
      }));
    }

    case "simular_plan": {
      const lotId = str(args.lote_id);
      const planId = str(args.plan_id);
      if (!lotId || !planId) return { error: "Faltan lote_id y plan_id." };
      const sim = await simulateForLot(db, tenantId, { lotId, planId, quoteDate: todayIn() });
      const b = sim.breakdown;
      facts.lots.add(`${sim.lot.block}-${sim.lot.number}`.toUpperCase());
      remember(
        facts,
        b.listPriceCents,
        b.discountCents,
        b.salePriceCents,
        b.reservationCents,
        b.openingFeeCents,
        b.downPaymentTotalCents,
        b.downPaymentPerInstallmentCents,
        b.downPaymentTotalCents - b.reservationCents,
        b.monthlyPaymentCents,
        b.monthlyTotalCents,
        b.onDeliveryTotalCents,
        b.onDeliveryPerInstallmentCents,
        b.totalInterestCents,
        b.salePriceCents + b.totalInterestCents,
        sim.lot.pricePerM2Cents,
      );
      return { lote: lotLabel(sim.lot), plan: sim.plan.name, ...summarizeBreakdown(b) };
    }

    case "actualizar_prospecto": {
      const parsed = prospectArgs.safeParse(args);
      if (!parsed.success) return { error: "Datos inválidos; guarda solo lo que el prospecto dijo." };
      const a = parsed.data;
      const interest = a.desarrollo_interes ? (await findDevelopment(db, tenantId, a.desarrollo_interes)).match : undefined;
      const update = {
        ...(a.nombre ? { name: a.nombre } : {}),
        ...(a.correo ? { email: a.correo.toLowerCase() } : {}),
        ...(a.ciudad ? { city: a.ciudad } : {}),
        ...(a.presupuesto_mxn ? { budgetCents: Math.round(a.presupuesto_mxn * 100) } : {}),
        ...(a.enganche_disponible_mxn !== undefined ? { downPaymentCents: Math.round(a.enganche_disponible_mxn * 100) } : {}),
        ...(a.plazo ? { timeframe: a.plazo } : {}),
        ...(a.uso ? { purpose: a.uso } : {}),
        ...(interest ? { interestDevelopmentId: interest.id } : {}),
      };
      if (Object.keys(update).length === 0) return { ok: true, sin_cambios: true };
      const [current] = await db.select().from(prospects).where(eq(prospects.id, ctx.prospectId));
      const next = { ...current!, ...update };
      await db
        .update(prospects)
        .set({ ...update, score: computeScore(next), ...(current!.stage === "new" ? { stage: "qualified" as const } : {}), updatedAt: Date.now() })
        .where(eq(prospects.id, ctx.prospectId));
      return { ok: true, guardado: Object.keys(a) };
    }

    case "escalar_a_asesor": {
      const reason = (ESCALATION_REASONS as readonly string[]).includes(String(args.motivo)) ? (args.motivo as EscalationReason) : "otro";
      const detail = (str(args.detalle) ?? "").slice(0, 500);
      await escalate(ctx, reason, detail);
      return { ok: true, mensaje: "Un asesor fue notificado. Dile al prospecto que lo contactarán en breve; no prometas nada más." };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

/** Marca el traspaso a un asesor (idempotente por turno). También lo usa el runner como red de seguridad. */
export async function escalate(ctx: ToolContext, reason: EscalationReason, detail: string): Promise<void> {
  if (ctx.escalation) return;
  ctx.escalation = { reason, detail };
  const [current] = await ctx.db.select().from(prospects).where(eq(prospects.id, ctx.prospectId));
  const now = Date.now();
  await ctx.db.batch([
    ctx.db
      .update(prospects)
      .set({
        handoffAt: current?.handoffAt ?? now,
        handoffReason: reason,
        ...(reason === "compra" ? { stage: "ready_to_buy" as const, score: 100 } : {}),
        updatedAt: now,
      })
      .where(eq(prospects.id, ctx.prospectId)),
    auditInsert(ctx.db, {
      tenantId: ctx.tenantId,
      actor: "ai",
      entity: "prospect",
      entityId: ctx.prospectId,
      action: "handoff",
      data: { reason, detail, conversationId: ctx.conversationId },
    }),
  ]);
}

