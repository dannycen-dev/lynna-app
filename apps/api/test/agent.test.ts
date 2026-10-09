import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, Completion, LlmClient } from "../src/agent/llm";
import { FALLBACK_REPLY, MEDIA_REPLY, OPT_OUT_REPLY } from "../src/agent/prompt";
import { runAgent, withoutAdvisorOffer, type AgentInput } from "../src/agent/runner";
import { getDb } from "../src/db/client";

/** Separa el seed en sentencias (igual que seed.test.ts). */
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

/** LLM con guion: cada llamada consume el siguiente paso. Falla si se le llama de más. */
function scripted(steps: Step[]): LlmClient & { calls: number } {
  const client = {
    model: "guion",
    calls: 0,
    async complete({ messages }: { messages: ChatMessage[] }) {
      const step = steps[client.calls++];
      if (!step) throw new Error("El guion no tiene más pasos");
      return typeof step === "function" ? step(messages) : step;
    },
  };
  return client;
}
const tool = (name: string, args: Record<string, unknown> = {}): Completion => ({ content: null, toolCalls: [{ id: `t${name}`, name, args }], neurons: 2 });
const text = (content: string): Completion => ({ content, toolCalls: [], neurons: 3 });
const never: LlmClient = {
  model: "nunca",
  complete: () => {
    throw new Error("no debió llamarse al modelo");
  },
};

const PROSPECT_ID = "p-test";

async function input(llm: LlmClient, incoming: string | { type: string; body: string | null }[]): Promise<AgentInput> {
  const prospect = await env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(PROSPECT_ID).first();
  const db = getDb(env.DB);
  const [row] = await db.query.prospects.findMany({ where: (p, { eq }) => eq(p.id, PROSPECT_ID) });
  expect(prospect).not.toBeNull();
  return {
    db,
    llm,
    tenant: { id: "tnt-demo", name: "Desarrolladora Demo" },
    conversationId: "conv-test",
    prospect: row!,
    history: [],
    incoming: typeof incoming === "string" ? [{ type: "text", body: incoming }] : incoming,
  };
}

const prospectRow = () => env.DB.prepare("SELECT * FROM prospects WHERE id = ?").bind(PROSPECT_ID).first<Record<string, unknown>>();

