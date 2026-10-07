// Última migración que este código necesita. Una prueba (test/schema-version.test.ts) obliga a
// actualizarla con cada migración nueva; /health la compara con la base para detectar despliegues
// con la base desactualizada (el smoke post-deploy falla si no coincide).
export const EXPECTED_MIGRATION = "0008_privacy.sql";

export async function schemaStatus(db: D1Database): Promise<{ ok: boolean; applied: string | null; expected: string }> {
  try {
    const row = await db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first<{ name: string }>();
    return { ok: row?.name === EXPECTED_MIGRATION, applied: row?.name ?? null, expected: EXPECTED_MIGRATION };
  } catch {
    return { ok: false, applied: null, expected: EXPECTED_MIGRATION };
  }
}
