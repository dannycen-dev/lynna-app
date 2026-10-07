import { aliasedTable, and, asc, eq, gte, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, canWrite, type AuthVariables } from "../auth/middleware";
import { bookAppointment, freeSlots, localParts, localToEpoch, replaceAvailability, sellersForProspect, setAppointmentStatus, slotLabel, weekRules } from "../crm/agenda";
import { isSeller, prospectScope } from "../crm/assignment";
import { getDb } from "../db/client";
import { appointments, availabilityRules, developments, prospects, tenants, timeOff, users } from "../db/schema";
import { addDays, parseIsoDate, todayIn } from "../financing/dates";
import { auditInsert } from "../lib/audit";

// Agenda de citas en el panel. Un vendedor ve y gestiona solo sus citas y su horario;
// gerente, dueño y admin ven las de todo el equipo.

type AppEnv = { Bindings: Env; Variables: AuthVariables & { tenant: typeof tenants.$inferSelect } };
export const agenda = new Hono<AppEnv>();

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const selfId = (c: { var: AuthVariables }) => (c.var.principal.kind === "user" ? c.var.principal.user.id : null);

async function readBody<T extends z.ZodType>(c: { req: { json: () => Promise<unknown> } }, schema: T) {
  return schema.safeParse(await c.req.json().catch(() => null));
}

// ── Citas ─────────────────────────────────────────────────────────────────────

const seller = aliasedTable(users, "seller");

agenda.get("/appointments", async (c) => {
  const tenant = c.var.tenant;
  const from = c.req.query("from") ?? todayIn(tenant.timezone);
  if (!ISO.test(from)) return c.json({ error: "validation", message: "from debe ser YYYY-MM-DD." }, 400);
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 7) || 7, 1), 62);
  const userId = isSeller(c.var.principal) ? selfId(c) : (c.req.query("userId") ?? null);
  const start = localToEpoch(from, 0, tenant.timezone);
  const end = localToEpoch(addDays(from, days), 0, tenant.timezone);
  const rows = await getDb(c.env.DB)
    .select({
      appointment: appointments,
      prospectName: prospects.name,
      profileName: prospects.profileName,
      prospectStage: prospects.stage,
      sellerName: seller.name,
      developmentName: developments.name,
    })
    .from(appointments)
    .innerJoin(prospects, eq(prospects.id, appointments.prospectId))
    .innerJoin(seller, eq(seller.id, appointments.userId))
    .leftJoin(developments, eq(developments.id, appointments.developmentId))
    .where(
      and(
        eq(appointments.tenantId, tenant.id),
        gte(appointments.startsAt, start),
        lt(appointments.startsAt, end),
        userId ? eq(appointments.userId, userId) : undefined,
        c.req.query("includeCancelled") === "1" ? undefined : ne(appointments.status, "cancelled"),
      ),
    )
    .orderBy(asc(appointments.startsAt))
    .limit(500);
  return c.json(
    rows.map((r) => ({
      ...r.appointment,
      prospectName: r.prospectName ?? r.profileName ?? "Sin nombre",
      prospectStage: r.prospectStage,
      sellerName: r.sellerName,
      developmentName: r.developmentName,
      label: slotLabel(r.appointment.startsAt, tenant.timezone),
      ...localParts(r.appointment.startsAt, tenant.timezone),
    })),
  );
});

agenda.get("/appointments/slots", async (c) => {
  const tenant = c.var.tenant;
  const db = getDb(c.env.DB);
  const date = c.req.query("date");
  if (date && !ISO.test(date)) return c.json({ error: "validation", message: "date debe ser YYYY-MM-DD." }, 400);
  let userIds: string[] | undefined;
  if (isSeller(c.var.principal)) userIds = [selfId(c)!];
  else if (c.req.query("userId")) userIds = [c.req.query("userId")!];
  else if (c.req.query("prospectId")) {
    const p = await db.select({ assignedUserId: prospects.assignedUserId }).from(prospects).where(and(eq(prospects.id, c.req.query("prospectId")!), eq(prospects.tenantId, tenant.id))).get();
    if (p) userIds = await sellersForProspect(db, p);
  }
  const slots = await freeSlots(db, tenant, { ...(date ? { fromDate: date } : {}), days: Number(c.req.query("days") ?? 1) || 1, ...(userIds ? { userIds } : {}) });
  return c.json(slots.map((s) => ({ ...s, label: slotLabel(s.startsAt, tenant.timezone), ...localParts(s.startsAt, tenant.timezone) })));
});

const bookBody = z.object({
  prospectId: z.string().min(1),
  startsAt: z.int().positive(),
  userId: z.string().min(1).optional(),
  notes: z.string().trim().max(1000).optional(),
});