beforeEach(async () => {
  await env.DB.batch(
    ["sessions", "users", "ai_audit_log", "audit_log", "messages", "conversations", "prospects", "lot_media"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await env.DB.batch([
    // Aviso de privacidad ya mostrado y datos financieros autorizados: estas pruebas miden el agente, no la
    // privacidad (que tiene las suyas en privacy.test.ts).
    env.DB.prepare(
      "INSERT INTO prospects (id, tenant_id, phone, stage, score, source, privacy_notice_at, consent_at, created_at, updated_at) VALUES (?, 'tnt-demo', '5219990000000', 'new', 0, 'simulator', 1, 1, 0, 0)",
    ).bind(PROSPECT_ID),
    env.DB.prepare("INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, created_at) VALUES ('conv-test', 'tnt-demo', ?, 'wa-demo', 0, 0)").bind(PROSPECT_ID),
  ]);
});

describe("runner del agente", () => {
  it("usa herramientas y responde con montos verificados", async () => {
    const llm = scripted([
      tool("buscar_lotes", { presupuesto_max_mxn: 600000 }),
      (msgs) => {
        const result = JSON.parse((msgs.at(-1) as { content: string }).content);
        const first = result.lotes[0];
        return text(`Tengo la ${first.lote} por ${first.precio_total}. ¿Te interesa?`);
      },
    ]);
    const r = await runAgent(await input(llm, "¿qué tienen por menos de 600 mil?"));
    expect(r.fallback).toBe(false);
    expect(r.blocked).toEqual([]);
    expect(r.reply).toBe("Tengo la Manzana C, lote 2 por $560,000 MXN. ¿Te interesa?");
    expect(r.toolTrace.map((t) => t.name)).toEqual(["buscar_lotes"]);
    expect(r.neurons).toBe(5);
  });

  it("bloquea un monto inventado, pide reescribir y envía la versión correcta", async () => {
    const llm = scripted([tool("buscar_lotes", {}), text("La Manzana C, lote 2 cuesta $499,000."), text("La Manzana C, lote 2 cuesta $560,000 MXN.")]);
    const r = await runAgent(await input(llm, "¿cuál es el más barato?"));
    expect(r.blocked).toEqual(["menciona $499,000 que no viene de ninguna herramienta"]);
    expect(r.reply).toBe("La Manzana C, lote 2 cuesta $560,000 MXN.");
    expect(r.draft).toContain("--- reintento ---");
    expect(r.fallback).toBe(false);
  });

  it("si vuelve a fallar, manda el mensaje seguro y turna a un asesor", async () => {
    const llm = scripted([text("Te queda en $100,000."), text("Va, en $90,000.")]);
    const r = await runAgent(await input(llm, "precio?"));
    expect(r.reply).toBe(FALLBACK_REPLY);
    expect(r.fallback).toBe(true);
    expect(r.escalation).toBe("otro");
    expect((await prospectRow())!.handoff_at).not.toBeNull();
  });

  it("una respuesta cortada por límite de tokens no se envía", async () => {
    const cut: Completion = { content: "Respecto a tu duda sobre las escrituras, ese es", toolCalls: [], neurons: 3, truncated: true };
    const r = await runAgent(await input(scripted([cut, text("Un asesor te confirmará esos detalles en breve.")]), "hola"));
    expect(r.blocked).toEqual(["respuesta incompleta (límite de tokens)"]);
    expect(r.reply).toBe("Un asesor te confirmará esos detalles en breve.");
  });

  it("bloquea promesas prohibidas aunque no tengan montos", async () => {
    const llm = scripted([text("¡Listo! Ya quedó apartado a tu nombre."), text("¡Listo! Ya quedó apartado.")]);
    const r = await runAgent(await input(llm, "hola"));
    expect(r.blocked).toContain("confirma un apartado");
    expect(r.reply).toBe(FALLBACK_REPLY);
  });

  it("si el modelo falla, responde el mensaje seguro", async () => {
    const llm: LlmClient = { model: "roto", complete: async () => Promise.reject(new Error("límite de neuronas")) };
    const r = await runAgent(await input(llm, "hola"));
    expect(r.reply).toBe(FALLBACK_REPLY);
    expect(r.blocked).toContain("error del modelo");
  });

  it("red de seguridad: 'quiero comprar' escala aunque el modelo no lo haga", async () => {
    const llm = scripted([text("¡Qué gusto! Cuéntame qué lote te interesó.")]);
    const r = await runAgent(await input(llm, "Quiero comprar"));
    expect(r.escalation).toBe("compra");
    expect(r.reply).toContain("Un asesor te contactará en breve");
    expect(await prospectRow()).toMatchObject({ stage: "ready_to_buy", score: 100, handoff_reason: "compra" });
  });

  it("ya turnado: no le ofrece un asesor como pregunta, le dice cuándo lo contactarán", async () => {
    const llm = scripted([text("¡Excelente decisión! ¿Quieres que un asesor te contacte para darte los detalles?")]);
    const r = await runAgent(await input(llm, "Quiero comprar"));
    expect(r.escalation).toBe("compra");
    expect(r.reply).toBe("¡Excelente decisión!\n\nUn asesor te contactará en breve para ayudarte con eso.");
    // Una pregunta sobre el asesor que no es oferta se respeta.
    expect(withoutAdvisorOffer("¿Tu asesor ya te mandó el plano? Va.")).toBe("¿Tu asesor ya te mandó el plano? Va.");
    expect(withoutAdvisorOffer("Claro. ¿Te gustaría que te llame un asesor hoy?")).toBe("Claro.");
  });

  it("archivos del prospecto nunca pasan por el modelo", async () => {
    const r = await runAgent(await input(never, [{ type: "image", body: "mi INE" }]));
    expect(r).toMatchObject({ reply: MEDIA_REPLY, escalation: "documentos", deterministic: true });
  });

  it("baja: se registra y no se llama al modelo", async () => {
    const r = await runAgent(await input(never, "ya no me escriban"));
    expect(r.reply).toBe(OPT_OUT_REPLY);
    expect((await prospectRow())!.opted_out_at).not.toBeNull();
  });

  it("actualizar_prospecto guarda solo campos válidos y recalcula el puntaje", async () => {
    const llm = scripted([
      tool("actualizar_prospecto", { nombre: "Ana López", presupuesto_mxn: 700000, uso: "vivienda", plazo: "inmediato", correo: "no-es-correo" }),
      tool("actualizar_prospecto", { nombre: "Ana López", presupuesto_mxn: 700000, uso: "vivienda", plazo: "inmediato" }),
      text("¡Gracias, Ana!"),
    ]);
    const r = await runAgent(await input(llm, "Soy Ana, tengo 700 mil, para vivir, ya"));
    expect(JSON.parse(r.toolTrace[0]!.result)).toHaveProperty("error");
    expect(await prospectRow()).toMatchObject({ name: "Ana López", budget_cents: 70_000_000, purpose: "vivienda", timeframe: "inmediato", stage: "qualified", score: 60 });
  });

  it("simular_plan solo con lotes disponibles", async () => {
    const llm = scripted([tool("simular_plan", { lote_id: "lot-A-7", plan_id: "plan-12msi" }), text("Ese lote ya no está disponible.")]);
    const r = await runAgent(await input(llm, "¿y el lote 7 de la A?"));
    expect(JSON.parse(r.toolTrace[0]!.result)).toEqual({ error: "El lote no está disponible." });
  });
});

describe("simulador (HTTP, modelo falso)", () => {
  const BASE = "https://lynna.test/api/admin/tenants/demo/agent/simulator";
  const auth = { authorization: `Bearer ${env.ADMIN_API_TOKEN}`, "x-simulator-session": "vitest" };
  const send = (message: string, extra: Record<string, unknown> = {}) =>
    exports.default.fetch(BASE, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ message, ...extra }) });

  it("conversa, guarda bitácora, escala y se reinicia", async () => {
    const first = await send("¿Qué lotes tienen?");
    expect(first.status).toBe(200);
    const a = (await first.json()) as { reply: string; tools: { name: string }[]; model: string };
    expect(a.model).toBe("fake");
    // Primera respuesta a un prospecto nuevo: lleva el aviso de privacidad al final.
    expect(a.reply).toMatch(/^Tengo disponible Manzana C, lote 2 por \$560,000 MXN\. ¿Te platico de los planes de pago\?\n\n🔒 .*aviso de privacidad/);
    expect(a.tools.map((t) => t.name)).toEqual(["buscar_lotes"]);

    const second = (await (await send("Quiero comprar")).json()) as { escalation: string; prospect: { stage: string } };
    expect(second.escalation).toBe("compra");
    expect(second.prospect.stage).toBe("ready_to_buy");

    const history = (await (await exports.default.fetch(BASE, { headers: auth })).json()) as { messages: { direction: string; status: string; type: string }[]; audit: unknown[] };
    // Al buscar lotes, después del texto va la lista interactiva de lotes.
    expect(history.messages.map((m) => `${m.direction}:${m.type}`)).toEqual(["in:text", "out:text", "out:list", "in:text", "out:text"]);
    expect(history.messages.filter((m) => m.direction === "out").every((m) => m.status === "simulated")).toBe(true);
    expect(history.audit).toHaveLength(2);

    expect((await exports.default.fetch(BASE, { method: "DELETE", headers: auth })).status).toBe(204);
    const empty = (await (await exports.default.fetch(BASE, { headers: auth })).json()) as { messages: unknown[] };
    expect(empty.messages).toEqual([]);
  });

  it("si el modelo no guardó datos que el prospecto dio, la extracción automática los guarda", async () => {
    const res = (await (await send("Hola, me llamo Ana Torres y quiero invertir")).json()) as {
      tools: { name: string }[];
      prospect: { name: string; purpose: string; score: number };
    };
    // El modelo (falso) solo saludó, sin herramientas…
    expect(res.tools).toEqual([]);
    // …pero el CRM quedó con los datos.
    expect(res.prospect).toMatchObject({ name: "Ana Torres", purpose: "inversion" });
    expect(res.prospect.score).toBeGreaterThan(0);
    const history = (await (await exports.default.fetch(BASE, { headers: auth })).json()) as { audit: { toolCalls: { name: string }[] }[] };
    expect(history.audit[0]!.toolCalls.map((t) => t.name)).toContain("extraccion_automatica");
  });

  it("el formato se adapta a WhatsApp y valida el cuerpo", async () => {
    expect((await send("")).status).toBe(400);
  });
});
