import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { developments, lotMedia, MESSAGE_STATUS_RANK, messages, tenants } from "../db/schema";
import type { Attachment } from "../agent/tools";
import { simulateForLot } from "../catalog/service";
import { buildQuotePdf } from "../docs/quote-pdf";
import { todayIn } from "../financing";
import { log } from "../lib/log";
import { replyId, sendCarousel, sendLocation, sendMedia } from "./client";

// Envío del material que acompaña una respuesta (fotos, plano, ubicación, carrusel de lotes). Cada pieza
// queda como mensaje en la conversación para que el CRM muestre exactamente lo que vio el prospecto.

type Target = {
  db: Db;
  env: Env;
  tenantId: string;
  conversationId: string;
  phoneNumberId: string;
  to: string;
  /** false = simulador o sin credenciales: se guarda como "simulado" sin llamar a Meta. */
  real: boolean;
  prospectName?: string | null;
};

/** Pieza lista para mandar: la cotización se convierte en documento al generarla. */
type Ready = Exclude<Attachment, { kind: "quote" }>;

/**
 * Genera la cotización en PDF (tabla de pagos del motor de financiamiento, con la marca de la desarrolladora),
 * la guarda en R2 y la registra en lot_media para poder servirla por /media/:id.
 */
export async function makeQuote(t: Pick<Target, "db" | "env" | "tenantId" | "prospectName">, lotId: string, planId: string): Promise<Ready> {
  if (!t.env.MEDIA) throw new Error("R2 no está configurado: no se puede generar la cotización en PDF.");
  const quoteDate = todayIn();
  const sim = await simulateForLot(t.db, t.tenantId, { lotId, planId, quoteDate });
  const [tenant, dev] = await Promise.all([
    t.db.select().from(tenants).where(eq(tenants.id, t.tenantId)).get(),
    t.db.select().from(developments).where(eq(developments.id, sim.lot.developmentId)).get(),
  ]);
  const logoObj = tenant?.logoR2Key ? await t.env.MEDIA.get(tenant.logoR2Key) : null;
  const logo = logoObj ? { bytes: new Uint8Array(await logoObj.arrayBuffer()), mime: logoObj.httpMetadata?.contentType ?? "image/png" } : null;
  const key = `${sim.lot.block}-${sim.lot.number}`;
  const folio = `${(dev?.slug ?? "lote").slice(0, 10).toUpperCase()}-${key}-${quoteDate.replaceAll("-", "").slice(2)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  const pdf = await buildQuotePdf({
    companyName: tenant?.name ?? "",
    logo,
    primary: tenant?.brandPrimary,
    accent: tenant?.brandAccent,
    development: { name: dev?.name ?? "", address: dev?.address ?? null, city: dev?.city ?? null, state: dev?.state ?? null },
    lot: sim.lot,
    planName: sim.plan.name,
    simulation: sim,
    quoteDate,
    folio,
    prospectName: t.prospectName ?? null,
  });

  const id = crypto.randomUUID();
  const r2Key = `t/${t.tenantId}/d/${sim.lot.developmentId}/quotes/${id}.pdf`;
  await t.env.MEDIA.put(r2Key, pdf, {
    httpMetadata: { contentType: "application/pdf", cacheControl: "private, max-age=86400" },
    customMetadata: { tenantId: t.tenantId, folio },
  });
  await t.db.insert(lotMedia).values({
    id,
    tenantId: t.tenantId,
    developmentId: sim.lot.developmentId,
    lotId: sim.lot.id,
    kind: "quote",
    r2Key,
    mime: "application/pdf",
    caption: `Cotización ${sim.plan.name} · Folio ${folio}`,
  });
  return {
    kind: "document",
    mediaId: id,
    mime: "application/pdf",
    caption: `Cotización informativa · Manzana ${sim.lot.block}, lote ${sim.lot.number} · ${sim.plan.name}`,
    filename: `Cotización ${dev?.name ?? ""} ${key}.pdf`.replace(/\s+/g, " "),
  };
}

export const mediaUrl = (env: Env, mediaId: string) => `${env.PUBLIC_URL.replace(/\/$/, "")}/media/${mediaId}`;

/** Cómo se guarda cada pieza en messages (tipo, texto visible en el CRM y archivo). */
function describe(a: Ready): { type: string; body: string | null; mediaId: string | null; mediaMime: string | null } {
  switch (a.kind) {
    case "image":
    case "document":
      return { type: a.kind, body: a.caption, mediaId: a.mediaId, mediaMime: a.mime };
    case "location":
      return { type: "location", body: [a.name, a.address, `${a.latitude},${a.longitude}`].filter(Boolean).join(" · "), mediaId: null, mediaMime: null };
    case "carousel":
      return {
        type: "carousel",
        body: [a.body, ...a.cards.map((c) => c.text.replace(/\*/g, ""))].join("\n"),
        mediaId: a.cards[0]?.mediaId ?? null,
        mediaMime: null,
      };
  }
}

async function sendOne(t: Target, a: Ready): Promise<string> {
  const cfg = { accessToken: t.env.WHATSAPP_ACCESS_TOKEN, graphVersion: t.env.WHATSAPP_GRAPH_VERSION };
  switch (a.kind) {
    case "image":
    case "document":
      return (
        await sendMedia(cfg, t.phoneNumberId, t.to, {
          type: a.kind,
          link: mediaUrl(t.env, a.mediaId),
          caption: a.caption,
          ...(a.filename ? { filename: a.filename } : {}),
        })
      ).wamid;
    case "location":
      return (await sendLocation(cfg, t.phoneNumberId, t.to, { latitude: a.latitude, longitude: a.longitude, name: a.name, address: a.address })).wamid;
    case "carousel":
      return (
        await sendCarousel(cfg, t.phoneNumberId, t.to, {
          body: a.body,
          cards: a.cards.map((c) => ({
            imageLink: mediaUrl(t.env, c.mediaId),
            text: c.text,
            buttons: c.buttons.map((b) => ({ id: replyId(b.reply), title: b.title })),
          })),
        })
      ).wamid;
  }
}

/** Manda el material en orden. Un fallo no detiene los demás; queda registrado como "failed". */
export async function deliverAttachments(t: Target, attachments: Attachment[]): Promise<number> {
  let sent = 0;
  for (const original of attachments) {
    let a: Ready;
    if (original.kind === "quote") {
      try {
        a = await makeQuote(t, original.lotId, original.planId);
      } catch (err) {
        log("error", "agent.quote_failed", { conversationId: t.conversationId, error: err instanceof Error ? err.message : String(err) });
        continue; // sin PDF el prospecto igual tiene el resumen en el texto
      }
    } else a = original;
    const row = describe(a);
    let wamid = `sim.${crypto.randomUUID()}`;
    let status: "accepted" | "simulated" | "failed" = "simulated";
    let error: string | undefined;
    if (t.real) {
      try {
        wamid = await sendOne(t, a);
        status = "accepted";
        sent++;
      } catch (err) {
        status = "failed";
        error = err instanceof Error ? err.message.slice(0, 500) : String(err);
        log("error", "agent.attachment_failed", { conversationId: t.conversationId, kind: a.kind, error });
      }
    }
    await t.db.insert(messages).values({
      tenantId: t.tenantId,
      conversationId: t.conversationId,
      wamid,
      direction: "out",
      author: "ai",
      ...row,
      status,
      statusRank: MESSAGE_STATUS_RANK[status],
      ...(error ? { error } : {}),
    });
  }
  return sent;
}
