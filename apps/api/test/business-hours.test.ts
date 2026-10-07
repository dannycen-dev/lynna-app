import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Completion, LlmClient } from "../src/agent/llm";
import { runAgent } from "../src/agent/runner";
import { hashPassword } from "../src/auth/password";
import { localToEpoch, weekdayOf } from "../src/crm/agenda";
import { advisorEta, isOpen, openMinutesBetween } from "../src/crm/business-hours";
import { getDb } from "../src/db/client";
import { addDays, todayIn } from "../src/financing/dates";

const TZ = "America/Mexico_City";
// Lunes a viernes 9:00–18:00 y sábado 9:00–14:00.
const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 })).concat([{ weekday: 6, startMinute: 540, endMinute: 840 }]);
const at = (date: string, hh: number, mm = 0) => localToEpoch(date, hh * 60 + mm, TZ);

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("horario de atención", () => {
  it("abierto / cerrado y qué se le promete al prospecto", () => {
    // 2026-10-09 es viernes; 2026-10-10 sábado; 2026-10-11 domingo.
    expect(isOpen(OFFICE, TZ, at("2026-10-09", 10))).toBe(true);
    expect(advisorEta(OFFICE, TZ, at("2026-10-09", 10))).toBe("en breve");
    expect(advisorEta(OFFICE, TZ, at("2026-10-09", 8, 15))).toBe("hoy a partir de las 9:00");
    expect(advisorEta(OFFICE, TZ, at("2026-10-09", 19))).toBe("mañana a partir de las 9:00");
    expect(advisorEta(OFFICE, TZ, at("2026-10-10", 23))).toBe("el lunes 12 de octubre a partir de las 9:00");
    expect(advisorEta(OFFICE, TZ, at("2026-10-11", 8))).toBe("mañana a partir de las 9:00");
    // Sin horario configurado no se promete nada distinto.
    expect(advisorEta(null, TZ, at("2026-10-11", 3))).toBe("en breve");
    expect(advisorEta([], TZ, at("2026-10-11", 3))).toBe("en breve");
  });
});

describe("tiempo de respuesta del asesor en horario de oficina", () => {
  it("no cuenta noches, fines de semana ni días festivos", () => {
    // Viernes 23:00 → lunes 9:05 = 5 min de oficina (el sábado 9–14 se cuenta si se atiende ese día).
    expect(openMinutesBetween(OFFICE, TZ, at("2026-10-09", 23), at("2026-10-12", 9, 5))).toBe(5 + 300);
    expect(openMinutesBetween(OFFICE, TZ, at("2026-10-10", 15), at("2026-10-12", 9, 5))).toBe(5);
    // Dentro del horario cuenta corrido.
    expect(openMinutesBetween(OFFICE, TZ, at("2026-10-09", 10), at("2026-10-09", 10, 20))).toBe(20);
    // Lunes festivo: martes 9:05 = 5 min.
    expect(openMinutesBetween(OFFICE, TZ, at("2026-10-10", 15), at("2026-10-13", 9, 5), new Set(["2026-10-12"]))).toBe(5);
    // Sin horario: tiempo corrido.
    expect(openMinutesBetween(null, TZ, at("2026-10-09", 23), at("2026-10-10", 1))).toBe(120);
  });
});

