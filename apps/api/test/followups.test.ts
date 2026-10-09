import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { localToEpoch } from "../src/crm/agenda";
import { processFollowups, renderFollowup, type FollowupSend } from "../src/crm/followups";
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
// Paso 1 dentro de la ventana de 24 h (texto libre); paso 2 fuera (solo con plantilla aprobada).
const STEPS = [
  { afterHours: 4, text: "Hola {nombre}, ¿pudiste ver {desarrollo}?" },
  { afterHours: 48, text: "Hola {nombre}, ¿te llamo?", template: "lynna_seguimiento_1" },
];
const TEMPLATE_1 = "Hola Ana, seguimos teniendo lotes disponibles en Residencial Los Almendros. ¿Te gustaría ver fotos o agendar una visita sin compromiso?";

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
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, last_inbound_at, created_at) VALUES ('c1', 'tnt-demo', 'p1', 'wa-demo', 0, ?, 0)").bind(T0 - 5 * H),
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
    expect(await processFollowups(db, T0 + 48 * H)).toBe(1); // fuera de la ventana: va la plantilla aprobada
    expect(await processFollowups(db, T0 + 200 * H)).toBe(0); // secuencia terminada
    expect(await sentTexts()).toEqual(["Hola Ana, ¿pudiste ver Residencial Los Almendros?", TEMPLATE_1]);
    const audit = await env.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'followup_sent'").first();
    expect(audit).toEqual({ n: 2 });
  });

  it("si el prospecto responde, la secuencia vuelve a empezar desde el paso 1", async () => {
    const db = getDb(env.DB);
    await processFollowups(db, T0);
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE id = 'c1'").bind(T0 + 2 * H).run();
    expect(await processFollowups(db, T0 + 3 * H)).toBe(0); // todavía no hay 4 h de silencio
    expect(await processFollowups(db, T0 + 7 * H)).toBe(1);
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

  describe("políticas de WhatsApp (envío real)", () => {
    const calls: FollowupSend[] = [];
    const ok = async (m: FollowupSend) => (calls.push(m), { wamid: `wamid.${calls.length}` });
    beforeEach(() => void (calls.length = 0));
    const lastMessage = () =>
      env.DB.prepare("SELECT status, error FROM messages WHERE conversation_id = 'c1' AND author = 'system' ORDER BY created_at DESC LIMIT 1").first<{ status: string; error: string | null }>();

    it("dentro de 24 h manda texto con botones; fuera, la plantilla con su botón de baja", async () => {
      const db = getDb(env.DB);
      expect(await processFollowups(db, T0, ok)).toBe(1);
      expect(calls[0]!.template).toBeNull();
      expect(calls[0]!.text!.buttons.map((b) => b.title)).toEqual(["Ver fotos", "Agendar visita"]);
      await env.DB.prepare("UPDATE messages SET status = 'read', status_rank = 4 WHERE wamid = 'wamid.1'").run();
      expect(await processFollowups(db, T0 + 48 * H, ok)).toBe(1);
      expect(calls[1]!.text).toBeNull();
      expect(calls[1]!.template).toMatchObject({ name: "lynna_seguimiento_1", params: ["Ana", "Residencial Los Almendros"] });
      expect(calls[1]!.template!.buttons.map((b) => b.title)).toContain("Ya no, gracias");
    });

    it("no manda el siguiente si no leyó el anterior (cuida la calidad del número)", async () => {
      const db = getDb(env.DB);
      await processFollowups(db, T0, ok); // queda "accepted", nunca "read"
      expect(await processFollowups(db, T0 + 48 * H, ok)).toBe(0);
      expect(calls).toHaveLength(1);
      expect((await prospect())!.followup_step).toBe(STEPS.length);
    });

    it("fuera de la ventana y sin plantilla no escribe", async () => {
      await env.DB.prepare("UPDATE tenants SET followup_steps = ? WHERE id = 'tnt-demo'").bind(JSON.stringify([{ afterHours: 30, text: "Hola" }])).run();
      await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE id = 'c1'").bind(T0 - 31 * H).run();
      expect(await processFollowups(getDb(env.DB), T0, ok)).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it("131050 (el usuario dejó de recibir marketing) cuenta como baja", async () => {
      const fail = async () => {
        throw Object.assign(new Error("WhatsApp Cloud API 400"), { code: 131050 });
      };
      expect(await processFollowups(getDb(env.DB), T0, fail, (e) => (e as { code: number }).code)).toBe(0);
      expect((await lastMessage())!.status).toBe("failed");
      const p = await env.DB.prepare("SELECT opted_out_at FROM prospects WHERE id = 'p1'").first<{ opted_out_at: number | null }>();
      expect(p!.opted_out_at).toBe(T0);
    });

    it("tras un fallo (p. ej. 131049, tope diario de marketing) espera 24 h para reintentar", async () => {
      const db = getDb(env.DB);
      const capped = async () => {
        throw new Error("131049");
      };
      expect(await processFollowups(db, T0, capped)).toBe(0);
      expect(await processFollowups(db, T0 + 2 * H, ok)).toBe(0);
      expect(calls).toHaveLength(0);
      expect((await prospect())!.followup_step).toBe(0);
    });
  });
});
