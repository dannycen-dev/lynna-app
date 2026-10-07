import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { localToEpoch } from "../src/crm/agenda";
import { processFollowups, renderFollowup } from "../src/crm/followups";
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
const TZ = "America/Mexico_City";
// Jueves 8 de octubre de 2026, 11:00 hora del centro: dentro del horario por omisión (9 a 20).
const T0 = localToEpoch("2026-10-08", 11 * 60, TZ);
const STEPS = [
  { afterHours: 24, text: "Hola {nombre}, ¿pudiste ver {desarrollo}?" },
  { afterHours: 48, text: "Hola {nombre}, ¿te llamo?" },
];

const sentTexts = () =>
  env.DB.prepare("SELECT body FROM messages WHERE conversation_id = 'c1' AND author = 'system' ORDER BY created_at")
    .all<{ body: string }>()
    .then((r) => r.results.map((x) => x.body));
const prospect = () => env.DB.prepare("SELECT followup_step, followup_last_at FROM prospects WHERE id = 'p1'").first<{ followup_step: number; followup_last_at: number | null }>();

beforeEach(async () => {
  await env.DB.batch(
    ["notification_reads", "notifications", "sessions", "audit_log", "appointments", "ai_audit_log", "messages", "conversations", "prospects", "users"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET followups_enabled = 1, followup_steps = ?, business_hours = NULL WHERE id = 'tnt-demo'").bind(JSON.stringify(STEPS)),
    env.DB.prepare(
      "INSERT INTO prospects (id, tenant_id, phone, name, stage, score, source, interest_development_id, created_at, updated_at) VALUES ('p1', 'tnt-demo', '5219994445555', 'Ana López', 'qualified', 40, 'whatsapp', 'dev-almendros', 0, 0)",
    ),
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, last_inbound_at, created_at) VALUES ('c1', 'tnt-demo', 'p1', 'wa-demo', 0, ?, 0)").bind(T0 - 25 * H),
  ]);
});

describe("seguimientos automáticos", () => {
  it("texto con nombre y desarrollo", () => {
    expect(renderFollowup("Hola {nombre}, ¿pudiste ver {desarrollo}?", { name: "Ana López", development: "Los Almendros" })).toBe("Hola Ana, ¿pudiste ver Los Almendros?");
    expect(renderFollowup("Hola {nombre}, ¿pudiste ver {desarrollo}?", { name: null, development: null })).toBe("Hola, ¿pudiste ver nuestros desarrollos?");
  });

  it("sigue la secuencia según el silencio y no repite", async () => {
    const db = getDb(env.DB);
    expect(await processFollowups(db, T0)).toBe(1);
    expect(await sentTexts()).toEqual(["Hola Ana, ¿pudiste ver Residencial Los Almendros?"]);
    expect(await processFollowups(db, T0 + H)).toBe(0); // el paso 2 espera 48 h desde el 1
    expect(await processFollowups(db, T0 + 48 * H)).toBe(1);
    expect(await processFollowups(db, T0 + 200 * H)).toBe(0); // secuencia terminada
    expect(await sentTexts()).toHaveLength(2);
    const audit = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'followup_sent'").first();
    expect(audit).toEqual({ n: 2 });
  });

  it("si el prospecto responde, la secuencia vuelve a empezar desde el paso 1", async () => {
    const db = getDb(env.DB);
    await processFollowups(db, T0);
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE id = 'c1'").bind(T0 + 2 * H).run();
    expect(await processFollowups(db, T0 + 3 * H)).toBe(0); // todavía no hay 24 h de silencio
    expect(await processFollowups(db, T0 + 27 * H)).toBe(1);
    expect((await prospect())!.followup_step).toBe(1);
    expect((await sentTexts()).at(-1)).toBe("Hola Ana, ¿pudiste ver Residencial Los Almendros?");
  });

  it("no escribe de madrugada ni si está desactivado", async () => {
    const db = getDb(env.DB);
    expect(await processFollowups(db, localToEpoch("2026-10-08", 3 * 60, TZ))).toBe(0);
    await env.DB.prepare("UPDATE tenants SET followups_enabled = 0 WHERE id = 'tnt-demo'").run();
    expect(await processFollowups(db, T0)).toBe(0);
  });

  it.each([
    ["pidió baja", "UPDATE prospects SET opted_out_at = 1 WHERE id = 'p1'"],
    ["se turnó a un asesor", "UPDATE prospects SET handoff_at = 1 WHERE id = 'p1'"],
    ["un asesor tomó la conversación", "UPDATE conversations SET ai_paused = 1 WHERE id = 'c1'"],
    ["el equipo los pausó", "UPDATE prospects SET followups_paused_at = 1 WHERE id = 'p1'"],
    ["ya apartó", "UPDATE prospects SET stage = 'reserved' WHERE id = 'p1'"],
  ])("se detiene si %s", async (_, update) => {
    await env.DB.prepare(update).run();
    expect(await processFollowups(getDb(env.DB), T0)).toBe(0);
  });

  it("se detiene si tiene una cita agendada", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u1', 'tnt-demo', 'u@x.mx', 'U', 'x', 'seller', 1, 0)",
    ).run();
    await env.DB.prepare(
      "INSERT INTO appointments (id, tenant_id, prospect_id, user_id, starts_at, ends_at, status, source, created_at, updated_at) VALUES ('a1', 'tnt-demo', 'p1', 'u1', ?, ?, 'scheduled', 'ai', 0, 0)",
    )
      .bind(T0 + 24 * H, T0 + 25 * H)
      .run();
    expect(await processFollowups(getDb(env.DB), T0)).toBe(0);
  });
});
