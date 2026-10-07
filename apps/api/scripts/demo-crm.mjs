#!/usr/bin/env node
// Datos FICTICIOS del CRM para demos: prospectos en todas las etapas, conversaciones, notas,
// historial y avisos, repartidos entre los usuarios de demo (pnpm demo:users).
//
//   pnpm --filter @lynna/api demo:crm --target dev      (local | dev | stg — nunca prod)
//
// Idempotente: borra y recrea solo lo suyo (ids "demo-p-*", "demo-c-*", "demo-ap-*" y el horario de citas
// de los vendedores de demo).
// Requiere el seed de inventario (tenant "tnt-demo", número "wa-demo") y, para asignar, los usuarios de demo.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { target: { type: "string", default: "local" }, "persist-to": { type: "string" } } });
if (!["local", "dev", "stg"].includes(a.target)) {
  console.error("✘ --target debe ser local, dev o stg (los datos de demo no van en prod).");
  process.exit(1);
}

const NOW = Date.now();
const MIN = 60_000;
const H = 60 * MIN;
const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`);
const user = (email) => (email ? `(SELECT id FROM users WHERE email = ${q(email)})` : "NULL");

const MIGUEL = "miguel.torres@lynna.mx";
const ANA = "ana.hernandez@lynna.mx";
const LAURA = "laura.gonzalez@lynna.mx";

// [dirección, autor, texto, minutos atrás]
const P = [
  {
    n: 1, name: null, profile: "Ana Lucía Pérez", stage: "new", score: 0, seller: MIGUEL, ago: 0.3 * H,
    msgs: [
      ["in", "prospect", "Hola, vi su anuncio. ¿Qué terrenos tienen?", 20],
      ["out", "ai", "¡Hola, Ana Lucía! Soy Lynna, de Desarrolladora Demo. Tenemos lotes en *Residencial Los Almendros*, en Mérida, desde $560,000 MXN. ¿Buscas para vivir o para invertir?", 19],
    ],
  },
  {
    n: 2, name: "Roberto Chan", stage: "qualified", score: 50, seller: ANA, ago: 5 * H,
    budget: 650_000, purpose: "vivienda", timeframe: "3-6_meses", city: "Mérida",
    msgs: [
      ["in", "prospect", "Buenas, soy Roberto. Busco un terreno para construir mi casa, tengo unos 650 mil", 310],
      ["out", "ai", "¡Mucho gusto, Roberto! Con $650,000 MXN tengo disponibles la Manzana C, lote 2 (200 m² por $560,000 MXN) y la Manzana C, lote 5 (210 m² por $588,000 MXN). ¿Te platico los planes de pago?", 309],
      ["in", "prospect", "Sí, pero lo vería en unos meses", 300],
      ["out", "ai", "Claro, sin prisa. Cuando gustes te comparto opciones de enganche y mensualidades.", 299],
    ],
  },
  {
    n: 3, name: "Fernanda Ruiz", stage: "appointment", score: 75, seller: MIGUEL, ago: 2 * H,
    budget: 900_000, downPayment: 200_000, purpose: "inversion", timeframe: "inmediato", email: "fernanda.ruiz@example.com",
    msgs: [
      ["in", "prospect", "Hola, quiero invertir. Tengo 200 mil de enganche y presupuesto de 900 mil", 130],
      ["out", "ai", "¡Excelente, Fernanda! Para inversión te recomiendo la Manzana D, frente a parque. ¿Te comparto la simulación a 36 meses?", 129],
      ["in", "prospect", "Sí por favor", 125],
      ["out", "ai", "Con gusto. Es una cotización informativa, sujeta a confirmación por un asesor. Un asesor te puede compartir los detalles por llamada si lo prefieres.", 124],
      ["in", "prospect", "¿Puedo ir a verlo mañana en la mañana?", 122],
      ["out", "ai", "¡Claro! Tengo libre mañana a las 10:00 o a las 11:00. ¿Cuál te acomoda?", 121],
      ["in", "prospect", "A las 10", 120],
      ["out", "ai", "¡Listo! Tu visita quedó agendada para mañana a las 10:00. Un asesor te recibirá en el desarrollo.", 119],
    ],
  },
  {
    n: 4, name: "Jorge Pech", stage: "appointment", score: 60, seller: ANA, ago: 26 * H,
    budget: 700_000, purpose: "vivienda", timeframe: "1-3_meses",
    msgs: [
      ["in", "prospect", "¿Puedo ir a ver los lotes este sábado?", 1580],
      ["out", "ai", "¡Claro, Jorge! Te comunico con tu asesora para agendar la visita.", 1579],
      ["out", "user", "Hola Jorge, soy Ana. Te espero el sábado a las 11:00 en la caseta de ventas. 📍", 1500],
      ["in", "prospect", "Perfecto, ahí nos vemos", 1490],
    ],
    notes: [[ANA, "Visita agendada sábado 11:00. Viene con su esposa."]],
  },
  {
    n: 5, name: "Mariana Solís", stage: "visited", score: 70, seller: MIGUEL, ago: 3 * 24 * H,
    budget: 800_000, downPayment: 150_000, purpose: "vivienda", timeframe: "1-3_meses",
    msgs: [
      ["in", "prospect", "Gracias por la visita de ayer, me gustó mucho el lote 2 de la manzana C", 4320],
      ["out", "user", "¡Qué gusto, Mariana! Te preparo la cotización con el plan de 12 meses sin intereses.", 4300],
    ],
    notes: [[MIGUEL, "Le gustó Manzana C, lote 2. Pidió cotización 12 MSI."]],
  },
  {
    n: 6, name: "Carlos Uc", stage: "negotiation", score: 80, seller: MIGUEL, ago: 6 * H, taken: MIGUEL,
    budget: 750_000, downPayment: 180_000, purpose: "inversion", timeframe: "inmediato",
    msgs: [
      ["in", "prospect", "Me interesa, pero quiero ver si se puede pagar en 18 meses", 380],
      ["out", "ai", "Entiendo, Carlos. Un asesor te contactará en breve para revisar las opciones de plazo.", 379],
      ["out", "user", "Hola Carlos, soy Miguel. Tenemos la Preventa 30/50/20 con 18 mensualidades. ¿Te llamo a las 5?", 360],
      ["in", "prospect", "Sí, a las 5 está bien", 355],
    ],
    notes: [[MIGUEL, "Negociando plan Preventa 30/50/20. Llamada a las 17:00."]],
  },
  {
    n: 7, name: "Daniela Castro", stage: "ready_to_buy", score: 100, seller: ANA, ago: 0.4 * H,
    budget: 600_000, downPayment: 120_000, purpose: "vivienda", timeframe: "inmediato", handoff: "compra",
    msgs: [
      ["in", "prospect", "Ya me decidí, quiero comprar el lote 2 de la manzana C. ¿Cómo lo aparto?", 25],
      ["out", "ai", "¡Qué gusto, Daniela! Para el apartado, un asesor te contactará en breve para guiarte paso a paso.", 24],
    ],
    notify: { title: "Daniela Castro quiere comprar", body: "Quiere apartar la Manzana C, lote 2." },
  },
  {
    n: 8, name: "Luis Herrera", stage: "qualified", score: 45, seller: MIGUEL, ago: 1.5 * H, handoff: "descuento",
    budget: 850_000, purpose: "inversion",
    msgs: [
      ["in", "prospect", "Si pago de contado, ¿cuánto me descuentan?", 95],
      ["out", "ai", "Buena pregunta, Luis. Los descuentos los revisa directamente un asesor; te contactará en breve.", 94],
    ],
    notify: { title: "Luis Herrera pide un descuento", body: "Pregunta por descuento pagando de contado." },
  },
  {
    n: 9, name: "Patricia May", stage: "reserved", score: 100, seller: ANA, ago: 2 * 24 * H, purpose: "vivienda", budget: 720_000,
    msgs: [
      ["in", "prospect", "Ya hice la transferencia del apartado", 2900],
      ["out", "user", "¡Gracias, Patricia! Ya validamos tu pago de apartado. Te envío el contrato por correo.", 2880],
    ],
    notes: [[ANA, "Pagó apartado de $10,000 (transferencia validada por administración)."]],
  },
  {
    n: 10, name: "Eduardo Cauich", stage: "won", score: 100, seller: MIGUEL, ago: 6 * 24 * H, purpose: "inversion", budget: 980_000,
    msgs: [["in", "prospect", "Ya firmé, muchas gracias por todo", 8640]],
    notes: [[MIGUEL, "Venta cerrada: Manzana D, lote 4. Plan 36 meses."]],
  },
  {
    n: 11, name: "Sofía Novelo", stage: "lost", score: 30, seller: ANA, ago: 9 * 24 * H, lost: "Compró en otro desarrollo",
    msgs: [["in", "prospect", "Gracias, al final encontramos algo más cerca de la ciudad", 12960]],
  },
  {
    n: 12, name: null, profile: "Ricardo Dzul", stage: "new", score: 0, seller: null, ago: 0.6 * H, handoff: "documentos",
    msgs: [
      ["in", "prospect", "[imagen] Les mando mi INE para el trámite", 38],
      ["out", "ai", "Gracias, recibimos tu archivo. Por seguridad, un asesor lo revisará y te contactará en breve por este medio.", 37],
    ],
    notify: { title: "Ricardo Dzul envió documentos", body: "El prospecto envió 1 archivo(s)." },
  },
];

const sql = [];
sql.push(
  "DELETE FROM kb_articles WHERE id LIKE 'demo-kb-%'",
  "DELETE FROM appointments WHERE prospect_id LIKE 'demo-p-%'",
  `DELETE FROM availability_rules WHERE user_id IN (${user(MIGUEL)}, ${user(ANA)})`,
  "DELETE FROM notification_reads WHERE notification_id IN (SELECT id FROM notifications WHERE prospect_id LIKE 'demo-p-%')",
  "DELETE FROM notifications WHERE prospect_id LIKE 'demo-p-%'",
  "DELETE FROM prospect_notes WHERE prospect_id LIKE 'demo-p-%'",
  "DELETE FROM ai_audit_log WHERE conversation_id LIKE 'demo-c-%'",
  "DELETE FROM messages WHERE conversation_id LIKE 'demo-c-%'",
  "DELETE FROM audit_log WHERE entity_id LIKE 'demo-%'",
  "DELETE FROM conversations WHERE id LIKE 'demo-c-%'",
  "DELETE FROM prospects WHERE id LIKE 'demo-p-%'",
);

for (const p of P) {
  const id = `demo-p-${String(p.n).padStart(2, "0")}`;
  const cid = `demo-c-${String(p.n).padStart(2, "0")}`;
  const created = NOW - p.ago - 2 * H;
  const lastIn = Math.max(...p.msgs.filter((m) => m[0] === "in").map((m) => NOW - m[3] * MIN), created);
  const handoffAt = p.handoff ? NOW - (p.msgs.find((m) => m[1] === "ai")?.[3] ?? 10) * MIN : null;
  const phone = `52199990${String(p.n).padStart(5, "0")}`;
  const reason = p.handoff ?? (p.stage === "ready_to_buy" ? "compra" : null);

  sql.push(`INSERT INTO prospects (id, tenant_id, phone, name, profile_name, email, stage, score, budget_cents, down_payment_cents, purpose, timeframe, city,
    assigned_user_id, assigned_at, handoff_at, handoff_reason, source, created_at, updated_at)
    VALUES (${q(id)}, 'tnt-demo', ${q(phone)}, ${q(p.name)}, ${q(p.profile ?? p.name)}, ${q(p.email)}, ${q(p.stage)}, ${p.score},
    ${q(p.budget ? p.budget * 100 : null)}, ${q(p.downPayment ? p.downPayment * 100 : null)}, ${q(p.purpose)}, ${q(p.timeframe)}, ${q(p.city)},
    ${user(p.seller)}, ${p.seller ? created : "NULL"}, ${q(handoffAt)}, ${q(reason)}, 'whatsapp', ${created}, ${lastIn})`);

  sql.push(`INSERT INTO conversations (id, tenant_id, prospect_id, wa_account_id, ai_paused, taken_by_user_id, taken_at, last_inbound_at, last_outbound_at, created_at)
    VALUES (${q(cid)}, 'tnt-demo', ${q(id)}, 'wa-demo', ${p.taken ? 1 : 0}, ${user(p.taken)}, ${p.taken ? NOW - 365 * MIN : "NULL"}, ${lastIn}, ${lastIn + MIN}, ${created})`);

  p.msgs.forEach(([dir, author, body, minAgo], i) => {
    const at = NOW - minAgo * MIN;
    const type = body.startsWith("[imagen]") ? "image" : "text";
    const status = dir === "in" ? "received" : "simulated";
    sql.push(`INSERT INTO messages (id, tenant_id, conversation_id, wamid, direction, author, type, body, status, status_rank, wa_timestamp, created_at)
      VALUES (${q(`${cid}-m${i}`)}, 'tnt-demo', ${q(cid)}, ${q(`demo.${cid}.${i}`)}, ${q(dir)}, ${q(author)}, ${q(type)}, ${q(body.replace(/^\[imagen\] /, ""))}, ${q(status)}, 0, ${at}, ${at})`);
  });

  for (const [author, body] of p.notes ?? []) {
    sql.push(`INSERT INTO prospect_notes (id, tenant_id, prospect_id, author_user_id, body, created_at)
      VALUES (${q(`${id}-n${body.length}`)}, 'tnt-demo', ${q(id)}, ${user(author)}, ${q(body)}, ${lastIn + 2 * MIN})`);
  }

  // Historial: asignación, traspaso, toma de conversación y cambios de etapa.
  const audit = (action, data, at, actor = "system") =>
    sql.push(`INSERT INTO audit_log (id, tenant_id, actor, entity, entity_id, action, data, created_at)
      VALUES (${q(`demo-a-${id}-${action}`)}, 'tnt-demo', ${actor.startsWith("(") ? `'user:' || ${actor}` : q(actor)}, 'prospect', ${q(id)}, ${q(action)}, ${q(JSON.stringify(data))}, ${at})`);
  if (p.seller) audit("assigned", { from: null, to: "demo", reason: "Reparto en turno" }, created + MIN);
  if (handoffAt) audit("handoff", { reason, detail: p.notify?.body ?? "" }, handoffAt, "ai");
  if (p.stage !== "new" && p.stage !== "ready_to_buy") {
    audit("stage_change", { from: "new", to: p.stage, ...(p.lost ? { reason: p.lost } : {}) }, lastIn + 3 * MIN, p.seller ? user(p.seller) : "system");
  }
  if (p.taken) {
    sql.push(`INSERT INTO audit_log (id, tenant_id, actor, entity, entity_id, action, data, created_at)
      VALUES (${q(`demo-a-${cid}-taken`)}, 'tnt-demo', 'user:' || ${user(p.taken)}, 'conversation', ${q(cid)}, 'taken_over', NULL, ${NOW - 365 * MIN})`);
  }

  if (p.notify) {
    sql.push(`INSERT INTO notifications (id, tenant_id, user_id, prospect_id, kind, title, body, created_at)
      VALUES (${q(`demo-nt-${p.n}`)}, 'tnt-demo', ${user(p.seller)}, ${q(id)}, 'handoff', ${q(p.notify.title)}, ${q(p.notify.body)}, ${handoffAt ?? lastIn})`);
  }
}

// ── Agenda: horario de los vendedores y citas ───────────────────────────────────
// Hora del centro de México (UTC-6 todo el año desde 2022).
const todayMx = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Mexico_City" }).format(new Date(NOW));
const atMx = (dayOffset, hour, minute = 0) => {
  const [y, m, d] = todayMx.split("-").map(Number);
  return Date.UTC(y, m - 1, d + dayOffset, hour + 6, minute);
};
// [vendedor, días (0 = domingo), desde, hasta] en minutos
const SCHEDULES = [
  [MIGUEL, [1, 2, 3, 4, 5], 9 * 60, 18 * 60],
  [MIGUEL, [6], 9 * 60, 14 * 60],
  [ANA, [2, 3, 4, 5, 6], 10 * 60, 19 * 60],
  [ANA, [0], 10 * 60, 14 * 60],
];
for (const [email, days, start, end] of SCHEDULES) {
  for (const day of days) {
    sql.push(`INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute)
      VALUES (${q(`demo-av-${email.split("@")[0]}-${day}-${start}`)}, 'tnt-demo', ${user(email)}, ${day}, ${start}, ${end})`);
  }
}
// [prospecto, vendedor, día relativo, hora, estado, origen]
const APPOINTMENTS = [
  [3, MIGUEL, 1, 10, "scheduled", "ai"],
  [4, ANA, 1, 11, "scheduled", "user"],
  [7, ANA, 3, 17, "scheduled", "ai"],
  [5, MIGUEL, -2, 12, "completed", "ai"],
  [6, MIGUEL, -4, 16, "completed", "user"],
];
for (const [n, email, day, hour, status, source] of APPOINTMENTS) {
  const pid = `demo-p-${String(n).padStart(2, "0")}`;
  const start = atMx(day, hour);
  sql.push(`INSERT INTO appointments (id, tenant_id, prospect_id, user_id, development_id, starts_at, ends_at, status, source, created_at, updated_at)
    VALUES (${q(`demo-ap-${n}`)}, 'tnt-demo', ${q(pid)}, ${user(email)}, (SELECT id FROM developments WHERE tenant_id = 'tnt-demo' ORDER BY name LIMIT 1),
    ${start}, ${start + H}, ${q(status)}, ${q(source)}, ${NOW - 2 * 24 * H}, ${NOW - 2 * 24 * H})`);
}

// ── Base de conocimiento: textos de EJEMPLO (la desarrolladora debe reemplazarlos por los suyos) ──────
// [categoría, título, texto, palabras clave, aprobado]
const KB = [
  ["desarrollo", "¿Qué servicios tiene el terreno?",
    "Todos los lotes de Residencial Los Almendros se entregan con toma de agua potable, conexión a la red eléctrica (CFE), drenaje y calles pavimentadas con alumbrado público. El internet lo contrata cada propietario con el proveedor de su preferencia.",
    "agua, luz, electricidad, CFE, drenaje, internet, calles, pavimento, alumbrado", true],
  ["desarrollo", "¿El fraccionamiento tiene seguridad y amenidades?",
    "Cuenta con acceso controlado con caseta, barda perimetral, parque central, área de juegos y ciclovía. Las amenidades se entregan conforme al avance de obra; un asesor te confirma el calendario.",
    "seguridad, vigilancia, caseta, acceso, barda, amenidades, parque, juegos, ciclovía", true],
  ["pagos", "¿Qué formas de pago aceptan?",
    "Los pagos se hacen únicamente por transferencia o depósito a las cuentas a nombre de Desarrolladora Demo; nunca a cuentas personales. No se reciben pagos en efectivo. Para tu seguridad, confirma siempre los datos bancarios con tu asesor.",
    "efectivo, tarjeta, transferencia, depósito, cuenta, banco, datos bancarios", true],
  ["compra", "¿Cómo es el proceso de compra?",
    "1) Eliges tu lote y tu plan de pago con un asesor. 2) Apartas el lote con el monto que indica tu plan. 3) Firmas tu contrato de compraventa. 4) Pagas tu enganche y tus mensualidades según el plan. Un asesor te acompaña en cada paso.",
    "proceso, pasos, comprar, contrato, firma, enganche", true],
  ["compra", "¿Qué documentos necesito para comprar?",
    "Identificación oficial vigente, comprobante de domicilio reciente y tu constancia de situación fiscal (RFC). Tu asesor te los pedirá en persona o por un medio seguro; por favor no los envíes por este chat.",
    "documentos, requisitos, INE, identificación, RFC, comprobante de domicilio", true],
  ["construccion", "¿Cuándo puedo empezar a construir?",
    "Puedes construir a partir de la entrega física de tu lote, respetando el reglamento de construcción del desarrollo (alturas, restricciones y fachadas). El reglamento completo te lo comparte tu asesor.",
    "construir, construcción, obra, casa, reglamento, permisos, fachada", true],
  ["oficina", "¿Dónde está y en qué horario atiende la oficina de ventas?",
    "Nuestra oficina de ventas está en la caseta de acceso de Residencial Los Almendros, en Mérida, Yucatán. Atendemos de lunes a viernes de 9:00 a 18:00 y sábados de 9:00 a 14:00. Para recorrer el desarrollo con un asesor, agenda tu visita.",
    "oficina, horario, dirección, ubicación, caseta, atienden, abren", true],
  ["general", "¿Se permiten mascotas?",
    "Sí, con reglas de convivencia: las mascotas deben ir con correa en áreas comunes y sus dueños recoger sus desechos.",
    "mascotas, perro, gato", false],
];
KB.forEach(([category, title, body, keywords, approved], i) => {
  sql.push(`INSERT INTO kb_articles (id, tenant_id, title, body, keywords, category, status, approved_by_user_id, approved_at, created_at, updated_at)
    VALUES (${q(`demo-kb-${i + 1}`)}, 'tnt-demo', ${q(title)}, ${q(body)}, ${q(keywords)}, ${q(category)}, ${q(approved ? "approved" : "draft")},
    ${approved ? user(LAURA) : "NULL"}, ${approved ? NOW - 24 * H : "NULL"}, ${NOW - 2 * 24 * H}, ${NOW - 24 * H})`);
});

// Turno del reparto coherente con los datos (el siguiente en recibir será quien menos tiene recientes).
sql.push(`UPDATE users SET last_assigned_at = ${NOW - 30 * MIN} WHERE email = ${q(MIGUEL)}`);
sql.push(`UPDATE users SET last_assigned_at = ${NOW - 45 * MIN} WHERE email = ${q(ANA)}`);

const apiDir = path.resolve(import.meta.dirname, "..");
const remote = a.target !== "local";
const env = { ...process.env };
if (remote && !env.CLOUDFLARE_API_TOKEN && !env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = path.join(homedir(), ".wrangler-cuentas/ignia");
const dir = mkdtempSync(path.join(tmpdir(), "lynna-demo-crm-"));
try {
  const file = path.join(dir, "demo-crm.sql");
  writeFileSync(file, sql.join(";\n") + ";\n");
  const args = ["exec", "wrangler", "d1", "execute", "DB", ...(remote ? ["--env", a.target, "--remote"] : ["--local"]), "--file", file];
  if (!remote && a["persist-to"]) args.push("--persist-to", a["persist-to"]);
  const res = spawnSync("pnpm", args, { cwd: apiDir, env, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`✘ wrangler falló:\n${res.stderr || res.stdout}`);
    process.exit(1);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`✔ CRM de demo cargado en ${a.target}: ${P.length} prospectos (todas las etapas), conversaciones, notas, historial, avisos, horarios, citas y base de conocimiento.`);
