import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { validateReply, extractTimes } from "../src/agent/guard";
import { newFacts, rememberSlot, runTool } from "../src/agent/tools";
import { hashPassword } from "../src/auth/password";
import { bookAppointment, freeSlots, localToEpoch, remindSellers, slotLabel, weekdayOf } from "../src/crm/agenda";
import { getDb } from "../src/db/client";
import { advisorEta } from "../src/crm/business-hours";
import { addDays, todayIn } from "../src/financing/dates";

const ORIGIN = "https://lynna.test";
const T = `${ORIGIN}/api/admin/tenants/demo`;
const PASSWORD = "Contraseña-Agenda-2026";
const TZ = "America/Mexico_City";
const TENANT = { id: "tnt-demo", timezone: TZ, appointmentMinutes: 60 };

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function createUser(id: string, email: string, role: string, name: string) {
  await env.DB.prepare("INSERT INTO users (id, tenant_id, email, name, password_hash, role, active, created_at) VALUES (?, 'tnt-demo', ?, ?, ?, ?, 1, 0)")
    .bind(id, email, name, await hashPassword(PASSWORD), role)
    .run();
}

async function createProspect(id: string, assignedUserId: string | null = null) {
  await env.DB.prepare("INSERT INTO prospects (id, tenant_id, phone, name, stage, score, source, assigned_user_id, created_at, updated_at) VALUES (?, 'tnt-demo', ?, ?, 'qualified', 40, 'whatsapp', ?, 0, 0)")
    .bind(id, `52199900${id.slice(-4)}`, `Prospecto ${id}`, assignedUserId)
    .run();
}

async function login(email: string) {
  const res = await exports.default.fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  const call = (path: string, method = "GET", body?: unknown) =>
    exports.default.fetch(`${T}${path}`, {
      method,
      headers: { cookie, ...(method !== "GET" ? { origin: ORIGIN, "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { call, json: async (path: string, method = "GET", body?: unknown) => (await call(path, method, body)).json() as Promise<any> };
}

/** Lunes a domingo de 8:00 a 20:00: siempre hay horarios mañana, sin importar a qué hora corra la prueba. */
const EVERY_DAY = Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 8 * 60, endMinute: 20 * 60 }));
const tomorrow = () => addDays(todayIn(TZ), 1);

beforeEach(async () => {
  await env.DB.batch(
    [
      "appointments",
      "availability_rules",
      "time_off",
      "notification_reads",
      "notifications",
      "prospect_notes",
      "sessions",
      "login_attempts",
      "ai_audit_log",
      "audit_log",
      "messages",
      "conversations",
      "prospects",
      "users",
      "lot_media",
    ].map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
  );
  await env.DB.batch(statements(env.TEST_SEED_SQL).map((s) => env.DB.prepare(s)));
  await env.DB.prepare("UPDATE tenants SET appointment_minutes = 60, timezone = ? WHERE id = 'tnt-demo'").bind(TZ).run();
  await createUser("u-laura", "laura@demo.mx", "manager", "Laura González");
  await createUser("u-miguel", "miguel@demo.mx", "seller", "Miguel Torres");
  await createUser("u-ana", "ana@demo.mx", "seller", "Ana Ruiz");
});

describe("agenda: fechas y horarios", () => {
  it("convierte hora local de México a UTC y etiqueta en español", () => {
    // México centro no tiene horario de verano desde 2022: UTC-6 todo el año.
    expect(localToEpoch("2026-10-08", 10 * 60, TZ)).toBe(Date.UTC(2026, 9, 8, 16, 0));
    expect(localToEpoch("2026-01-15", 0, TZ)).toBe(Date.UTC(2026, 0, 15, 6, 0));
    expect(weekdayOf("2026-10-08")).toBe(4); // jueves
    expect(slotLabel(Date.UTC(2026, 9, 8, 16, 0), TZ)).toBe("jueves 8 de octubre, 10:00");
  });

  it("parte el horario en bloques de la duración de la cita y descarta los ocupados", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute) VALUES ('r1', 'tnt-demo', 'u-miguel', ?, 600, 780)")
      .bind(weekdayOf(tomorrow()))
      .run();
    const slots = await freeSlots(db, TENANT, { fromDate: tomorrow(), days: 1 });
    expect(slots.map((s) => slotLabel(s.startsAt, TZ).split(", ")[1])).toEqual(["10:00", "11:00", "12:00"]);

    await createProspect("p-0001", "u-miguel");
    const booked = await bookAppointment(db, { tenant: TENANT, prospectId: "p-0001", startsAt: slots[1]!.startsAt, source: "user", actor: "test" });
    expect(booked.ok).toBe(true);
    const after = await freeSlots(db, TENANT, { fromDate: tomorrow(), days: 1 });
    expect(after.map((s) => slotLabel(s.startsAt, TZ).split(", ")[1])).toEqual(["10:00", "12:00"]);
  });
});

