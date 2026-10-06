import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { lots, type LotStatus } from "../db/schema";
import { auditInsert } from "../lib/audit";
import { normalizeHeader, parseCsv } from "../lib/csv";

export const MAX_IMPORT_ROWS = 2000;

// Encabezado normalizado → campo. Acepta las variantes que suelen venir de Excel.
const HEADER_ALIASES: Record<string, keyof RawRow> = {
  manzana: "block",
  mz: "block",
  lote: "number",
  numero: "number",
  no_lote: "number",
  superficie_m2: "area",
  superficie: "area",
  m2: "area",
  area_m2: "area",
  frente_m: "front",
  frente: "front",
  fondo_m: "depth",
  fondo: "depth",
  precio_m2: "pricePerM2",
  precio_por_m2: "pricePerM2",
  precio_total: "totalPrice",
  precio: "totalPrice",
  estado: "status",
  estatus: "status",
  caracteristicas: "features",
  notas: "features",
};

const STATUS_ALIASES: Record<string, LotStatus> = {
  disponible: "available",
  available: "available",
  apartado: "reserved",
  reservado: "reserved",
  reserved: "reserved",
  vendido: "sold",
  sold: "sold",
  bloqueado: "blocked",
  blocked: "blocked",
};

type RawRow = {
  block: string;
  number: string;
  area: string;
  front: string;
  depth: string;
  pricePerM2: string;
  totalPrice: string;
  status: string;
  features: string;
};

/** "$3,200.50" → 320050 centavos. */
const moneyCents = z
  .string()
  .transform((s) => s.replace(/[$\s,]/g, ""))
  .pipe(z.string().regex(/^\d+(\.\d{1,2})?$/, "monto inválido (ej. 3200.50)"))
  .transform((s) => Math.round(Number(s) * 100));

const positiveNumber = z
  .string()
  .transform((s) => s.replace(/[\s,]/g, ""))
  .pipe(z.string().regex(/^\d+(\.\d+)?$/, "número inválido"))
  .transform(Number)
  .refine((n) => n > 0, "debe ser mayor a cero");

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema.optional());

const rowSchema = z
  .object({
    block: z.string().trim().min(1, "requerido").max(20),
    number: z.string().trim().min(1, "requerido").max(20),
    area: positiveNumber,
    front: optional(positiveNumber),
    depth: optional(positiveNumber),
    pricePerM2: moneyCents,
    totalPrice: optional(moneyCents),
    status: optional(
      z
        .string()
        .transform((s) => STATUS_ALIASES[normalizeHeader(s)])
        .pipe(z.enum(["available", "reserved", "sold", "blocked"], { error: "use disponible, apartado, vendido o bloqueado" })),
    ),
    features: optional(z.string().trim().max(500)),
  })
  .transform((r) => ({ ...r, totalPrice: r.totalPrice ?? Math.round(r.pricePerM2 * r.area) }));

export type ImportRow = z.output<typeof rowSchema>;
export type ImportError = { line: number; field?: string; message: string };

export type ParsedImport = { rows: (ImportRow & { line: number })[]; errors: ImportError[] };

const FIELD_LABELS: Record<string, string> = {
  block: "manzana",
  number: "lote",
  area: "superficie_m2",
  front: "frente_m",
  depth: "fondo_m",
  pricePerM2: "precio_m2",
  totalPrice: "precio_total",
  status: "estado",
  features: "caracteristicas",
};

export function parseLotsCsv(csv: string): ParsedImport {
  const table = parseCsv(csv);
  const errors: ImportError[] = [];
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: "El archivo está vacío." }] };

  const header = table[0]!.map((h) => HEADER_ALIASES[normalizeHeader(h)]);
  for (const required of ["block", "number", "area", "pricePerM2"] as const) {
    if (!header.includes(required)) {
      errors.push({ line: 1, field: FIELD_LABELS[required], message: `Falta la columna ${FIELD_LABELS[required]}.` });
    }
  }
  if (errors.length) return { rows: [], errors };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `Máximo ${MAX_IMPORT_ROWS} lotes por archivo.` }] };
  }

  const rows: ParsedImport["rows"] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const raw: Partial<RawRow> = {};
    header.forEach((field, col) => {
      if (field) raw[field] = cells[col] ?? "";
    });

    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = FIELD_LABELS[String(issue.path[0])] ?? String(issue.path[0]);
        errors.push({ line, field, message: issue.message });
      }
      return;
    }
    const key = `${parsed.data.block}|${parsed.data.number}`;
    const previous = seen.get(key);
    if (previous) {
      errors.push({ line, message: `Lote repetido: manzana ${parsed.data.block} lote ${parsed.data.number} (también en renglón ${previous}).` });
      return;
    }
    seen.set(key, line);
    rows.push({ ...parsed.data, line });
  });

  return { rows, errors };
}

export type ImportResult = { created: number; updated: number; statusChanges: number };

/**
 * Inserta o actualiza lotes por (desarrollo, manzana, lote) en una sola transacción.
 * El estado solo cambia si el CSV trae la columna; cada cambio queda en audit_log.
 */
export async function importLots(
  db: Db,
  ctx: { tenantId: string; developmentId: string; actor: string },
  rows: ImportRow[],
  options: { dryRun: boolean },
): Promise<ImportResult> {
  const existing = await db
    .select({ id: lots.id, block: lots.block, number: lots.number, status: lots.status })
    .from(lots)
    .where(eq(lots.developmentId, ctx.developmentId));
  const byKey = new Map(existing.map((l) => [`${l.block}|${l.number}`, l]));

  const result: ImportResult = { created: 0, updated: 0, statusChanges: 0 };
  const statements = [];
  const now = Date.now();

  for (const row of rows) {
    const current = byKey.get(`${row.block}|${row.number}`);
    const fields = {
      areaM2: row.area,
      frontM: row.front ?? null,
      depthM: row.depth ?? null,
      pricePerM2Cents: row.pricePerM2,
      totalPriceCents: row.totalPrice,
      features: row.features ?? null,
      updatedAt: now,
    };

    if (current) {
      result.updated++;
      const statusChanged = row.status !== undefined && row.status !== current.status;
      statements.push(
        db
          .update(lots)
          .set({ ...fields, ...(statusChanged ? { status: row.status, reservedUntil: null } : {}) })
          .where(eq(lots.id, current.id)),
      );
      if (statusChanged) {
        result.statusChanges++;
        statements.push(
          auditInsert(db, {
            tenantId: ctx.tenantId,
            actor: ctx.actor,
            entity: "lot",
            entityId: current.id,
            action: "status_import",
            data: { from: current.status, to: row.status },
          }),
        );
      }
    } else {
      result.created++;
      const id = crypto.randomUUID();
      statements.push(
        db.insert(lots).values({
          id,
          tenantId: ctx.tenantId,
          developmentId: ctx.developmentId,
          block: row.block,
          number: row.number,
          status: row.status ?? "available",
          ...fields,
        }),
      );
      statements.push(
        auditInsert(db, { tenantId: ctx.tenantId, actor: ctx.actor, entity: "lot", entityId: id, action: "created_import", data: { status: row.status ?? "available" } }),
      );
    }
  }

  if (!options.dryRun && statements.length > 0) {
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  }
  return result;
}
