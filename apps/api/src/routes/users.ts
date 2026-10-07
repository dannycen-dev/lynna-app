import { and, asc, eq, ne, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, type AuthVariables, type Principal } from "../auth/middleware";
import { hashPassword } from "../auth/password";
import { revokeUserSessions } from "../auth/session";
import { getDb, type Db } from "../db/client";
import { prospects, tenants, users, type UserRole } from "../db/schema";
import { auditInsert } from "../lib/audit";

// Usuarios de la desarrolladora desde el panel. Quién administra a quién:
// - admin (Ignia) y owner: dueños, gerentes y vendedores;
// - manager: solo vendedores;
// - seller: nadie.
// Nadie se desactiva ni se cambia el rol a sí mismo, y siempre queda al menos un dueño activo.

type AppEnv = { Bindings: Env; Variables: AuthVariables & { tenant: typeof tenants.$inferSelect } };
export const userAdmin = new Hono<AppEnv>();

type TenantRole = Exclude<UserRole, "admin">;
const TENANT_ROLES = ["owner", "manager", "seller"] as const;

function manageableRoles(p: Principal): TenantRole[] {
  if (p.kind === "token" || p.user.role === "admin" || p.user.role === "owner") return [...TENANT_ROLES];
  if (p.user.role === "manager") return ["seller"];
  return [];
}
const selfId = (p: Principal) => (p.kind === "user" ? p.user.id : null);

/** Contraseña temporal legible (sin 0/O/l/1 para dictarla sin errores). */
function temporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function readBody<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) {
  return schema.safeParse(await c.req.json().catch(() => null));
}

const publicUser = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  active: users.active,
  receivesLeads: users.receivesLeads,
  mustChangePassword: users.mustChangePassword,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
};

async function activeOwners(db: Db, tenantId: string, excludeId?: string) {
  return db.$count(users, and(eq(users.tenantId, tenantId), eq(users.role, "owner"), eq(users.active, true), excludeId ? ne(users.id, excludeId) : undefined));
}

userAdmin.get("/users", async (c) => {
  if (manageableRoles(c.var.principal).length === 0) return c.json({ error: "forbidden", message: "No puedes administrar usuarios." }, 403);
  const rows = await getDb(c.env.DB).select(publicUser).from(users).where(eq(users.tenantId, c.var.tenant.id)).orderBy(asc(users.name));
  return c.json({ users: rows, manageableRoles: manageableRoles(c.var.principal), me: selfId(c.var.principal) });
});

userAdmin.post("/users", async (c) => {
  const allowed = manageableRoles(c.var.principal);
  const parsed = await readBody(
    c,
    z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().toLowerCase().pipe(z.email()), role: z.enum(TENANT_ROLES) }),
  );
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  if (!allowed.includes(parsed.data.role)) return c.json({ error: "forbidden", message: "No puedes dar de alta usuarios con ese rol." }, 403);
  const db = getDb(c.env.DB);
  if (await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.email)).get()) {
    return c.json({ error: "duplicate", message: "Ya existe un usuario con ese correo." }, 409);
  }
  const password = temporaryPassword();
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(users).values({ id, tenantId: c.var.tenant.id, ...parsed.data, passwordHash: await hashPassword(password), mustChangePassword: true, createdAt: Date.now() }),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "user", entityId: id, action: "user_created", data: { email: parsed.data.email, role: parsed.data.role } }),
  ]);
  const created = await db.select(publicUser).from(users).where(eq(users.id, id)).get();
  // La contraseña temporal se devuelve UNA vez; en la base solo queda su hash.
  return c.json({ user: created, temporaryPassword: password }, 201);
});

async function loadTarget(c: { env: Env; var: AppEnv["Variables"] }, id: string) {
  const target = await getDb(c.env.DB).select().from(users).where(and(eq(users.id, id), eq(users.tenantId, c.var.tenant.id))).get();
  if (!target) return { error: "not_found" as const };
  if (target.role === "admin" || !manageableRoles(c.var.principal).includes(target.role)) return { error: "forbidden" as const };
  return { target };
}

userAdmin.patch("/users/:id", async (c) => {
  const parsed = await readBody(c, z.object({ name: z.string().trim().min(2).max(120).optional(), role: z.enum(TENANT_ROLES).optional(), active: z.boolean().optional() }));
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const found = await loadTarget(c, c.req.param("id"));
  if (found.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (found.error) return c.json({ error: "forbidden", message: "No puedes administrar a este usuario." }, 403);
  const { target } = found;
  const data = parsed.data;
  const isSelf = target.id === selfId(c.var.principal);
  if (isSelf && (data.role !== undefined || data.active === false)) {
    return c.json({ error: "forbidden", message: "No puedes cambiar tu propio rol ni desactivarte." }, 403);
  }
  if (data.role && !manageableRoles(c.var.principal).includes(data.role)) return c.json({ error: "forbidden", message: "No puedes asignar ese rol." }, 403);
  const db = getDb(c.env.DB);
  const losesOwner = target.role === "owner" && target.active && (data.active === false || (data.role && data.role !== "owner"));
  if (losesOwner && (await activeOwners(db, c.var.tenant.id, target.id)) === 0) {
    return c.json({ error: "last_owner", message: "Debe quedar al menos un dueño activo." }, 409);
  }
  const [updated] = await db.batch([
    db.update(users).set(data).where(eq(users.id, target.id)).returning(publicUser),
    auditInsert(db, {
      tenantId: c.var.tenant.id,
      actor: actorOf(c.var.principal),
      entity: "user",
      entityId: target.id,
      action: data.active === false ? "user_deactivated" : data.active === true && !target.active ? "user_reactivated" : "user_updated",
      data,
    }),
  ]);
  let openProspects = 0;
  if (data.active === false) {
    await revokeUserSessions(null, db, target.id);
    // Sus prospectos abiertos se quedan con él: el panel avisa para reasignarlos.
    openProspects = await db.$count(
      prospects,
      and(eq(prospects.tenantId, c.var.tenant.id), eq(prospects.assignedUserId, target.id), notInArray(prospects.stage, ["won", "lost"])),
    );
  }
  return c.json({ user: updated[0], openProspects });
});

userAdmin.post("/users/:id/reset-password", async (c) => {
  const found = await loadTarget(c, c.req.param("id"));
  if (found.error === "not_found") return c.json({ error: "not_found" }, 404);
  if (found.error) return c.json({ error: "forbidden", message: "No puedes administrar a este usuario." }, 403);
  if (found.target.id === selfId(c.var.principal)) return c.json({ error: "forbidden", message: "Para tu propia contraseña usa \"Cambiar mi contraseña\"." }, 403);
  const db = getDb(c.env.DB);
  const password = temporaryPassword();
  await db.batch([
    db.update(users).set({ passwordHash: await hashPassword(password), mustChangePassword: true }).where(eq(users.id, found.target.id)),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "user", entityId: found.target.id, action: "password_reset" }),
  ]);
  await revokeUserSessions(null, db, found.target.id);
  return c.json({ temporaryPassword: password });
});