describe("agenda: con quién se agenda", () => {
  it("con su vendedor si tiene horario; si el asignado no recibe visitas, con quien esté libre", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute) VALUES ('r1', 'tnt-demo', 'u-ana', ?, 600, 660)")
      .bind(weekdayOf(tomorrow()))
      .run();
    // Asignado a la gerente (sin horario): se agenda con Ana, y el prospecto sigue siendo de la gerente.
    await createProspect("p-0001", "u-laura");
    const startsAt = localToEpoch(tomorrow(), 600, TZ);
    const booked = await bookAppointment(db, { tenant: TENANT, prospectId: "p-0001", startsAt, source: "ai", actor: "ai" });
    expect(booked).toMatchObject({ ok: true, userName: "Ana Ruiz" });
    // Asignado a Miguel, que tampoco tiene horario: lo mismo, pero el horario de Ana ya está ocupado.
    await createProspect("p-0002", "u-miguel");
    expect(await bookAppointment(db, { tenant: TENANT, prospectId: "p-0002", startsAt, source: "ai", actor: "ai" })).toMatchObject({ ok: false, error: "not_available" });
  });
});

describe("agenda: herramientas de la IA", () => {
  it("con fecha devuelve todo el día (la hora que pida el prospecto queda verificada)", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute) VALUES ('r1', 'tnt-demo', 'u-miguel', ?, 540, 1080)")
      .bind(weekdayOf(tomorrow()))
      .run();
    await createProspect("p-0001", "u-miguel");
    const facts = newFacts();
    const ctx = { db, tenantId: "tnt-demo", prospectId: "p-0001", conversationId: "c-1", facts, escalation: null };
    const res = JSON.parse(await runTool(ctx, "horarios_disponibles", { fecha: tomorrow() }));
    expect(res.horarios.map((h: { hora: string }) => h.hora)).toEqual(["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]);
    expect(facts.times.has("16:00")).toBe(true);
    const booked = JSON.parse(await runTool(ctx, "agendar_visita", { fecha: tomorrow(), hora: "16:00" }));
    expect(booked).toMatchObject({ ok: true });
    expect(booked.cita).toContain("16:00");
    expect(facts.booked).toBe(true);
  });
});