describe("horario de atención en el agente", () => {
  const P = "p-hours";
  const text = (content: string): Completion => ({ content, toolCalls: [], neurons: 1 });

  beforeEach(async () => {
    await env.DB.batch(
      ["sessions", "login_attempts", "users", "ai_audit_log", "audit_log", "notifications", "messages", "conversations", "prospects"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    );
    await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
    // Oficina que solo abre dentro de 3 días a las 9:00: ahora siempre está cerrada, sin importar cuándo corra la prueba.
    const openDay = weekdayOf(addDays(todayIn(TZ), 3));
    await env.DB.batch([
      env.DB.prepare("UPDATE tenants SET assistant_name = 'Sofía', business_hours = ? WHERE id = 'tnt-demo'").bind(JSON.stringify([{ weekday: openDay, startMinute: 540, endMinute: 1080 }])),
      env.DB.prepare(
        "INSERT INTO prospects (id, tenant_id, phone, stage, score, source, privacy_notice_at, consent_at, created_at, updated_at) VALUES (?, 'tnt-demo', '5219993334444', 'new', 0, 'whatsapp', 1, 1, 0, 0)",
      ).bind(P),
      env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('conv-hours', 'tnt-demo', ?, 'wa-demo', 0, 0)").bind(P),
    ]);
  });

  async function turn(llm: LlmClient, message: string) {
    const db = getDb(env.DB);
    const prospect = (await db.query.prospects.findFirst({ where: (p, { eq }) => eq(p.id, P) }))!;
    return runAgent({ db, llm, tenant: { id: "tnt-demo", name: "Desarrolladora Demo" }, conversationId: "conv-hours", prospect, history: [], incoming: [{ type: "text", body: message }] });
  }

  it("fuera de horario: se presenta con su nombre y promete el contacto para cuando abre la oficina", async () => {
    let prompt = "";
    const llm: LlmClient = {
      model: "guion",
      async complete(req) {
        prompt = String(req.messages[0]?.content);
        return text("¡Qué gusto que te interese!");
      },
    };
    const r = await turn(llm, "Quiero comprar el lote");
    expect(prompt).toContain("Eres Sofía");
    expect(prompt).toContain("la oficina de ventas está cerrada");
    // La red de seguridad turnó y agregó la promesa con la hora real de apertura.
    expect(r.escalation).toBe("compra");
    // \p{L}: "sábado" y "miércoles" llevan acento (\w no los reconoce).
    expect(r.reply).toMatch(/Un asesor te contactará el \p{L}+ \d{1,2} de \p{L}+ a partir de las 9:00 para ayudarte con eso\./u);
  });

  it("el modelo puede repetir la hora de apertura (dato del sistema) y el respaldo también la usa", async () => {
    const eta = advisorEta([{ weekday: weekdayOf(addDays(todayIn(TZ), 3)), startMinute: 540, endMinute: 1080 }], TZ);
    const ok = await turn({ model: "guion", complete: async () => text(`Un asesor te contactará ${eta}.`) }, "Hola, ¿me pueden llamar?");
    expect(ok.blocked).toEqual([]);
    expect(ok.reply).toContain(`Un asesor te contactará ${eta}.`);
    const failing = await turn({ model: "guion", complete: async () => { throw new Error("caído"); } }, "Hola");
    expect(failing.reply).toContain(`un asesor te va a contactar ${eta} por este medio`);
  });

  it("API: el gerente cambia nombre y horario; la vista previa dice qué prometería ahora", async () => {
    await env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES ('u-m', 'tnt-demo', 'g@h.mx', 'G', ?, 'manager', 1, 0)")
      .bind(await hashPassword("Contraseña-Horario-2026"))
      .run();
    const login = await exports.default.fetch("https://lynna.test/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://lynna.test" },
      body: JSON.stringify({ email: "g@h.mx", password: "Contraseña-Horario-2026" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const patch = (body: unknown) =>
      exports.default.fetch("https://lynna.test/api/admin/tenants/demo/settings/agent", {
        method: "PATCH",
        headers: { cookie, origin: "https://lynna.test", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await patch({ businessHours: [{ weekday: 1, startMinute: 600, endMinute: 540 }] })).status).toBe(400);
    const allDay = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 }));
    const saved = (await (await patch({ assistantName: "Valeria", businessHours: allDay })).json()) as { assistantName: string; advisorEtaNow: string };
    expect(saved).toMatchObject({ assistantName: "Valeria", advisorEtaNow: "en breve" });
  });
});
