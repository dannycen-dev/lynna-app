import { Building2, CalendarCheck, Calculator, CircleDollarSign, LandPlot, MessageCircle, UserPlus, Users, WalletCards } from "lucide-react";
import { Link } from "react-router";
import { AvailabilityBar, ErrorAlert, Kpi, Spinner, StatusLegend } from "../components/ui";
import { useSummary } from "../lib/api";
import { money, moneyShort, num } from "../lib/format";

const APPS = [
  { to: "/cotizador", label: "Cotizador", icon: <Calculator size={26} /> },
  { to: "/inventario", label: "Inventario", icon: <Building2 size={26} /> },
  { to: "/planes", label: "Planes de pago", icon: <WalletCards size={26} /> },
  { to: "/prospectos", label: "Prospectos", icon: <Users size={26} /> },
  { to: "/citas", label: "Citas", icon: <CalendarCheck size={26} /> },
];

export function Home() {
  const summary = useSummary();

  const totals = summary.data?.developments.reduce(
    (acc, d) => ({
      available: acc.available + d.available,
      reserved: acc.reserved + d.reserved,
      sold: acc.sold + d.sold,
      blocked: acc.blocked + d.blocked,
      value: acc.value + d.availableValueCents,
    }),
    { available: 0, reserved: 0, sold: 0, blocked: 0, value: 0 },
  );

  return (
    <div className="page">
      <section className="hero">
        <h1>Bienvenido a Lynna</h1>
        <p className="page__subtitle">{summary.data ? summary.data.tenant.name : " "}</p>
      </section>

      <nav className="apps" aria-label="Aplicaciones" style={{ marginBottom: 28 }}>
        {APPS.map((app) => (
          <Link key={app.to} to={app.to} className="app-card">
            <span className="app-card__icon">{app.icon}</span>
            {app.label}
          </Link>
        ))}
      </nav>

      {summary.isPending && <Spinner />}
      <ErrorAlert error={summary.error} />

      {summary.data && totals && (
        <div className="stack">
          <div className="grid grid--kpis">
            <Kpi icon={<LandPlot size={14} />} label="Lotes disponibles" value={num(totals.available)} hint={`${num(totals.reserved)} apartados · ${num(totals.sold)} vendidos`} />
            <Kpi icon={<CircleDollarSign size={14} />} label="Inventario disponible" value={moneyShort(totals.value)} hint={money(totals.value)} />
            <Kpi
              icon={<CalendarCheck size={14} />}
              label="Citas hoy"
              value={num(summary.data.appointments?.today ?? 0)}
              hint={`${num(summary.data.appointments?.next7Days ?? 0)} en los próximos 7 días`}
            />
            <Kpi
              icon={<UserPlus size={14} />}
              label="Prospectos"
              value={num(summary.data.prospects.prospects)}
              hint={`${num(summary.data.prospects.newLast24h)} nuevos en 24 h`}
            />
          </div>

          <div className="card">
            <div className="card__header">
              <Building2 size={16} /> Disponibilidad por desarrollo
              <span style={{ marginLeft: "auto" }}>
                <StatusLegend />
              </span>
            </div>
            <div className="card__body stack">
              {summary.data.developments.length === 0 && <p className="muted">Aún no hay desarrollos. Créalos en Inventario.</p>}
              {summary.data.developments.map((d) => (
                <Link key={d.developmentId} to={`/cotizador/${d.slug}`} style={{ color: "inherit" }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <strong>{d.name}</strong>
                    <span className="muted num">
                      {num(d.available)} de {num(d.total)} disponibles
                      {d.minAvailablePriceCents !== null && ` · desde ${money(d.minAvailablePriceCents)}`}
                    </span>
                  </div>
                  <AvailabilityBar {...d} />
                </Link>
              ))}
            </div>
          </div>

          <div className="alert alert--info">
            <MessageCircle size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              El agente de WhatsApp con IA atenderá a los prospectos con este mismo inventario y estos planes de pago: solo ofrece lotes
              disponibles y nunca calcula montos por su cuenta.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