agenda.post("/appointments", async (c) => {
  const parsed = await readBody(c, bookBody);
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const db = getDb(c.env.DB);
  const prospect = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, parsed.data.prospectId), eq(prospects.tenantId, c.var.tenant.id), prospectScope(c.var.principal)))
    .get();
  if (!prospect) return c.json({ error: "not_found" }, 404);
  // Un vendedor solo agenda en su propia agenda.
  const userId = isSeller(c.var.principal) ? selfId(c) : (parsed.data.userId ?? null);
  const result = await bookAppointment(db, {
    tenant: c.var.tenant,
    prospectId: prospect.id,
    startsAt: parsed.data.startsAt,
    userId,
    notes: parsed.data.notes ?? null,
    source: "user",
    actor: actorOf(c.var.principal),
  });
  if (!result.ok) {
    const message = result.error === "taken" ? "Alguien acaba de tomar ese horario. Elige otro." : "Ese horario ya no está disponible.";
    return c.json({ error: result.error, message }, 409);
  }
  return c.json({ ...result.appointment, sellerName: result.userName, replaced: result.replaced }, 201);
});

agenda.patch("/appointments/:id", async (c) => {
  const parsed = await readBody(c, z.object({ status: z.enum(["completed", "no_show", "cancelled"]), reason: z.string().trim().max(300).optional() }));
  if (!parsed.success) return c.json({ error: "validation" }, 400);
  const db = getDb(c.env.DB);
  const current = await db.select().from(appointments).where(and(eq(appointments.id, c.req.param("id")), eq(appointments.tenantId, c.var.tenant.id))).get();
  if (!current || (isSeller(c.var.principal) && current.userId !== selfId(c))) return c.json({ error: "not_found" }, 404);
  if (parsed.data.status !== "cancelled" && current.startsAt > Date.now()) {
    return c.json({ error: "validation", message: "Solo se puede marcar asistencia de una cita que ya empezó." }, 400);
  }
  const updated = await setAppointmentStatus(db, {
    tenantId: c.var.tenant.id,
    appointmentId: current.id,
    status: parsed.data.status,
    reason: parsed.data.reason ?? null,
    actor: actorOf(c.var.principal),
  });
  return c.json(updated);
});

// ── Horarios de los vendedores ─────────────────────────────────────────────────

agenda.get("/availability", async (c) => {
  const db = getDb(c.env.DB);
  const tenantId = c.var.tenant.id;
  const onlyMe = isSeller(c.var.principal) ? selfId(c) : null;
  const members = await db
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.active, true), inArray(users.role, ["seller", "manager", "owner"]), onlyMe ? eq(users.id, onlyMe) : undefined))
    .orderBy(asc(users.name));
  const rules = await db
    .select()
    .from(availabilityRules)
    .where(and(eq(availabilityRules.tenantId, tenantId), onlyMe ? eq(availabilityRules.userId, onlyMe) : undefined))
    .orderBy(asc(availabilityRules.weekday), asc(availabilityRules.startMinute));
  return c.json({
    timezone: c.var.tenant.timezone,
    appointmentMinutes: c.var.tenant.appointmentMinutes,
    members: members.map((m) => ({
      ...m,
      rules: rules.filter((r) => r.userId === m.id).map((r) => ({ weekday: r.weekday, startMinute: r.startMinute, endMinute: r.endMinute })),
    })),
  });
});

const rule = z
  .object({ weekday: z.int().min(0).max(6), startMinute: z.int().min(0).max(24 * 60), endMinute: z.int().min(0).max(24 * 60) })
  .refine((r) => r.endMinute > r.startMinute, { message: "La hora de fin debe ser mayor que la de inicio." });

agenda.put("/availability/:userId", async (c) => {
  const userId = c.req.param("userId");
  // Cada vendedor puede ajustar su propio horario; el de otros, solo gerente o dueño.
  if (isSeller(c.var.principal) && userId !== selfId(c)) return c.json({ error: "forbidden", message: "Solo puedes cambiar tu propio horario." }, 403);
  const parsed = await readBody(c, z.object({ rules: weekRules(rule) }));
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const db = getDb(c.env.DB);
  const member = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.tenantId, c.var.tenant.id))).get();
  if (!member) return c.json({ error: "not_found" }, 404);
  await replaceAvailability(db, { tenantId: c.var.tenant.id, userId, rules: parsed.data.rules, actor: actorOf(c.var.principal) });
  return c.json({ userId, rules: parsed.data.rules });
});

// ── Días libres (vacaciones, permisos, días festivos) ─────────────────────────

agenda.get("/time-off", async (c) => {
  const tenant = c.var.tenant;
  const me = isSeller(c.var.principal) ? selfId(c) : null;
  const rows = await getDb(c.env.DB)
    .select({ timeOff, userName: users.name })
    .from(timeOff)
    .leftJoin(users, eq(users.id, timeOff.userId))
    .where(and(eq(timeOff.tenantId, tenant.id), gte(timeOff.endDate, todayIn(tenant.timezone)), me ? or(isNull(timeOff.userId), eq(timeOff.userId, me)) : undefined))
    .orderBy(asc(timeOff.startDate));
  return c.json(rows.map((r) => ({ ...r.timeOff, userName: r.userName })));
});

