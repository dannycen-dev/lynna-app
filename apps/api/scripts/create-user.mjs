#!/usr/bin/env node
// Alta o actualización de un usuario del panel (no hay registro abierto).
//
//   pnpm --filter @lynna/api user:create --email ana@desarrolladora.mx --name "Ana López" --role manager --tenant demo
//   pnpm --filter @lynna/api user:create --email danny@igniastudio.mx --name "Danny" --role admin --target dev
//
// --target local (por omisión) | dev | stg | prod      --password <opcional; si falta se genera>
// --persist-to <dir>  (solo local; lo usan las pruebas E2E)
//
// Si el correo ya existe, actualiza nombre, rol, desarrolladora y contraseña, y lo reactiva.
// El formato del hash debe coincidir con src/auth/password.ts.

import { spawnSync } from "node:child_process";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const PBKDF2_ITERATIONS = 100_000;
const MIN_PASSWORD_LENGTH = 10;
const ROLES = ["admin", "owner", "manager", "seller"];
const TARGETS = ["local", "dev", "stg", "prod"];

const { values: a } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string", default: "manager" },
    tenant: { type: "string" },
    password: { type: "string" },
    target: { type: "string", default: "local" },
    "persist-to": { type: "string" },
  },
});

function fail(msg) {
  console.error(`✘ ${msg}`);
  process.exit(1);
}

const email = a.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("--email es obligatorio y debe ser válido.");
if (!a.name?.trim()) fail("--name es obligatorio.");
if (!ROLES.includes(a.role)) fail(`--role debe ser uno de: ${ROLES.join(", ")}.`);
if (a.role !== "admin" && !a.tenant) fail("--tenant (slug de la desarrolladora) es obligatorio salvo para role=admin.");
if (!TARGETS.includes(a.target)) fail(`--target debe ser uno de: ${TARGETS.join(", ")}.`);
if (a.password !== undefined && a.password.length < MIN_PASSWORD_LENGTH) fail(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);

const generated = a.password === undefined;
const password = a.password ?? randomBytes(12).toString("base64url");

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
const passwordHash = `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;

const apiDir = path.resolve(import.meta.dirname, "..");
const remote = a.target !== "local";
const env = { ...process.env };
// Igual que los scripts de deploy: sesión de wrangler de Ignia (en CI manda CLOUDFLARE_API_TOKEN).
if (remote && !env.CLOUDFLARE_API_TOKEN && !env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = path.join(homedir(), ".wrangler-cuentas/ignia");

function wrangler(args) {
  const base = ["exec", "wrangler", "d1", "execute", "DB", ...(remote ? ["--env", a.target, "--remote"] : ["--local"])];
  if (!remote && a["persist-to"]) base.push("--persist-to", a["persist-to"]);
  const res = spawnSync("pnpm", [...base, ...args], { cwd: apiDir, env, encoding: "utf8" });
  if (res.status !== 0) fail(`wrangler falló:\n${res.stderr || res.stdout}`);
  return res.stdout;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

let tenantId = null;
if (a.role !== "admin") {
  const out = wrangler(["--json", "--command", `SELECT id FROM tenants WHERE slug = ${q(a.tenant)}`]);
  const rows = JSON.parse(out.slice(out.indexOf("[")))[0]?.results ?? [];
  if (rows.length === 0) fail(`No existe la desarrolladora "${a.tenant}" en ${a.target}.`);
  tenantId = rows[0].id;
}

const now = Date.now();
const sql = `INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at)
VALUES (${q(crypto.randomUUID())}, ${tenantId ? q(tenantId) : "NULL"}, ${q(email)}, ${q(a.name.trim())}, ${q(passwordHash)}, ${q(a.role)}, 1, ${now})
ON CONFLICT(email) DO UPDATE SET
  tenant_id = excluded.tenant_id, name = excluded.name, password_hash = excluded.password_hash,
  role = excluded.role, active = 1;
DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE email = ${q(email)});`;

// Por archivo y no por --command: así la contraseña/hash no aparece en la lista de procesos.
const dir = mkdtempSync(path.join(tmpdir(), "lynna-user-"));
try {
  writeFileSync(path.join(dir, "user.sql"), sql, { mode: 0o600 });
  wrangler(["--file", path.join(dir, "user.sql")]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`✔ Usuario listo en ${a.target}: ${email} (${a.role}${a.tenant ? ` · ${a.tenant}` : ""})`);
if (generated) console.log(`  Contraseña generada (se muestra solo esta vez): ${password}`);