describe("agenda: validador de la IA", () => {
  it("bloquea horas que no salieron de la agenda y citas confirmadas sin agendar", () => {
    expect(extractTimes("Te espero a las 4:30 pm o a las 10:00")).toEqual(["16:30", "10:00"]);
    const facts = newFacts();
    const invented = validateReply("¡Listo! Tu visita quedó agendada para el jueves a las 10:00.", facts);
    expect(invented.ok).toBe(false);
    if (!invented.ok) {
      expect(invented.reasons).toContain("confirma una cita que no se agendó con agendar_visita");
      expect(invented.reasons).toContain("menciona el horario 10:00 que no viene de la agenda");
    }
    facts.times.add("10:00");
    facts.booked = true;
    expect(validateReply("¡Listo! Tu visita quedó agendada para el jueves a las 10:00.", facts).ok).toBe(true);
  });

  it("no deja decir que canceló, cambió o agendó en una fecha que no salió de la agenda", () => {
    // Caso real visto en dev: el modelo dijo "He cancelado tu visita" sin llamar a cancelar_cita.
    const existing = newFacts();
    rememberSlot(existing, "viernes 9 de octubre, 16:00");
    existing.existing = true;
    const fake = validateReply("No te preocupes, Marco. He cancelado tu visita para este viernes.", existing);
    expect(fake.ok).toBe(false);
    if (!fake.ok) expect(fake.reasons).toContain("dice que canceló la cita sin usar cancelar_cita");
    // Recordar la cita que ya tiene sí se vale.
    expect(validateReply("Tu visita quedó agendada para el viernes 9 de octubre a las 16:00.", existing).ok).toBe(true);
    // Pero no moverla de palabra, ni a otra fecha.
    const moved = validateReply("Listo, cambié tu visita al sábado 10 de octubre a las 16:00.", existing);
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.reasons).toContain("dice que cambió la cita sin usar agendar_visita");
      expect(moved.reasons).toContain("menciona el 10 de octubre que no viene de la agenda");
    }
    // La variante que el modelo usó en el reintento.
    const reworded = validateReply("No te preocupes, Marco, entiendo perfectamente.\n\nHe procedido a cancelar tu visita. Si más adelante tus planes cambian, avísame.", existing);
    expect(reworded.ok).toBe(false);
    // Preguntar no es afirmar.
    expect(validateReply("¿Quieres que cancele tu visita del viernes 9 de octubre?", existing).ok).toBe(true);
    expect(validateReply("Si necesitas cancelar tu visita, solo avísame.", existing).ok).toBe(true);
    expect(validateReply("Listo, tu visita ya quedó cancelada.", existing).ok).toBe(false);
    expect(validateReply("Moví tu visita al viernes 9 de octubre a las 16:00.", existing).ok).toBe(false);
    const cancelled = newFacts();
    cancelled.cancelled = true;
    expect(validateReply("Listo, he cancelado tu visita. Avísame si quieres reagendar.", cancelled).ok).toBe(true);
  });
});

describe("agenda: reservas", () => {
  it("dos reservas simultáneas del mismo horario: solo una gana", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute) VALUES ('r1', 'tnt-demo', 'u-miguel', ?, 600, 660)")
      .bind(weekdayOf(tomorrow()))
      .run();
    await createProspect("p-0001", "u-miguel");
    await createProspect("p-0002", "u-miguel");
    const startsAt = localToEpoch(tomorrow(), 600, TZ);
    const results = await Promise.all(
      ["p-0001", "p-0002"].map((prospectId) => bookAppointment(db, { tenant: TENANT, prospectId, startsAt, source: "ai", actor: "ai" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // Las dos vieron el horario libre; la base rechazó la segunda por el índice único.
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: "taken" });
    const { count } = (await env.DB.prepare("SELECT count(*) AS count FROM appointments WHERE status = 'scheduled'").first<{ count: number }>())!;
    expect(count).toBe(1);
  });

  it("reagendar cancela la cita anterior; el aviso llega al vendedor", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("INSERT INTO availability_rules (id, tenant_id, user_id, weekday, start_minute, end_minute) VALUES ('r1', 'tnt-demo', 'u-miguel', ?, 600, 780)")
      .bind(weekdayOf(tomorrow()))
      .run();
    await createProspect("p-0001", "u-miguel");
    const first = await bookAppointment(db, { tenant: TENANT, prospectId: "p-0001", startsAt: localToEpoch(tomorrow(), 600, TZ), source: "ai", actor: "ai" });
    const second = await bookAppointment(db, { tenant: TENANT, prospectId: "p-0001", startsAt: localToEpoch(tomorrow(), 720, TZ), source: "ai", actor: "ai" });
    expect(first.ok && second.ok && second.replaced).toBe(true);
    // Pedir de nuevo el mismo horario ("sí, agéndala") no crea otra cita ni otro aviso.
    const again = await bookAppointment(db, { tenant: TENANT, prospectId: "p-0001", startsAt: localToEpoch(tomorrow(), 720, TZ), source: "ai", actor: "ai" });
    expect(again).toMatchObject({ ok: true, replaced: false });
    const rows = await env.DB.prepare("SELECT status, cancel_reason FROM appointments ORDER BY starts_at").all<{ status: string; cancel_reason: string | null }>();
    expect(rows.results).toEqual([
      { status: "cancelled", cancel_reason: "Reagendada" },
      { status: "scheduled", cancel_reason: null },
    ]);
    const notes = await env.DB.prepare("SELECT title, user_id FROM notifications ORDER BY created_at").all<{ title: string; user_id: string }>();
    expect(notes.results.map((n) => n.user_id)).toEqual(["u-miguel", "u-miguel"]);
    expect(notes.results[1]!.title).toBe("Cita reagendada: Prospecto p-0001");
  });

  it("el cron avisa al vendedor una sola vez antes de la cita", async () => {
    const db = getDb(env.DB);
    await createProspect("p-0001", "u-miguel");
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO appointments (id, tenant_id, prospect_id, user_id, starts_at, ends_at, status, source, created_at, updated_at) VALUES ('a1', 'tnt-demo', 'p-0001', 'u-miguel', ?, ?, 'scheduled', 'user', 0, 0)",
    )
      .bind(now + 60 * 60_000, now + 120 * 60_000)
      .run();
    expect(await remindSellers(db, now)).toBe(1);
    expect(await remindSellers(db, now + 60_000)).toBe(0);
    const note = await env.DB.prepare("SELECT title, user_id, kind FROM notifications").first();
    expect(note).toMatchObject({ title: "Cita próxima: Prospecto p-0001", user_id: "u-miguel", kind: "appointment" });
  });
});

