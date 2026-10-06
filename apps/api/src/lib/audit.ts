import type { Db } from "../db/client";
import { auditLog } from "../db/schema";

export type AuditEntry = {
  tenantId: string;
  /** system | ai | admin-token | user:<id> */
  actor: string;
  entity: string;
  entityId: string;
  action: string;
  data?: unknown;
};

/** Devuelve la sentencia (sin ejecutar) para incluirla en el mismo db.batch que el cambio auditado. */
export function auditInsert(db: Db, entry: AuditEntry) {
  return db.insert(auditLog).values({ ...entry, data: entry.data ?? null, createdAt: Date.now() });
}