const isoDate = z.string().refine((v) => {
  try {
    parseIsoDate(v);
    return true;
  } catch {
    return false;
  }
}, "Fecha inválida.");

agenda.post("/time-off", async (c) => {
  const tenant = c.var.tenant;
  const parsed = await readBody(
    c,
    z
      .object({ userId: z.string().nullable(), startDate: isoDate, endDate: isoDate, reason: z.string().trim().max(120).optional() })
      .refine((v) => v.endDate >= v.startDate, { message: "La fecha final no puede ser antes de la inicial.", path: ["endDate"] })
      // `when`: solo con fechas válidas (addDays lanza con "2026-02-30").
      .refine((v) => v.endDate <= addDays(v.startDate, 365), { message: "Máximo un año.", path: ["endDate"], when: (p) => p.issues.length === 0 }),
  );
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const { userId, startDate, endDate, reason } = parsed.data;
  // Un vendedor registra solo sus propios días; cerrar la oficina o dar días a otros es de gerente o dueño.
  if (isSeller(c.var.principal) && userId !== selfId(c)) return c.json({ error: "forbidden", message: "Solo puedes registrar tus propios días libres." }, 403);
  const db = getDb(c.env.DB);
  if (userId) {
    const member = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.tenantId, tenant.id))).get();
    if (!member) return c.json({ error: "not_found" }, 404);
  }
  const actor = actorOf(c.var.principal);
  const [inserted] = await db.batch([
    db.insert(timeOff).values({ tenantId: tenant.id, userId, startDate, endDate, reason: reason || null, createdBy: actor }).returning(),
    auditInsert(db, { tenantId: tenant.id, actor, entity: userId ? "user" : "tenant", entityId: userId ?? tenant.id, action: "time_off_added", data: { startDate, endDate, reason } }),
  ]);
  // Las citas ya agendadas en esos días NO se cancelan solas: se devuelven para que alguien las mueva.
  const conflicts = await db
    .select({ id: appointments.id, startsAt: appointments.startsAt, prospectName: prospects.name, prospectPhone: prospects.phone, userName: seller.name })
    .from(appointments)
    .innerJoin(prospects, eq(prospects.id, appointments.prospectId))
    .innerJoin(seller, eq(seller.id, appointments.userId))
    .where(
      and(
        eq(appointments.tenantId, tenant.id),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, localToEpoch(startDate, 0, tenant.timezone)),
        lt(appointments.startsAt, localToEpoch(addDays(endDate, 1), 0, tenant.timezone)),
        userId ? eq(appointments.userId, userId) : undefined,
      ),
    )
    .orderBy(asc(appointments.startsAt));
  return c.json({ timeOff: inserted[0], conflicts: conflicts.map((a) => ({ ...a, label: slotLabel(a.startsAt, tenant.timezone) })) }, 201);
});

agenda.delete("/time-off/:id", async (c) => {
  const db = getDb(c.env.DB);
  const row = await db.select().from(timeOff).where(and(eq(timeOff.id, c.req.param("id")), eq(timeOff.tenantId, c.var.tenant.id))).get();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (isSeller(c.var.principal) && row.userId !== selfId(c)) return c.json({ error: "forbidden", message: "Solo puedes quitar tus propios días libres." }, 403);
  await db.batch([
    db.delete(timeOff).where(eq(timeOff.id, row.id)),
    auditInsert(db, { tenantId: row.tenantId, actor: actorOf(c.var.principal), entity: row.userId ? "user" : "tenant", entityId: row.userId ?? row.tenantId, action: "time_off_removed", data: { startDate: row.startDate, endDate: row.endDate } }),
  ]);
  return c.body(null, 204);
});

agenda.patch("/settings/appointments", async (c) => {
  if (!canWrite(c.var.principal)) return c.json({ error: "forbidden", message: "Solo un gerente o dueño puede cambiar esto." }, 403);
  const parsed = await readBody(c, z.object({ appointmentMinutes: z.int().min(15).max(240).multipleOf(15) }));
  if (!parsed.success) return c.json({ error: "validation", issues: z.flattenError(parsed.error).fieldErrors }, 400);
  const db = getDb(c.env.DB);
  const [updated] = await db.batch([
    db.update(tenants).set(parsed.data).where(eq(tenants.id, c.var.tenant.id)).returning({ appointmentMinutes: tenants.appointmentMinutes, timezone: tenants.timezone }),
    auditInsert(db, { tenantId: c.var.tenant.id, actor: actorOf(c.var.principal), entity: "tenant", entityId: c.var.tenant.id, action: "appointment_settings", data: parsed.data }),
  ]);
  return c.json(updated[0]);
});
