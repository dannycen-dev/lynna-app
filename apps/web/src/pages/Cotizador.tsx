import { ArrowLeft, Building2, Calculator, LayoutGrid, List, MapPin, Printer, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AvailabilityBar, Empty, ErrorAlert, PageHeader, Spinner, StatusBadge, StatusLegend } from "../components/ui";
import { useDevelopmentPlans, useDevelopments, useLots, useSimulation, useSummary } from "../lib/api";
import { area, compareLots, isoDate, LINE_LABEL, money, num, pct, STATUS_LABEL, todayMx } from "../lib/format";
import type { Breakdown, Lot, LotStatus, ScheduleLine } from "../lib/types";

// ── Paso 1: desarrollos ───────────────────────────────────────────────────────

export function CotizadorDevelopments() {
  const summary = useSummary();
  const navigate = useNavigate();

  return (
    <div className="page">
      <PageHeader title="Cotizador" subtitle="Selecciona un desarrollo para ver sus lotes y cotizar." />
      {summary.isPending && <Spinner />}
      <ErrorAlert error={summary.error} />
      {summary.data?.developments.length === 0 && (
        <Empty icon={<Building2 size={40} />} title="No hay desarrollos todavía">
          <Link to="/inventario">Crear el primero en Inventario</Link>
        </Empty>
      )}
      <div className="grid grid--cards">
        {summary.data?.developments
          .filter((d) => d.status === "active")
          .map((d) => (
            <button key={d.developmentId} className="card card--clickable" onClick={() => navigate(`/cotizador/${d.slug}`)}>
              <div className="card__body stack" style={{ gap: 10 }}>
                <div className="row" style={{ gap: 12 }}>
                  <span className="app-card__icon" style={{ width: 44, height: 44 }}>
                    <Building2 size={20} />
                  </span>
                  <div>
                    <h3 style={{ fontSize: 16 }}>{d.name}</h3>
                    {d.city && (
                      <span className="muted row" style={{ gap: 4 }}>
                        <MapPin size={13} /> {d.city}
                      </span>
                    )}
                  </div>
                </div>
                <AvailabilityBar {...d} />
                <div className="row muted" style={{ justifyContent: "space-between" }}>
                  <span className="num">
                    <strong style={{ color: "var(--lot-available)" }}>{num(d.available)}</strong> disponibles / {num(d.total)} lotes
                  </span>
                  {d.minAvailablePriceCents !== null && <span className="num">desde {money(d.minAvailablePriceCents)}</span>}
                </div>
              </div>
            </button>
          ))}
      </div>
    </div>
  );
}

// ── Paso 2: lotes del desarrollo (Lista / Plano) ─────────────────────────────

type View = "lista" | "plano";

