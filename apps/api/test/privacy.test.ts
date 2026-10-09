import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { validateReply } from "../src/agent/guard";
import type { ChatMessage, Completion, LlmClient } from "../src/agent/llm";
import { runAgent, type AgentInput } from "../src/agent/runner";
import { newFacts } from "../src/agent/tools";
import { hashPassword } from "../src/auth/password";
import { getDb } from "../src/db/client";
import { CONSENT_QUESTION, isAffirmative, isNegative, mentionsFinancialData } from "../src/privacy/consent";

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Step = Completion | ((messages: ChatMessage[]) => Completion);
function scripted(steps: Step[]): LlmClient {
  let calls = 0;
  return {
    model: "guion",
    async complete({ messages }) {
      const step = steps[calls++];
      if (!step) throw new Error("El guion no tiene más pasos");
      return typeof step === "function" ? step(messages) : step;
    },
  };
}
const tool = (name: string, args: Record<string, unknown> = {}): Completion => ({ content: null, toolCalls: [{ id: `t${name}`, name, args }], neurons: 1 });
const text = (content: string): Completion => ({ content, toolCalls: [], neurons: 1 });

const P = "p-priv";
const row = () => env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(P).first<Record<string, unknown>>();

async function turn(llm: LlmClient, message: string, systemSpy?: (prompt: string) => void) {
  const db = getDb(env.DB);
  const prospect = (await db.query.prospects.findFirst({ where: (p, { eq }) => eq(p.id, P) }))!;
  const spying: LlmClient = {
    model: llm.model,
    complete: (req) => {
      systemSpy?.(String(req.messages[0]?.content ?? ""));
      return llm.complete(req);
    },
  };
  const input: AgentInput = {
    db,
    llm: spying,
    tenant: { id: "tnt-demo", name: "Desarrolladora Demo" },
    conversationId: "conv-priv",
    prospect,
    history: [],
    incoming: [{ type: "text", body: message }],
  };
  return runAgent(input);
}

beforeEach(async () => {
  await env.DB.batch(
    ["appointments", "notification_reads", "notifications", "prospect_notes", "sessions", "login_attempts", "users", "ai_audit_log", "audit_log", "messages", "conversations", "prospects"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    env.DB.prepare("UPDATE tenants SET privacy_notice_url = NULL, privacy_notice_text = NULL WHERE id = 'tnt-demo'"),
    env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, stage, score, source, created_at, updated_at) VALUES (?, 'tnt-demo', '5219991112222', 'new', 0, 'whatsapp', 0, 0)").bind(P),
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('conv-priv', 'tnt-demo', ?, 'wa-demo', 0, 0)").bind(P),
  ]);
});

describe("privacidad: detección", () => {
  it("sí / no: solo respuestas afirmativas o negativas puras; el 'si' condicional no cuenta", () => {
    for (const yes of ["Sí", "si", "Sí, acepto", "claro que sí, gracias", "De acuerdo.", "ok", "Sí autorizo"]) expect(isAffirmative(yes), yes).toBe(true);
    for (const no of ["Si tengo 500 mil, ¿qué me alcanza?", "si me interesa el lote 3", "sí pero primero dime el precio", "no"]) expect(isAffirmative(no), no).toBe(false);
    for (const no of ["No", "no, gracias", "prefiero que no", "No por ahora"]) expect(isNegative(no), no).toBe(true);
    expect(isNegative("no sé todavía cuánto tengo")).toBe(false);
    // "Sí." al inicio, separado por un signo, cuenta aunque siga más texto (caso real en WhatsApp).
    for (const yes of ["Sí. Me gusta el de la manzana C lote 2", "Si, me interesa el C-2", "Claro! y mándame el plano", "Sí\nquiero ver fotos"]) expect(isAffirmative(yes), yes).toBe(true);
    for (const no of ["No. ¿Y el plano?", "No, gracias. Solo quiero ver precios"]) expect(isNegative(no), no).toBe(true);
    expect(isAffirmative("Si me lo dejas en 500 mil lo compro")).toBe(false);
  });

  it("reconoce cuando el prospecto comparte datos financieros", () => {
    expect(mentionsFinancialData("tengo 700 mil de enganche")).toBe(true);
    expect(mentionsFinancialData("mi presupuesto es de $800,000")).toBe(true);
    expect(mentionsFinancialData("lo pagaría con crédito Infonavit")).toBe(true);
    expect(mentionsFinancialData("¿dónde está el desarrollo?")).toBe(false);
  });

  it("el validador no deja pedir presupuesto ni enganche sin autorización", () => {
    const facts = newFacts();
    const ask = validateReply("¡Con gusto! ¿Cuál es tu presupuesto aproximado?", facts);
    expect(ask.ok).toBe(false);
    if (!ask.ok) expect(ask.reasons).toContain("pide datos financieros sin la autorización del prospecto");
    expect(validateReply("¿Con cuánto cuentas para el enganche?", facts).ok).toBe(false);
    expect(validateReply("¿Lo quieres para vivir o para invertir?", facts).ok).toBe(true);
    facts.financialConsent = true;
    expect(validateReply("¿Cuál es tu presupuesto aproximado?", facts).ok).toBe(true);
    // Caso real en dev: mandó el JSON de la herramienta como respuesta.
    const raw = validateReply('la respuesta fue: "{"lotes":[{"lote_id":"lot-C-2","lote":"Manzana C, lote 2","precio_total":"$560,000 MXN"}]}"', facts);
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.reasons).toContain("la respuesta trae datos internos (JSON o campos de las herramientas)");
    expect(validateReply("La respuesta de la herramienta fue exitosa. Tengo opciones para ti.", facts).ok).toBe(false);
    expect(validateReply('Ese terreno mide 200 m² y su ubicación es "privilegiada": está frente al parque.', facts).ok).toBe(true);
    // Caso real en dev: en lugar de buscar, prometió hacerlo después.
    const deferred = validateReply("Déjame consultar qué lotes tenemos disponibles. Dame un momento, por favor.", facts);
    expect(deferred.ok).toBe(false);
    if (!deferred.ok) expect(deferred.reasons).toContain("promete consultar después en lugar de usar las herramientas ahora");
  });
});

