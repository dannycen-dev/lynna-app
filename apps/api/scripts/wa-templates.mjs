#!/usr/bin/env node
// Crea (o muestra el estado de) las plantillas de seguimiento de Lynna en la cuenta de WhatsApp (WABA).
// Fuera de la ventana de 24 h WhatsApp solo permite plantillas aprobadas; las de seguimiento son MARKETING
// y llevan botón para darse de baja. El texto debe coincidir con FOLLOWUP_TEMPLATES (src/crm/followups.ts).
//
//   pnpm --filter @lynna/api wa:templates --waba-id 1885748865433904 --target dev
//
// El token sale de .dev.vars.<target> (WHATSAPP_ACCESS_TOKEN) y nunca se imprime.

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({ options: { "waba-id": { type: "string" }, target: { type: "string", default: "dev" }, "graph-version": { type: "string", default: "v23.0" } } });
const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
if (!/^\d+$/.test(a["waba-id"] ?? "")) fail("--waba-id es obligatorio (solo dígitos).");

const vars = readFileSync(path.resolve(import.meta.dirname, "..", `.dev.vars.${a.target}`), "utf8");
const token = /^WHATSAPP_ACCESS_TOKEN=(.+)$/m.exec(vars)?.[1]?.trim();
if (!token || token === "PENDIENTE") fail(`No hay WHATSAPP_ACCESS_TOKEN en .dev.vars.${a.target}.`);

const FOOTER = "Responde BAJA para no recibir más mensajes";
const TEMPLATES = [
  {
    name: "lynna_seguimiento_1",
    text: "Hola {{1}}, seguimos teniendo lotes disponibles en {{2}}. ¿Te gustaría ver fotos o agendar una visita sin compromiso?",
    example: ["Ana", "Residencial Los Almendros"],
    buttons: ["Sí, me interesa", "Ya no, gracias"],
  },
  {
    name: "lynna_seguimiento_2",
    text: "Hola {{1}}, este es nuestro último mensaje sobre {{2}}. Si más adelante quieres información, escríbenos y con gusto te atendemos.",
    example: ["Ana", "Residencial Los Almendros"],
    buttons: ["Quiero información", "Ya no, gracias"],
  },
];

const G = `https://graph.facebook.com/${a["graph-version"]}`;
const api = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await res.json();
  return { ok: res.ok, body };
};

const existing = await api(`${G}/${a["waba-id"]}/message_templates?fields=name,status,category,language&limit=200`);
if (!existing.ok) fail(`No se pudieron leer las plantillas: ${JSON.stringify(existing.body.error ?? existing.body)}`);
const byName = new Map(existing.body.data.filter((t) => t.language === "es_MX").map((t) => [t.name, t]));

for (const t of TEMPLATES) {
  const found = byName.get(t.name);
  if (found) {
    console.log(`• ${t.name}: ya existe (${found.status}, ${found.category})`);
    continue;
  }
  const res = await api(`${G}/${a["waba-id"]}/message_templates`, {
    method: "POST",
    body: JSON.stringify({
      name: t.name,
      language: "es_MX",
      category: "MARKETING",
      components: [
        { type: "BODY", text: t.text, example: { body_text: [t.example] } },
        { type: "FOOTER", text: FOOTER },
        { type: "BUTTONS", buttons: t.buttons.map((text) => ({ type: "QUICK_REPLY", text })) },
      ],
    }),
  });
  if (!res.ok) console.log(`✘ ${t.name}: ${res.body.error?.error_user_msg ?? res.body.error?.message ?? JSON.stringify(res.body)}`);
  else console.log(`✔ ${t.name}: creada (${res.body.status ?? "PENDING"}, ${res.body.category ?? "MARKETING"})`);
}