describe("agenda: API del panel", () => {
  it("horarios por vendedor, reservas, empalmes y permisos", async () => {
    const laura = await login("laura@demo.mx");
    const miguel = await login("miguel@demo.mx");
    await createProspect("p-0001", "u-miguel");
    await createProspect("p-0002", "u-ana");

    // Cada vendedor ajusta solo su horario; la gerente, el de cualquiera.
    expect((await miguel.call("/availability/u-miguel", "PUT", { rules: EVERY_DAY })).status).toBe(200);
    expect((await miguel.call("/availability/u-ana", "PUT", { rules: EVERY_DAY })).status).toBe(403);
    expect((await laura.call("/availability/u-ana", "PUT", { rules: EVERY_DAY })).status).toBe(200);
    expect((await laura.call("/availability/u-ana", "PUT", { rules: [{ weekday: 1, startMinute: 600, endMinute: 540 }] })).status).toBe(400);
    expect((await miguel.json("/availability")).members.map((m: { id: string }) => m.id)).toEqual(["u-miguel"]);

    const slots = await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0001`);
    expect(new Set(slots.map((s: { userId: string }) => s.userId))).toEqual(new Set(["u-miguel"]));
    const ten = slots.find((s: { time: string }) => s.time === "10:00");

    const booked = await laura.call("/appointments", "POST", { prospectId: "p-0001", startsAt: ten.startsAt });
    expect(booked.status).toBe(201);
    // Mismo vendedor, misma hora, otro prospecto: rechazado.
    await createProspect("p-0003", "u-miguel");
    const clash = await laura.call("/appointments", "POST", { prospectId: "p-0003", startsAt: ten.startsAt, userId: "u-miguel" });
    expect(clash.status).toBe(409);

    // El vendedor no ve ni agenda prospectos ajenos.
    expect((await miguel.call("/appointments", "POST", { prospectId: "p-0002", startsAt: ten.startsAt })).status).toBe(404);
    const anaBooking = await laura.json("/appointments", "POST", { prospectId: "p-0002", startsAt: ten.startsAt });
    expect(anaBooking.userId).toBe("u-ana");
    const mine = await miguel.json(`/appointments?from=${todayIn(TZ)}&days=7`);
    expect(mine.map((a: { prospectId: string }) => a.prospectId)).toEqual(["p-0001"]);
    expect((await laura.json(`/appointments?from=${todayIn(TZ)}&days=7`)).length).toBe(2);

    // La ficha muestra la cita y la etapa avanzó a "Cita agendada".
    const ficha = await miguel.json("/prospects/p-0001");
    expect(ficha.prospect.stage).toBe("appointment");
    expect(ficha.appointments[0]).toMatchObject({ status: "scheduled", sellerName: "Miguel Torres" });
    expect(ficha.appointments[0].label).toContain("10:00");

    // Asistencia: solo después de la hora; al marcar "asistió" el prospecto pasa a "Visitó".
    const id = ficha.appointments[0].id;
    expect((await miguel.call(`/appointments/${id}`, "PATCH", { status: "completed" })).status).toBe(400);
    await env.DB.prepare("UPDATE appointments SET starts_at = starts_at - 3 * 86400000, ends_at = ends_at - 3 * 86400000 WHERE id = ?").bind(id).run();
    expect((await miguel.json(`/appointments/${id}`, "PATCH", { status: "completed" })).status).toBe("completed");
    expect((await miguel.json("/prospects/p-0001")).prospect.stage).toBe("visited");
    expect((await miguel.call(`/appointments/${anaBooking.id}`, "PATCH", { status: "cancelled" })).status).toBe(404);

    const summary = await laura.json("/summary");
    expect(summary.appointments.next7Days).toBe(1);
  });

  it("la IA ofrece horarios reales y agenda la visita desde la conversación", async () => {
    const miguel = await login("miguel@demo.mx");
    await miguel.call("/availability/u-miguel", "PUT", { rules: EVERY_DAY });

    const offer = await miguel.json("/agent/simulator", "POST", { message: "Quiero agendar una visita" });
    expect(offer.tools.map((t: { name: string }) => t.name)).toContain("horarios_disponibles");
    const match = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\)/.exec(offer.reply);
    expect(match).not.toBeNull();

    const done = await miguel.json("/agent/simulator", "POST", { message: `Agenda la visita el ${match![1]} a las ${match![2]}` });
    expect(done.blocked).toEqual([]);
    expect(done.reply).toContain("quedó agendada");
    const ficha = await miguel.json(`/prospects/${done.prospect.id}`);
    expect(ficha.appointments[0]).toMatchObject({ status: "scheduled", source: "ai", userId: "u-miguel" });
    const notes = await miguel.json("/notifications");
    expect(notes.items[0]).toMatchObject({ kind: "appointment", title: expect.stringContaining("Cita agendada") });

    const cancelled = await miguel.json("/agent/simulator", "POST", { message: "Mejor cancela mi cita" });
    expect(cancelled.tools.map((t: { name: string }) => t.name)).toContain("cancelar_cita");
    expect((await miguel.json(`/prospects/${done.prospect.id}`)).appointments[0].status).toBe("cancelled");
  });
});

describe("agenda: varios horarios por día y días libres", () => {
  const times = (slots: { time: string }[]) => slots.map((s) => s.time);

  it("dos tramos el mismo día (hora de comida); los empalmes se rechazan", async () => {
    const laura = await login("laura@demo.mx");
    await createProspect("p-0001", "u-miguel");
    const day = weekdayOf(tomorrow());
    const split = [
      { weekday: day, startMinute: 9 * 60, endMinute: 11 * 60 },
      { weekday: day, startMinute: 16 * 60, endMinute: 18 * 60 },
    ];
    expect((await laura.call("/availability/u-miguel", "PUT", { rules: split })).status).toBe(200);
    expect(times(await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0001`))).toEqual(["09:00", "10:00", "16:00", "17:00"]);
    const overlap = await laura.call("/availability/u-miguel", "PUT", {
      rules: [
        { weekday: day, startMinute: 9 * 60, endMinute: 12 * 60 },
        { weekday: day, startMinute: 11 * 60, endMinute: 13 * 60 },
      ],
    });
    expect(overlap.status).toBe(400);
    // El horario de atención de la oficina usa la misma regla.
    const agent = (body: unknown) =>
      laura.call("/settings/agent", "PATCH", body);
    expect((await agent({ businessHours: split })).status).toBe(200);
    expect((await agent({ businessHours: [...split, { weekday: day, startMinute: 10 * 60, endMinute: 17 * 60 }] })).status).toBe(400);
  });

  it("vacaciones de un vendedor y cierre de oficina: quitan horarios y avisan de las citas que hay que mover", async () => {
    const laura = await login("laura@demo.mx");
    const miguel = await login("miguel@demo.mx");
    await createProspect("p-0001", "u-miguel");
    await createProspect("p-0002", "u-ana");
    await laura.call("/availability/u-miguel", "PUT", { rules: EVERY_DAY });
    await laura.call("/availability/u-ana", "PUT", { rules: EVERY_DAY });
    const anaSlots = await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0002`);
    const booked = await laura.json("/appointments", "POST", { prospectId: "p-0002", startsAt: anaSlots.find((s: { time: string }) => s.time === "10:00").startsAt });

    // Miguel registra sus vacaciones: ya no se le ofrecen horarios esos días (ni la IA ni el panel).
    const vac = await miguel.call("/time-off", "POST", { userId: "u-miguel", startDate: tomorrow(), endDate: addDays(tomorrow(), 2), reason: "Vacaciones" });
    expect(vac.status).toBe(201);
    expect(((await vac.json()) as { conflicts: unknown[] }).conflicts).toEqual([]);
    expect(await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0001`)).toEqual([]);
    expect(times(await laura.json(`/appointments/slots?date=${addDays(tomorrow(), 3)}&prospectId=p-0001`))).toContain("10:00");

    // Un vendedor no cierra la oficina ni registra días de otros.
    expect((await miguel.call("/time-off", "POST", { userId: null, startDate: tomorrow(), endDate: tomorrow() })).status).toBe(403);
    expect((await miguel.call("/time-off", "POST", { userId: "u-ana", startDate: tomorrow(), endDate: tomorrow() })).status).toBe(403);
    expect((await laura.call("/time-off", "POST", { userId: null, startDate: tomorrow(), endDate: todayIn(TZ) })).status).toBe(400);
    expect((await laura.call("/time-off", "POST", { userId: null, startDate: "2026-02-30", endDate: "2026-03-01" })).status).toBe(400);

    // La gerente cierra la oficina mañana: la cita de Ana sigue (no se cancela sola) pero se reporta para moverla.
    const close = await laura.json("/time-off", "POST", { userId: null, startDate: tomorrow(), endDate: tomorrow(), reason: "Día festivo" });
    expect(close.conflicts).toEqual([expect.objectContaining({ id: booked.id, userName: "Ana Ruiz", prospectName: "Prospecto p-0002" })]);
    expect(close.conflicts[0].label).toContain("10:00");
    expect(await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0002`)).toEqual([]);

    // El vendedor ve sus días y los de la oficina; solo puede quitar los suyos.
    const list = await miguel.json("/time-off");
    expect(list.map((t: { reason: string }) => t.reason).sort()).toEqual(["Día festivo", "Vacaciones"]);
    expect((await miguel.call(`/time-off/${close.timeOff.id}`, "DELETE")).status).toBe(403);
    expect((await laura.call(`/time-off/${close.timeOff.id}`, "DELETE")).status).toBe(204);
    expect(times(await laura.json(`/appointments/slots?date=${tomorrow()}&prospectId=p-0002`))).toContain("11:00");
  });

  it("cierre de oficina: la IA promete el contacto para el siguiente día que sí abre", () => {
    // 2026-10-09 viernes 19:00, horario L–V 9–18; el lunes 12 es festivo → martes 13.
    const OFFICE = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1080 }));
    const now = localToEpoch("2026-10-09", 19 * 60, TZ);
    expect(advisorEta(OFFICE, TZ, now)).toBe("el lunes 12 de octubre a partir de las 9:00");
    expect(advisorEta(OFFICE, TZ, now, new Set(["2026-10-12"]))).toBe("el martes 13 de octubre a partir de las 9:00");
    // En horario, pero hoy está cerrado: no dice "en breve".
    expect(advisorEta(OFFICE, TZ, localToEpoch("2026-10-12", 10 * 60, TZ), new Set(["2026-10-12"]))).toBe("mañana a partir de las 9:00");
  });
});
