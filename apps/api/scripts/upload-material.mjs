#!/usr/bin/env node
// Sube el material comercial de un desarrollo (fotos, plano) y el logo de la desarrolladora.
//
//   pnpm --filter @lynna/api material:upload --tenant demo --development sendero-321 --dir seed/media/sendero-321 --target dev
//
// Lee <dir>/material.json: { "logo": "logo.png", "items": [{ "file": "acceso.jpg", "kind": "photo", "caption": "…" }] }
// Las fotos y planos se suben por la API (/api/admin/…/media) con ADMIN_API_TOKEN de .dev.vars.<target>;
// el logo va directo a R2 con wrangler y se guarda en tenants.logo_r2_key. Antes borra el material
// anterior del desarrollo (no las cotizaciones) para que quede exactamente lo de material.json.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: a } = parseArgs({
  options: { tenant: { type: "string" }, development: { type: "string" }, dir: { type: "string" }, target: { type: "string", default: "dev" } },
});
const fail = (m) => {
  console.error(`✘ ${m}`);
  process.exit(1);
};
const URLS = { dev: "https://devlynna.igniastudio.mx", stg: "https://stglynna.igniastudio.mx", prod: "https://lynna.igniastudio.mx" };
const BUCKETS = { dev: "lynna-media-dev", stg: "lynna-media-stg", prod: "lynna-media-prod" };
if (!a.tenant || !a.development || !a.dir) fail("--tenant, --development y --dir son obligatorios.");
if (!URLS[a.target]) fail("--target debe ser dev, stg o prod.");

const apiDir = path.resolve(import.meta.dirname, "..");
const dir = path.resolve(apiDir, a.dir);
const manifest = JSON.parse(readFileSync(path.join(dir, "material.json"), "utf8"));
const vars = readFileSync(path.join(apiDir, `.dev.vars.${a.target}`), "utf8");
const token = /^ADMIN_API_TOKEN=(.+)$/m.exec(vars)?.[1]?.trim();
if (!token) fail(`Falta ADMIN_API_TOKEN en .dev.vars.${a.target}.`);
const base = `${URLS[a.target]}/api/admin/tenants/${a.tenant}`;
const headers = { authorization: `Bearer ${token}`, origin: URLS[a.target] };
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".pdf": "application/pdf" };

const existing = await fetch(`${base}/developments/${a.development}/media`, { headers });
if (!existing.ok) fail(`No se pudo leer el material actual (${existing.status}): ${await existing.text()}`);
for (const m of await existing.json()) {
  if (m.kind === "quote") continue;
  await fetch(`${base}/media/${m.id}`, { method: "DELETE", headers });
}

for (const [i, item] of manifest.items.entries()) {
  const mime = MIME[path.extname(item.file).toLowerCase()];
  const q = new URLSearchParams({ kind: item.kind, caption: item.caption ?? "", sort: String(i * 10) });
  if (item.lotId) q.set("lotId", item.lotId);
  const res = await fetch(`${base}/developments/${a.development}/media?${q}`, {
    method: "POST",
    headers: { ...headers, "content-type": mime },
    body: readFileSync(path.join(dir, item.file)),
  });
  if (!res.ok) fail(`${item.file}: ${res.status} ${await res.text()}`);
  console.log(`✔ ${item.file} (${item.kind})`);
}

if (manifest.logo) {
  const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".wrangler-cuentas/ignia") };
  const ext = path.extname(manifest.logo).toLowerCase();
  const key = `t/branding/${a.tenant}/logo${ext}`;
  const run = (args) => {
    const r = spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: apiDir, env, encoding: "utf8" });
    if (r.status !== 0) fail(r.stderr || r.stdout);
  };
  run(["r2", "object", "put", `${BUCKETS[a.target]}/${key}`, "--file", path.join(dir, manifest.logo), "--content-type", MIME[ext], "--remote"]);
  run(["d1", "execute", "DB", "--env", a.target, "--remote", "--command", `UPDATE tenants SET logo_r2_key = '${key}' WHERE slug = '${a.tenant.replace(/'/g, "''")}'`]);
  console.log(`✔ logo → ${key}`);
}