describe("privacidad: flujo con el agente", () => {
  it("aviso en la primera respuesta (una sola vez); presupuesto pendiente hasta que diga que sí", async () => {
    // 1. Da su presupuesto sin haber autorizado: se usa para responder, pero no se guarda.
    let prompt = "";
    const first = await turn(
      scripted([tool("actualizar_prospecto", { nombre: "Ana López", presupuesto_mxn: 700000, uso: "vivienda" }), text("¡Gracias, Ana! Tengo opciones para ti.")]),
      "Me llamo Ana López, tengo 700 mil y es para vivir",
      (p) => (prompt = p),
    );
    expect(prompt).toContain("NO ha autorizado datos financieros");
    expect(first.reply).toContain("¡Gracias, Ana! Tengo opciones para ti.");
    expect(first.reply).toContain(CONSENT_QUESTION);
    expect(first.reply).toMatch(/🔒 Desarrolladora Demo trata tus datos personales conforme a su aviso de privacidad/);
    let p = (await row())!;
    expect(p).toMatchObject({ name: "Ana López", purpose: "vivienda", budget_cents: null });
    expect(JSON.parse(String(p.pending_financial))).toEqual({ budgetCents: 70_000_000 });
    expect(p.privacy_notice_at).not.toBeNull();
    expect(p.consent_requested_at).not.toBeNull();

    // 2. "Sí": queda el consentimiento con su texto y se guarda el presupuesto. El aviso no se repite.
    const second = await turn(scripted([text("¡Gracias por tu confianza!")]), "Sí, acepto", (q) => (prompt = q));
    expect(prompt).toContain("acaba de AUTORIZAR");
    expect(second.reply).toBe("¡Gracias por tu confianza!");
    p = (await row())!;
    expect(p).toMatchObject({ budget_cents: 70_000_000, consent_text: "Sí, acepto", pending_financial: null });
    expect(p.consent_at).not.toBeNull();
    const audit = await env.DB.prepare("SELECT action, actor FROM audit_log WHERE entity_id = ? AND action LIKE 'consent%'").bind(P).first();
    expect(audit).toEqual({ action: "consent_given", actor: "prospect" });

    // 3. Ya autorizado: lo nuevo se guarda directo y la IA puede preguntar.
    const third = await turn(scripted([tool("actualizar_prospecto", { enganche_disponible_mxn: 150000 }), text("¿Cuál es tu presupuesto máximo?")]), "Y tengo 150 mil de enganche");
    expect(third.blocked).toEqual([]);
    expect((await row())!.down_payment_cents).toBe(15_000_000);
  });

  it("si dice que no, se descarta lo pendiente y no se le vuelve a preguntar", async () => {
    await turn(scripted([tool("actualizar_prospecto", { presupuesto_mxn: 900000 }), text("Perfecto.")]), "Tengo 900 mil");
    const denied = await turn(scripted([text("Entendido, sin problema.")]), "No, gracias");
    expect(denied.reply).toBe("Entendido, sin problema.");
    const p = (await row())!;
    expect(p).toMatchObject({ budget_cents: null, pending_financial: null, consent_at: null });
    expect(p.consent_denied_at).not.toBeNull();
    const again = await turn(scripted([tool("actualizar_prospecto", { presupuesto_mxn: 950000 }), text("Te busco opciones.")]), "Bueno, en realidad son 950 mil");
    expect(again.reply).not.toContain(CONSENT_QUESTION);
    expect((await row())!.budget_cents).toBeNull();
  });

  it("el aviso usa el enlace y el texto que configuró la desarrolladora", async () => {
    await env.DB.prepare("UPDATE tenants SET privacy_notice_url = 'https://demo.mx/privacidad' WHERE id = 'tnt-demo'").run();
    const r = await turn(scripted([text("¡Hola! ¿Buscas para vivir o para invertir?")]), "Hola");
    expect(r.reply).toContain("aviso de privacidad: https://demo.mx/privacidad");
    expect(r.reply).not.toContain(CONSENT_QUESTION);
  });
});

