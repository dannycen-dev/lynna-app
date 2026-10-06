#!/usr/bin/env node
// Simula un mensaje entrante de WhatsApp firmado como lo hace Meta, contra `wrangler dev`.
//
//   pnpm simulate "Hola, ¿qué lotes tienen?"
//   pnpm simulate "Quiero comprar" --from 5219990001111 --url http://localhost:8787
//
// Usa WHATSAPP_APP_SECRET de .dev.vars (o la variable de entorno) y el phone_number_id del seed.

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string", default: "5219991234567" },
    name: { type: "string", default: "Prospecto Demo" },
    url: { type: "string", default: "http://localhost:8787" },
    "phone-number-id": { type: "string", default: "DEMO_PHONE_NUMBER_ID" },
  },
});

function readDevVar(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

const secret = readDevVar("WHATSAPP_APP_SECRET");
if (!secret) {
  console.error("Falta WHATSAPP_APP_SECRET en .dev.vars (o en el entorno).");
  process.exit(1);
}

const text = positionals.join(" ") || "Hola, me interesa un terreno";
const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "SIMULATED_WABA",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "520000000000", phone_number_id: values["phone-number-id"] },
            contacts: [{ profile: { name: values.name }, wa_id: values.from }],
            messages: [
              {
                from: values.from,
                id: `wamid.SIM.${randomUUID()}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const res = await fetch(`${values.url}/whatsapp/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
  body,
});
console.log(`${res.status} ${await res.text()}`);
