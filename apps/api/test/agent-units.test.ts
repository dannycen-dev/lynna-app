import { describe, expect, it } from "vitest";
import { extractAmounts, extractLots, validateReply } from "../src/agent/guard";
import { extractProspectData, looksLikeProspectData } from "../src/agent/extract";
import { claimsMaterialSent, detectEscalation, isFiller, isOptOut, mentionsMoneyTransfer, requestedMaterial } from "../src/agent/intent";
import { normalizeCompletion, withFallback, type LlmClient } from "../src/agent/llm";
import { computeScore, temperature } from "../src/agent/qualification";
import { toWhatsAppFormat } from "../src/agent/respond";
import { markReadWithTyping } from "../src/whatsapp/client";
import { newFacts } from "../src/agent/tools";

const facts = (amounts: number[], lots: string[] = []) => {
  const f = newFacts();
  amounts.forEach((a) => f.amounts.add(a));
  lots.forEach((l) => f.lots.add(l));
  return f;
};

describe("validador de salida", () => {
  it("extrae montos en sus formatos comunes", () => {
    expect(extractAmounts("Cuesta $768,000 MXN o $21,682.30 al mes; enganche de 112 mil y total 1.5 millones")).toEqual([768000, 21682, 112000, 1500000]);
  });

  it("acepta montos verificados (y sus redondeos) y rechaza inventados", () => {
    const f = facts([768000, 21682, 112000]);
    expect(validateReply("El lote cuesta $768,000 MXN y la mensualidad $21,682.30.", f)).toEqual({ ok: true });
    expect(validateReply("Son unos 768 mil pesos.", f)).toEqual({ ok: true });
    const bad = validateReply("Te quedaría en $650,000.", f);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.reasons[0]).toContain("$650,000");
  });

  it("ignora números pequeños (porcentajes, plazos, m²)", () => {
    expect(validateReply("Enganche del 20 %, 12 meses, 250 m².", newFacts())).toEqual({ ok: true });
  });

  it("solo permite lotes devueltos por herramientas", () => {
    expect(extractLots("Manzana A, lote 7 y el lote 3 de la manzana B")).toEqual([
      { key: "A-7", number: "7" },
      { key: "B-3", number: "3" },
    ]);
    const f = facts([], ["A-1"]);
    expect(validateReply("Te recomiendo la Manzana A, lote 1.", f)).toEqual({ ok: true });
    expect(validateReply("También está la manzana A, lote 7.", f).ok).toBe(false);
    expect(validateReply("El lote 9 también te puede gustar.", f).ok).toBe(false);
  });

  it.each([
    ["Te puedo hacer un descuento del 5 %.", "descuento"],
    ["Podemos ofrecerte un descuento especial.", "descuento"],
    ["Te lo dejo en menos si cierras hoy.", "precio especial"],
    ["¡Listo! Ya quedó apartado a tu nombre.", "apartado"],
    ["Recibimos tu pago, gracias.", "pago"],
    ["La escrituración será en marzo.", "escrituración"],
    ["Te garantizo que está disponible.", "disponibilidad"],
  ])("bloquea: %s", (text, reasonPart) => {
    const r = validateReply(text, newFacts());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reasons.join(" ")).toContain(reasonPart);
  });

  it("permite hablar de descuentos sin ofrecerlos", () => {
    expect(validateReply("Los descuentos los revisa directamente un asesor; te contactará en breve.", newFacts())).toEqual({ ok: true });
  });
});

describe("red de seguridad de intención (frases del cliente)", () => {
  it.each(["Quiero comprar.", "¿Cómo puedo apartarlo?", "Quiero ver el contrato.", "¿Puedo pagar hoy?", "¿Qué necesito para escriturar?"])(
    "'%s' → compra",
    (text) => expect(detectEscalation(text)).toBe("compra"),
  );
  it.each(["¿Cuándo me entregan las escrituras?", "¿y la escritura cuándo?", "¿ya está escriturado?"])("'%s' → legal (escrituración)", (text) =>
    expect(detectEscalation(text)).toBe("legal"),
  );
  it.each(["¿Me lo apartas ya?", "apártamelo porfa", "¿lo aparto hoy?"])("'%s' → compra (apartado)", (text) => expect(detectEscalation(text)).toBe("compra"));
  it.each(["te transfiero ahorita", "les deposito mañana", "hago la transferencia hoy"])("'%s' → pago", (text) =>
    expect(detectEscalation(text)).toBe("pago"),
  );
  it("otras situaciones a turnar", () => {
    expect(detectEscalation("¿me haces un descuento?")).toBe("descuento");
    expect(detectEscalation("ya pagué, te mando el comprobante")).toBe("pago");
    expect(detectEscalation("esto es un fraude")).toBe("queja");
    expect(detectEscalation("¿qué lotes tienen?")).toBeNull();
    expect(detectEscalation("lo quiero pensar")).toBeNull();
  });
  it.each(["Hola, ¿me puede marcar un asesor?", "quiero hablar con una persona", "pásame con un vendedor", "¿me pueden llamar?", "prefiero que me atienda un asesor"])(
    "'%s' → pide un asesor",
    (text) => expect(detectEscalation(text)).toBe("otro"),
  );
  it.each(["¿cuánto tarda en llegar el asesor a la visita?", "mi asesor me dijo que hay lotes en esquina", "¿a qué hora me puede recibir el asesor en la visita?"])(
    "'%s' → no es pedir un asesor",
    (text) => expect(detectEscalation(text)).toBeNull(),
  );
  it("baja", () => {
    expect(isOptOut("BAJA")).toBe(true);
    expect(isOptOut("ya no me escriban por favor")).toBe(true);
    expect(isOptOut("¿dan de baja el apartado si no pago?")).toBe(false);
  });
});