describe("privacidad: derechos ARCO en el panel", () => {
  const ORIGIN = "https://lynna.test";
  const T = `${ORIGIN}/api/admin/tenants/demo`;
  const PASSWORD = "Contraseña-ARCO-2026";
  async function login(id: string, email: string, role: string) {
    await env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES (?, 'tnt-demo', ?, ?, ?, ?, 1, 0)")
      .bind(id, email, id, await hashPassword(PASSWORD), role)
      .run();
    const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    return (path: string, method = "GET", body?: unknown) =>
      exports.default.fetch(`${T}${path}`, {
        method,
        headers: { cookie, ...(method !== "GET" ? { origin: ORIGIN, "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
  }

  it("exportar y eliminar: solo gerente; se borra todo y queda constancia sin datos personales", async () => {
    await turn(scripted([text("¡Hola!")]), "Hola, soy Ana");
    await env.DB.batch([
      env.DB.prepare("UPDATE prospects SET assigned_user_id = 'u-seller' WHERE id = ?").bind(P),
      env.DB.prepare(
        "INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, created_at) VALUES ('m-priv', 'tnt-demo', 'conv-priv', 'wamid.priv', 'in', 'prospect', 'text', 'Hola, soy Ana', 'received', 0, 1)",
      ),
      env.DB.prepare("INSERT INTO ai_audit_log (id, tenant_id, conversation_id, model, prompt_version, input, tool_calls, reply, blocked, latency_ms, created_at) VALUES ('ai-priv', 'tnt-demo', 'conv-priv', 'guion', 'v', 'Hola', '[]', '¡Hola!', '[]', 1, 1)"),
    ]);
    const manager = await login("u-manager", "gerente@arco.mx", "manager");
    const seller = await login("u-seller", "vendedor@arco.mx", "seller");

    expect((await seller(`/prospects/${P}/export`)).status).toBe(403);
    const exported = await manager(`/prospects/${P}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain(`prospecto-${P}.json`);
    const data = (await exported.json()) as { prospecto: { id: string }; mensajes: { texto: string }[] };
    expect(data.prospecto.id).toBe(P);
    expect(data.mensajes.map((m) => m.texto)).toContain("Hola, soy Ana");

    expect((await seller(`/prospects/${P}`, "DELETE", { reason: "Solicitud ARCO" })).status).toBe(403);
    expect((await manager(`/prospects/${P}`, "DELETE", {})).status).toBe(400);
    expect((await manager(`/prospects/${P}`, "DELETE", { reason: "Solicitud ARCO del titular por correo" })).status).toBe(204);

    expect(await row()).toBeNull();
    const left = await env.DB.prepare("SELECT (SELECT count(*) FROM messages WHERE conversation_id = 'conv-priv') AS msgs, (SELECT count(*) FROM conversations WHERE id = 'conv-priv') AS convs, (SELECT count(*) FROM ai_audit_log WHERE conversation_id = 'conv-priv') AS ai").first();
    expect(left).toEqual({ msgs: 0, convs: 0, ai: 0 });
    const trail = await env.DB.prepare("SELECT action, data FROM audit_log WHERE entity_id = ?").bind(P).all();
    expect(trail.results).toEqual([{ action: "arco_deleted", data: JSON.stringify({ reason: "Solicitud ARCO del titular por correo" }) }]);
  });
});
