import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { changeLotStatus, releaseExpiredReservations, warnExpiringReservations } from "../src/catalog/service";
import { getDb } from "../src/db/client";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const H = 3_600_000;
const notices = () => env.DB.prepare("SELECT user_id, prospect_id, kind, title, body FROM notifications ORDER BY user_id").all<Record<string, string | null>>().then((r) => r.results);

beforeEach(async () => {
  await env.DB.batch(
    ["notification_reads", "notifications", "sessions", "audit_log", "appointments", "messages", "conversations", "prospects", "availability_rules", "kb_articles", "users"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-laura', 'tnt-demo', 'l@x.mx', 'Laura', 'x', 'manager', 1, 0)"),
    env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-miguel', 'tnt-demo', 'm@x.mx', 'Miguel', 'x', 'seller', 1, 0)"),
    env.DB.prepare(
      "INSERT INTO prospects (id, tenant_id, phone, name, stage, score, source, assigned_user_id, created_at, updated_at) VALUES ('p1', 'tnt-demo', '5219990002222', 'Ana López', 'negotiation', 80, 'whatsapp', 'u-miguel', 0, 0)",
    ),
  ]);
});

describe("apartados: quién, para quién y avisos", () => {
  it("al apartar para un prospecto: guarda quién lo apartó y el prospecto pasa a Apartado", async () => {
    const db = getDb(env.DB);
    const lot = await changeLotStatus(db, "tnt-demo", "lot-A-1", { status: "reserved", reason: "Pagó apartado", reservedUntil: Date.now() + 48 * H, prospectId: "p1" }, "user:u-laura");
    expect(lot).toMatchObject({ status: "reserved", reservedByUserId: "u-laura", reservedForProspectId: "p1" });
    const p = await env.DB.prepare("SELECT stage FROM prospects WHERE id = 'p1'").first();
    expect(p).toEqual({ stage: "reserved" });
    await expect(changeLotStatus(db, "tnt-demo", "lot-A-2", { status: "reserved", reason: "x", reservedUntil: Date.now() + H, prospectId: "no-existe" }, "user:u-laura")).rejects.toThrow(
      "Prospecto no encontrado.",
    );
  });

  it("24 h antes avisa una sola vez; al vencer libera el lote y avisa a quien apartó y al vendedor", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await changeLotStatus(db, "tnt-demo", "lot-A-1", { status: "reserved", reason: "Pagó apartado", reservedUntil: now + 10 * H, prospectId: "p1" }, "user:u-laura");

    expect(await warnExpiringReservations(db, now)).toBe(1);
    expect(await warnExpiringReservations(db, now + H)).toBe(0);
    let n = await notices();
    expect(n.map((x) => x.user_id)).toEqual(["u-laura", "u-miguel"]);
    expect(n[0]).toMatchObject({ kind: "reservation", prospect_id: "p1", title: "Vence pronto el apartado: Manzana A, lote 1" });
    expect(n[0]!.body).toContain("Es para Ana López.");

    await env.DB.prepare("DELETE FROM notifications").run();
    const released = await releaseExpiredReservations(db, now + 11 * H);
    expect(released.map((l) => l.id)).toEqual(["lot-A-1"]);
    const lot = await env.DB.prepare("SELECT status, reserved_by_user_id, reserved_for_prospect_id FROM lots WHERE id = 'lot-A-1'").first();
    expect(lot).toEqual({ status: "available", reserved_by_user_id: null, reserved_for_prospect_id: null });
    n = await notices();
    expect(n.map((x) => x.user_id)).toEqual(["u-laura", "u-miguel"]);
    expect(n[0]!.title).toBe("Se liberó el apartado: Manzana A, lote 1");
    expect(n[0]!.body).toMatch(/^Era para Ana López\. Venció el .+\. Ya está disponible y la IA lo puede ofrecer\.$/);
  });

  it("sin quién ni para quién (apartado por automatización), el aviso va a todo el equipo", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await changeLotStatus(db, "tnt-demo", "lot-A-1", { status: "reserved", reason: "x", reservedUntil: now + H }, "admin-token");
    await releaseExpiredReservations(db, now + 2 * H);
    const n = await notices();
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ user_id: null, prospect_id: null, title: "Se liberó el apartado: Manzana A, lote 1" });
  });

  it("extender un apartado vuelve a permitir el aviso de 24 h", async () => {
    const db = getDb(env.DB);
    const now = Date.now();
    await changeLotStatus(db, "tnt-demo", "lot-A-1", { status: "reserved", reason: "x", reservedUntil: now + 5 * H }, "user:u-laura");
    expect(await warnExpiringReservations(db, now)).toBe(1);
    await changeLotStatus(db, "tnt-demo", "lot-A-1", { status: "reserved", reason: "Extiende 3 días", reservedUntil: now + 72 * H }, "user:u-laura");
    expect(await warnExpiringReservations(db, now + 50 * H)).toBe(1);
  });
});