export function CotizadorLots() {
  const { dev = "" } = useParams();
  const navigate = useNavigate();
  const developments = useDevelopments();
  const lots = useLots(dev);
  const [view, setView] = useState<View>("plano");
  // El plano muestra todo el desarrollo (colores por estado); la lista arranca en disponibles.
  const [status, setStatus] = useState<LotStatus | "all">("all");
  const switchView = (next: View) => {
    setView(next);
    setStatus(next === "lista" ? "available" : "all");
  };
  const [maxBudget, setMaxBudget] = useState("");
  const [minArea, setMinArea] = useState("");

  const development = developments.data?.find((d) => d.slug === dev);
  const filtered = useMemo(() => {
    const max = Number(maxBudget.replace(/[^\d.]/g, "")) * 100;
    const min = Number(minArea);
    return (lots.data ?? [])
      .filter((l) => status === "all" || l.status === status)
      .filter((l) => !max || l.totalPriceCents <= max)
      .filter((l) => !min || l.areaM2 >= min)
      .sort(compareLots);
  }, [lots.data, status, maxBudget, minArea]);

  const open = (lot: Lot) => navigate(`/cotizador/${dev}/lotes/${lot.id}`);

  return (
    <div className="page">
      <Link to="/cotizador" className="backlink">
        <ArrowLeft size={16} /> Desarrollos
      </Link>
      <PageHeader
        title={development?.name ?? "Desarrollo"}
        subtitle={development ? [development.address, development.city, development.state].filter(Boolean).join(", ") : undefined}
      />

      {development?.amenities && development.amenities.length > 0 && (
        <div className="chips" style={{ marginBottom: 16 }}>
          {development.amenities.map((a) => (
            <span key={a} className="badge badge--info badge--plain">
              {a}
            </span>
          ))}
        </div>
      )}

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={view === "plano"} className={`tabs__btn${view === "plano" ? " active" : ""}`} onClick={() => switchView("plano")}>
          <LayoutGrid size={16} /> Plano
        </button>
        <button role="tab" aria-selected={view === "lista"} className={`tabs__btn${view === "lista" ? " active" : ""}`} onClick={() => switchView("lista")}>
          <List size={16} /> Lista
        </button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card__body row" style={{ gap: 16, alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 220 }}>
            <label>Estatus</label>
            <div className="chips">
              {(["available", "all"] as const).map((s) => (
                <button key={s} className={`chip${status === s ? " active" : ""}`} onClick={() => setStatus(s)}>
                  {s === "all" ? "Todos" : STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
          <div className="field" style={{ width: 200 }}>
            <label htmlFor="max-budget">Presupuesto máximo</label>
            <input id="max-budget" className="input" inputMode="numeric" placeholder="$ 800,000" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
          </div>
          <div className="field" style={{ width: 160 }}>
            <label htmlFor="min-area">Superficie mínima</label>
            <input id="min-area" className="input" inputMode="numeric" placeholder="m²" value={minArea} onChange={(e) => setMinArea(e.target.value)} />
          </div>
          <span className="muted" style={{ marginLeft: "auto" }}>
            <Search size={14} style={{ verticalAlign: -2 }} /> {num(filtered.length)} lotes
          </span>
        </div>
      </div>

      {lots.isPending && <Spinner label="Cargando lotes…" />}
      <ErrorAlert error={lots.error} />
      {lots.data && filtered.length === 0 && <Empty title="Ningún lote cumple los filtros" />}

      {lots.data && filtered.length > 0 && view === "lista" && (
        <div className="card table-wrap">
          <table className="table table--hover">
            <thead>
              <tr>
                <th>Lote</th>
                <th className="right">Superficie</th>
                <th className="right">Frente × fondo</th>
                <th className="right">Precio m²</th>
                <th className="right">Precio lista</th>
                <th>Estatus</th>
                <th>Características</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} onClick={() => open(l)}>
                  <td>
                    <strong>
                      Mz {l.block} · Lote {l.number}
                    </strong>
                  </td>
                  <td className="right num">{area(l.areaM2)}</td>
                  <td className="right num">{l.frontM && l.depthM ? `${num(l.frontM)} × ${num(l.depthM)} m` : "—"}</td>
                  <td className="right num">{money(l.pricePerM2Cents)}</td>
                  <td className="right num">
                    <strong>{money(l.totalPriceCents)}</strong>
                  </td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="muted">{l.features ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lots.data && filtered.length > 0 && view === "plano" && (
        <div className="stack">
          <StatusLegend />
          <div className="blocks">
            {Object.entries(groupByBlock(filtered)).map(([block, blockLots]) => (
              <div key={block} className="card card__body">
                <div className="block__title">Manzana {block}</div>
                <div className="block__lots">
                  {blockLots.map((l) => (
                    <button
                      key={l.id}
                      className={`lot-tile lot-tile--${l.status}`}
                      onClick={() => open(l)}
                      title={`Mz ${l.block} Lote ${l.number} · ${area(l.areaM2)} · ${money(l.totalPriceCents)} · ${STATUS_LABEL[l.status]}`}
                      aria-label={`Manzana ${l.block} lote ${l.number}, ${STATUS_LABEL[l.status]}`}
                    >
                      {l.number}
                      <small>{num(l.areaM2)} m²</small>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function groupByBlock(lots: Lot[]): Record<string, Lot[]> {
  return lots.reduce<Record<string, Lot[]>>((acc, l) => {
    (acc[l.block] ??= []).push(l);
    return acc;
  }, {});
}

// ── Paso 3: detalle del lote + simulación ────────────────────────────────────

export function CotizadorLot() {
  const { dev = "", lotId = "" } = useParams();
  const developments = useDevelopments();
  const lots = useLots(dev);
  const plans = useDevelopmentPlans(dev);
  const [planId, setPlanId] = useState<string>("");
  const [quoteDate, setQuoteDate] = useState(todayMx);

  const lot = lots.data?.find((l) => l.id === lotId);
  const development = developments.data?.find((d) => d.slug === dev);
  const selectedPlan = planId || plans.data?.[0]?.id || "";
  const simulation = useSimulation(lot?.status === "available" ? lotId : undefined, selectedPlan || undefined, quoteDate);

  if (lots.isPending) return <Spinner />;
  if (!lot) {
    return (
      <div className="page">
        <Empty title="Lote no encontrado">
          <Link to={`/cotizador/${dev}`}>Volver al desarrollo</Link>
        </Empty>
      </div>
    );
  }

  const planName = plans.data?.find((p) => p.id === selectedPlan)?.name;

  return (
    <div className="page">
      <Link to={`/cotizador/${dev}`} className="backlink">
        <ArrowLeft size={16} /> {development?.name ?? "Lotes"}
      </Link>

      <div className="quote-print-header">
        <img src="/lynna-logo.png" alt="" />
        <div>
          <strong style={{ fontSize: 16 }}>{development?.name}</strong>
          <div className="muted">
            Cotización informativa · {isoDate(quoteDate)}
            {planName && ` · ${planName}`}
          </div>
        </div>
      </div>

      <PageHeader
        title={
          <>
            Manzana {lot.block} · Lote {lot.number}
          </>
        }
        subtitle={<StatusBadge status={lot.status} />}
        actions={
          lot.status === "available" &&
          simulation.data && (
            <button className="btn" onClick={() => window.print()}>
              <Printer size={16} /> Imprimir cotización
            </button>
          )
        }
      />

      <div className="grid grid--detail">
        <div className="stack">
          {lot.status === "available" && (
            <div className="card no-print">
              <div className="card__header">
                <Calculator size={16} /> Plan de pago
              </div>
              <div className="card__body stack">
                {plans.data?.length === 0 && <p className="muted">Este desarrollo no tiene planes activos.</p>}
                <div className="field">
                  <label htmlFor="plan">Plan</label>
                  <select id="plan" className="select" value={selectedPlan} onChange={(e) => setPlanId(e.target.value)}>
                    {plans.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="quote-date">Fecha de cotización</label>
                  <input id="quote-date" className="input" type="date" value={quoteDate} onChange={(e) => e.target.value && setQuoteDate(e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {simulation.data && <BreakdownCard breakdown={simulation.data.breakdown} />}
          <div className="card">
            <div className="card__header">Detalle del lote</div>
            <div className="card__body">
              <dl className="dl">
                <dt>Manzana</dt>
                <dd>{lot.block}</dd>
                <dt>Lote</dt>
                <dd>{lot.number}</dd>
                <dt>Superficie</dt>
                <dd className="num">{area(lot.areaM2)}</dd>
                {lot.frontM && lot.depthM && (
                  <>
                    <dt>Frente × fondo</dt>
                    <dd className="num">
                      {num(lot.frontM)} × {num(lot.depthM)} m
                    </dd>
                  </>
                )}
                <dt>Precio/m²</dt>
                <dd className="num">{money(lot.pricePerM2Cents)}</dd>
                <dt>Precio lista</dt>
                <dd className="num dl__total">{money(lot.totalPriceCents)}</dd>
                {lot.features && (
                  <>
                    <dt>Características</dt>
                    <dd>{lot.features}</dd>
                  </>
                )}
              </dl>
            </div>
          </div>

        </div>

        <div className="stack">
          {lot.status !== "available" && (
            <div className="alert alert--warning">Este lote está {STATUS_LABEL[lot.status].toLowerCase()}: no se puede cotizar.</div>
          )}
          {simulation.isFetching && !simulation.data && <Spinner label="Calculando…" />}
          <ErrorAlert error={simulation.error} />
          {simulation.data && <ScheduleTable lines={simulation.data.lines} withInterest={simulation.data.breakdown.calculationType === "with_interest"} />}
        </div>
      </div>
    </div>
  );
}

function BreakdownCard({ breakdown: b }: { breakdown: Breakdown }) {
  return (
    <div className="card">
      <div className="card__header">Resumen</div>
      <div className="card__body stack" style={{ gap: 10 }}>
        <dl className="dl">
          <dt>Precio lista</dt>
          <dd className="num">{money(b.listPriceCents)}</dd>
          {b.discountCents > 0 && (
            <>
              <dt>Descuento ({pct(b.discountBp)})</dt>
              <dd className="num" style={{ color: "var(--lynna-success-text)" }}>
                −{money(b.discountCents)}
              </dd>
            </>
          )}
          <dt>
            <strong style={{ color: "var(--lynna-on-surface)" }}>Total venta</strong>
          </dt>
          <dd className="num dl__total">{money(b.salePriceCents)}</dd>
          {b.openingFeeCents > 0 && (
            <>
              <dt>Cuota de apertura</dt>
              <dd className="num">{money(b.openingFeeCents)}</dd>
            </>
          )}
          {b.reservationCents > 0 && (
            <>
              <dt>Apartado</dt>
              <dd className="num">{money(b.reservationCents)}</dd>
            </>
          )}
          <dt>Total enganche</dt>
          <dd className="num">
            {money(b.downPaymentTotalCents)}
            {b.downPaymentInstallments > 1 && <span className="muted"> · {b.downPaymentInstallments} pagos</span>}
          </dd>
          {b.monthlyInstallments > 0 && (
            <>
              <dt>Mensualidades</dt>
              <dd className="num">
                {b.monthlyInstallments} × {money(b.monthlyPaymentCents)}
              </dd>
            </>
          )}
          {b.annualInterestBp > 0 && (
            <>
              <dt>Interés anual</dt>
              <dd className="num">{pct(b.annualInterestBp)}</dd>
              <dt>Total intereses</dt>
              <dd className="num">{money(b.totalInterestCents)}</dd>
            </>
          )}
          {b.onDeliveryTotalCents > 0 && (
            <>
              <dt>Contra entrega</dt>
              <dd className="num">
                {money(b.onDeliveryTotalCents)}
                {b.onDeliveryInstallments > 1 && <span className="muted"> · {b.onDeliveryInstallments} pagos</span>}
              </dd>
            </>
          )}
        </dl>
        <p className="quote-legend">Cotización informativa, sujeta a confirmación por un asesor. Precios y disponibilidad pueden cambiar sin previo aviso.</p>
      </div>
    </div>
  );
}

function ScheduleTable({ lines, withInterest }: { lines: ScheduleLine[]; withInterest: boolean }) {
  const total = lines.filter((l) => l.lineType !== "down_payment_total").reduce((acc, l) => acc + l.paymentCents, 0);
  return (
    <div className="card table-wrap">
      <div className="card__header">
        Tabla de pagos <span className="muted" style={{ fontWeight: 500 }}>· {lines.filter((l) => l.lineType !== "down_payment_total").length} pagos</span>
      </div>
      <table className="table table--compact">
        <thead>
          <tr>
            <th>#</th>
            <th>Concepto</th>
            <th>Fecha</th>
            <th className="right">Pago</th>
            {withInterest && <th className="right">Capital</th>}
            {withInterest && <th className="right">Interés</th>}
            <th className="right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.period} className={l.lineType === "down_payment_total" ? "is-summary" : undefined}>
              <td className="num muted">{l.period}</td>
              <td>{LINE_LABEL[l.lineType]}</td>
              <td className="num">{isoDate(l.paymentDate)}</td>
              <td className="right num">
                <strong>{money(l.paymentCents)}</strong>
              </td>
              {withInterest && <td className="right num">{money(l.principalCents)}</td>}
              {withInterest && <td className="right num">{money(l.interestCents)}</td>}
              <td className="right num muted">{money(l.balanceCents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={{ fontWeight: 700 }}>
              Total a pagar
            </td>
            <td className="right num" style={{ fontWeight: 800, color: "var(--lynna-primary)" }}>
              {money(total)}
            </td>
            <td colSpan={withInterest ? 3 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