describe("normalizeCompletion", () => {
  it("formato OpenAI (choices) con argumentos en string", () => {
    const c = normalizeCompletion({
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "buscar_lotes", arguments: '{"presupuesto_max_mxn":700000}' } }] } }],
      usage: { neurons: 4.2 },
    });
    expect(c).toMatchObject({ content: null, neurons: 4.2, toolCalls: [{ id: "c1", name: "buscar_lotes", args: { presupuesto_max_mxn: 700000 } }] });
  });
  it("formato clásico de Workers AI con argumentos en objeto", () => {
    const c = normalizeCompletion({ response: "Hola", tool_calls: [{ name: "listar_desarrollos", arguments: {} }] });
    expect(c).toMatchObject({ content: "Hola", toolCalls: [{ name: "listar_desarrollos", args: {} }] });
  });
  it("detecta respuestas truncadas (finish_reason length)", () => {
    expect(normalizeCompletion({ choices: [{ message: { content: "ese es" }, finish_reason: "length" }] }).truncated).toBe(true);
    expect(normalizeCompletion({ choices: [{ message: { content: "Listo." }, finish_reason: "stop" }] }).truncated).toBeUndefined();
  });
  it("argumentos JSON inválidos no rompen", () => {
    const c = normalizeCompletion({ choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{no json" } }] } }] });
    expect(c.toolCalls[0]!.args).toEqual({});
  });
});

it("calificación por reglas y temperatura", () => {
  const base = { name: null, budgetCents: null, downPaymentCents: null, timeframe: null, purpose: null, interestDevelopmentId: null, email: null, stage: "new" as const };
  expect(computeScore(base)).toBe(0);
  const warm = { ...base, budgetCents: 1, purpose: "vivienda" as const, name: "Ana" };
  expect(temperature(computeScore(warm))).toBe("tibio");
  expect(temperature(computeScore({ ...warm, downPaymentCents: 1, timeframe: "inmediato" as const }))).toBe("caliente");
  expect(computeScore({ ...base, stage: "ready_to_buy" })).toBe(100);
});

it("formato de WhatsApp", () => {
  expect(toWhatsAppFormat("## Opciones\n- **Enganche:** $112,000\n\n\n\nFin")).toBe("Opciones\n- *Enganche:* $112,000\n\nFin");
});

describe("modelo de respaldo", () => {
  const ok = (model: string): LlmClient => ({ model, complete: async () => ({ content: `hola de ${model}`, toolCalls: [], neurons: 1 }) });
  const down: LlmClient = { model: "caido", complete: async () => Promise.reject(new Error("4009 internal error")) };
  const input = { messages: [], tools: [] };

  it("usa el principal mientras funcione", async () => {
    expect(await withFallback(ok("principal"), ok("respaldo")).complete(input)).toMatchObject({ content: "hola de principal", model: "principal" });
  });
  it("si el principal falla, responde el de respaldo y avisa", async () => {
    const errors: unknown[] = [];
    const llm = withFallback(down, ok("respaldo"), (e) => errors.push(e));
    expect(llm.model).toBe("caido");
    expect(await llm.complete(input)).toMatchObject({ content: "hola de respaldo", model: "respaldo" });
    expect(errors).toHaveLength(1);
  });
  it("sin respaldo, el error se propaga (y el runner manda el mensaje seguro)", async () => {
    await expect(withFallback(down, null).complete(input)).rejects.toThrow("4009");
  });
});

describe("indicador de escritura en WhatsApp", () => {
  it("marca leído con typing_indicator y nunca lanza", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      expect(await markReadWithTyping({ accessToken: "t", graphVersion: "v23.0" }, "123", "wamid.X")).toBe(true);
      expect(calls[0]).toEqual({
        url: "https://graph.facebook.com/v23.0/123/messages",
        body: { messaging_product: "whatsapp", status: "read", message_id: "wamid.X", typing_indicator: { type: "text" } },
      });
      globalThis.fetch = (async () => Promise.reject(new Error("sin red"))) as typeof fetch;
      expect(await markReadWithTyping({ accessToken: "t", graphVersion: "v23.0" }, "123", "wamid.X")).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("extracción de datos del prospecto", () => {
  it("solo se intenta si el mensaje parece traer datos", () => {
    expect(looksLikeProspectData("Me llamo Juan y quiero invertir")).toBe(true);
    expect(looksLikeProspectData("tengo 150 mil de enganche")).toBe(true);
    expect(looksLikeProspectData("hola, gracias")).toBe(false);
  });

  it("toma solo campos válidos; uno inválido no tira los demás", async () => {
    const llm: LlmClient = {
      model: "x",
      complete: async () => ({
        content: 'Claro: {"nombre":"Juan Pérez","correo":"no-es-correo","presupuesto_mxn":700000,"uso":"inversion","plazo":"ayer","ciudad":null}',
        toolCalls: [],
        neurons: 2,
      }),
    };
    expect(await extractProspectData(llm, "...")).toEqual({ data: { nombre: "Juan Pérez", presupuesto_mxn: 700000, uso: "inversion" }, neurons: 2 });
  });

  it("si el modelo falla o no devuelve JSON, no pasa nada", async () => {
    const broken: LlmClient = { model: "x", complete: async () => Promise.reject(new Error("caído")) };
    expect(await extractProspectData(broken, "...")).toEqual({ data: {}, neurons: 0 });
    const noJson: LlmClient = { model: "x", complete: async () => ({ content: "no sé", toolCalls: [], neurons: 1 }) };
    expect((await extractProspectData(noJson, "...")).data).toEqual({});
  });
});

describe("material pedido y material prometido", () => {
  it.each([
    ["Me gustaría ver fotos del desarrollo y el plano", ["fotos", "plano"]],
    ["¿Cómo llego? mándame la ubicación", ["ubicacion"]],
    ["¿Dónde está el desarrollo?", ["ubicacion"]],
    ["¿Tienen imágenes de la casa club?", ["fotos"]],
    ["¿Cuánto cuesta el lote C-2?", []],
  ])("%s", (text, expected) => {
    expect(requestedMaterial(text)).toEqual(expected);
  });

  it("detecta cuando la respuesta dice que ya envió material", () => {
    expect(claimsMaterialSent("Te acabo de mandar las fotos del desarrollo y el plano maestro.")).toBe(true);
    expect(claimsMaterialSent("¡Claro! Te envío la ubicación para que llegues fácil.")).toBe(true);
    expect(claimsMaterialSent("¿Te gustaría que te envíe las fotos del desarrollo?")).toBe(false);
    expect(claimsMaterialSent("El lote mide 200 m² y cuesta $570,000 MXN.")).toBe(false);
  });
});

describe("tokens internos del modelo", () => {
  it("se quitan antes de mandar el mensaje", async () => {
    const { stripModelTokens } = await import("../src/agent/runner");
    expect(stripModelTokens("<channel|>¡Listo! Te envío la ubicación.")).toBe("¡Listo! Te envío la ubicación.");
    expect(stripModelTokens("Hola<end_of_turn>")).toBe("Hola");
    expect(stripModelTokens("<|im_start|>assistant\nHola")).toBe("assistant\nHola");
    expect(stripModelTokens("Precio desde $570,000 MXN (lote <200 m²)")).toBe("Precio desde $570,000 MXN (lote <200 m²)");
  });
});

describe("nombres de la desarrolladora en el validador", () => {
  it('"Inmobiliaria Lote 321" y "Sendero 321" no cuentan como el lote 321', async () => {
    const { withoutNames } = await import("../src/agent/runner");
    const text = "Inmobiliaria Lote 321 no recibe efectivo. En Sendero 321 Residencial pagas por transferencia.";
    const clean = withoutNames(text, ["Inmobiliaria Lote 321", "Sendero 321 Residencial"]);
    expect(clean).not.toMatch(/321/);
    expect(validateReply(clean, { lots: new Set(), amounts: new Set(), times: new Set(), dates: new Set(), booked: false, cancelled: false, existing: false, financialConsent: false }).ok).toBe(true);
  });
});

describe("muletillas de apertura", () => {
  it("espera la pregunta si solo dijo 'oye' o 'hola'", () => {
    for (const f of ["oye", "Oye!", "Hola", "buenas noches", "una pregunta", "Disculpa"]) expect(isFiller(f), f).toBe(true);
    for (const q of ["¿aceptan mascotas?", "Hola, ¿qué lotes tienen?", "info", "precio?", null]) expect(isFiller(q), String(q)).toBe(false);
  });
});

describe("aviso de seguridad de pagos", () => {
  it("detecta cuando habla de transferir o depositar", () => {
    for (const t of ["ahorita te transfiero el apartado", "Ya deposité", "¿a qué cuenta pago?", "pásame la CLABE"]) expect(mentionsMoneyTransfer(t), t).toBe(true);
    for (const t of ["¿cuánto es el enganche?", "quiero ver fotos"]) expect(mentionsMoneyTransfer(t), t).toBe(false);
  });
});
