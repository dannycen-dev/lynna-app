import { Gauge } from "lucide-react";
import { useState } from "react";
import { ErrorAlert, Kpi, PageHeader, Spinner } from "../components/ui";
import { useAllUsage, useTenantUsage } from "../lib/api";
import { num } from "../lib/format";
import { useSession } from "../lib/session";
import type { TenantUsage } from "../lib/types";

// Tipo de cambio de referencia para mostrar pesos (la IA se cobra en dólares). Revisar al facturar.
const USD_MXN = 18.13;
const usd = (n: number) => `USD ${n.toFixed(2)}`;
const mxn = (n: number) => `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;

/** Consumo del mes para facturar al costo: IA (Workers AI) y estimación de WhatsApp (lo cobra Meta). */
export function Consumo() {
  const { me } = useSession();
  const isAdmin = me?.user.role === "admin";
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const own = useTenantUsage(month);
  const all = useAllUsage(month, isAdmin);
  const u = own.data?.usage;
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Consumo"
        subtitle="IA y WhatsApp del mes, sin las pruebas del simulador. La IA se factura al costo; WhatsApp lo cobra Meta directo a la desarrolladora (aquí es una estimación)."
        actions={<input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mes" style={{ width: 180 }} />}
      />
      {own.isPending && <Spinner />}
      <ErrorAlert error={own.error ?? all.error} />
      {u && (
        <div className="grid grid--kpis">
          <Kpi icon={<Gauge size={14} />} label="Respuestas de la IA" value={num(u.aiReplies)} hint={`${num(u.conversations)} conversaciones · ${num(u.inbound)} mensajes recibidos`} />
          <Kpi icon={<Gauge size={14} />} label="Costo de IA" value={usd(u.aiUsd)} hint={`≈ ${mxn(u.aiUsd * USD_MXN)} · ${num(u.neurons)} neuronas`} />
          <Kpi icon={<Gauge size={14} />} label="WhatsApp (estimado)" value={mxn(u.whatsappMxnEstimate)} hint={`${num(u.templates)} plantillas · ${num(u.outboundReplies)} respuestas (1,000 gratis al mes)`} />
        </div>
      )}
      {isAdmin && all.data && <AllTenants rows={all.data.tenants} />}
    </div>
  );
}

function AllTenants({ rows }: { rows: TenantUsage[] }) {
  const total = rows.reduce((a, r) => a + r.aiUsd, 0);
  return (
    <section className="card table-wrap" aria-label="Todas las desarrolladoras" style={{ marginTop: 16 }}>
      <div className="card__header">
        <Gauge size={16} /> Todas las desarrolladoras (solo Ignia) · IA total {usd(total)}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Desarrolladora</th>
            <th className="right">Respuestas IA</th>
            <th className="right">Neuronas</th>
            <th className="right">IA a facturar</th>
            <th className="right">WhatsApp estimado</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId}>
              <td>{r.name}</td>
              <td className="right num">{num(r.aiReplies)}</td>
              <td className="right num">{num(r.neurons)}</td>
              <td className="right num">
                {usd(r.aiUsd)} <span className="muted">≈ {mxn(r.aiUsd * USD_MXN)}</span>
              </td>
              <td className="right num">{mxn(r.whatsappMxnEstimate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
