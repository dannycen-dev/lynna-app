import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb, type Db } from "../db/client";
import { lotMedia, lots } from "../db/schema";
import { auditInsert } from "../lib/audit";

// Tipos que WhatsApp acepta como image/document y que tiene sentido mandar a un prospecto.
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

const uploadQuery = z.object({
  kind: z.enum(["photo", "plan", "brochure"]),
  lotId: z.string().optional(),
  caption: z.string().max(500).optional(),
  sort: z.coerce.number().int().min(0).max(10_000).optional(),
});

function storageUnavailable(c: Context) {
  return c.json({ error: "storage_unavailable", message: "R2 no está configurado en este entorno." }, 503);
}

/** Sube un archivo crudo (cuerpo = bytes, Content-Type = tipo) a R2 y lo registra en lot_media. */
export async function uploadMedia<E extends { Bindings: Env }>(
  c: Context<E>,
  db: Db,
  ctx: { tenantId: string; developmentId: string; actor: string },
) {
  if (!c.env.MEDIA) return storageUnavailable(c);

  const query = uploadQuery.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "validation", issues: z.flattenError(query.error).fieldErrors }, 400);

  const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = ALLOWED_TYPES[mime];
  if (!ext) return c.json({ error: "unsupported_type", message: "Solo JPG, PNG, WebP o PDF." }, 415);

  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_MEDIA_BYTES) return c.json({ error: "too_large", message: "Máximo 15 MB por archivo." }, 413);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.json({ error: "empty", message: "Archivo vacío." }, 400);
  if (bytes.byteLength > MAX_MEDIA_BYTES) return c.json({ error: "too_large", message: "Máximo 15 MB por archivo." }, 413);

  if (query.data.lotId) {
    const lot = await db
      .select({ id: lots.id })
      .from(lots)
      .where(and(eq(lots.id, query.data.lotId), eq(lots.developmentId, ctx.developmentId)))
      .get();
    if (!lot) return c.json({ error: "validation", message: "lotId no pertenece al desarrollo." }, 400);
  }

  const id = crypto.randomUUID();
  const r2Key = `t/${ctx.tenantId}/d/${ctx.developmentId}/${id}.${ext}`;
  await c.env.MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: mime, cacheControl: "public, max-age=86400" },
    customMetadata: { tenantId: ctx.tenantId, developmentId: ctx.developmentId },
  });

  try {
    const [row] = await db.batch([
      db
        .insert(lotMedia)
        .values({
          id,
          tenantId: ctx.tenantId,
          developmentId: ctx.developmentId,
          lotId: query.data.lotId ?? null,
          kind: query.data.kind,
          r2Key,
          mime,
          caption: query.data.caption ?? null,
          sort: query.data.sort ?? 0,
        })
        .returning(),
      auditInsert(db, { tenantId: ctx.tenantId, actor: ctx.actor, entity: "media", entityId: id, action: "uploaded", data: { kind: query.data.kind, bytes: bytes.byteLength } }),
    ]);
    return c.json({ ...row[0], url: `/media/${id}` }, 201);
  } catch (err) {
    // Sin registro en D1 el objeto quedaría huérfano.
    await c.env.MEDIA.delete(r2Key);
    throw err;
  }
}

export async function deleteMedia<E extends { Bindings: Env }>(
  c: Context<E>,
  db: Db,
  ctx: { tenantId: string; mediaId: string; actor: string },
) {
  if (!c.env.MEDIA) return storageUnavailable(c);
  const row = await db
    .select()
    .from(lotMedia)
    .where(and(eq(lotMedia.id, ctx.mediaId), eq(lotMedia.tenantId, ctx.tenantId)))
    .get();
  if (!row) return c.json({ error: "not_found" }, 404);
  await db.batch([
    db.delete(lotMedia).where(eq(lotMedia.id, row.id)),
    auditInsert(db, { tenantId: ctx.tenantId, actor: ctx.actor, entity: "media", entityId: row.id, action: "deleted", data: { r2Key: row.r2Key } }),
  ]);
  await c.env.MEDIA.delete(row.r2Key);
  return c.body(null, 204);
}

// Lectura pública por ID (UUID no adivinable): es material comercial que se envía a prospectos.
export const publicMedia = new Hono<{ Bindings: Env }>();

publicMedia.get("/:mediaId", async (c) => {
  if (!c.env.MEDIA) return storageUnavailable(c);
  const id = c.req.param("mediaId");
  if (!z.uuid().safeParse(id).success) return c.notFound();

  const row = await getDb(c.env.DB).select({ r2Key: lotMedia.r2Key }).from(lotMedia).where(eq(lotMedia.id, id)).get();
  if (!row) return c.notFound();

  const object = await c.env.MEDIA.get(row.r2Key, { onlyIf: c.req.raw.headers });
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  // Sin cuerpo = la precondición (If-None-Match) se cumplió.
  if (!("body" in object)) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
});
