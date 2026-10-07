import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { kbArticles } from "../db/schema";

// Búsqueda en la base de conocimiento con el índice FTS5 `kb_fts` (bm25: el título pesa más que las
// palabras clave, y estas más que el texto). Sin "stemming" en español, así que cada palabra se busca por su
// raíz aproximada como prefijo: "escrituras" → escritur*, "construir" → constru*, "pago" → pag*.

const STOPWORDS = new Set(
  "que como cual cuales cuando donde quien para por con sin sobre entre hasta desde los las les una uno unos unas del al mis tus sus esta este esto estos estas ese esa eso hay tiene tienen tengo puedo puede pueden quiero queria hola gracias favor buenas buenos dias tardes noches mas muy pero porque tambien ya si no es son ser estar fue era hace hacer algo alguna alguno saber sabes dime informacion pregunta usted ustedes".split(
    " ",
  ),
);

const strip = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Pregunta libre → consulta FTS5 ('"agu"* OR "luz"*'). null si no quedan palabras útiles. */
export function ftsQuery(text: string): string | null {
  const words = [
    ...new Set(
      strip(text)
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
  if (words.length === 0) return null;
  const roots = [...new Set(words.map((w) => (w.length <= 3 ? w : w.slice(0, Math.max(3, w.length - 2)))))];
  return roots.slice(0, 12).map((r) => `"${r}"*`).join(" OR ");
}

export type KbHit = { id: string; title: string; body: string; category: string; developmentId: string | null; status: string };

/** Artículos más relevantes. La IA solo ve los aprobados (`approvedOnly`). */
export async function searchKnowledge(
  db: Db,
  tenantId: string,
  question: string,
  opts: { limit?: number; approvedOnly?: boolean; developmentId?: string | null } = {},
): Promise<KbHit[]> {
  const query = ftsQuery(question);
  if (!query) return [];
  return db
    .select({ id: kbArticles.id, title: kbArticles.title, body: kbArticles.body, category: kbArticles.category, developmentId: kbArticles.developmentId, status: kbArticles.status })
    .from(sql`kb_fts`)
    .innerJoin(kbArticles, sql`${kbArticles}.rowid = kb_fts.rowid`)
    .where(
      and(
        sql`kb_fts MATCH ${query}`,
        eq(kbArticles.tenantId, tenantId),
        opts.approvedOnly ? eq(kbArticles.status, "approved") : undefined,
        // Si se pregunta por un desarrollo, también valen los artículos generales.
        opts.developmentId ? or(isNull(kbArticles.developmentId), eq(kbArticles.developmentId, opts.developmentId)) : undefined,
      ),
    )
    .orderBy(sql`bm25(kb_fts, 5.0, 3.0, 1.0)`)
    .limit(opts.limit ?? 3);
}
