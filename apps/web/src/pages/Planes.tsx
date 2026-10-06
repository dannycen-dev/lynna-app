import { Plus, WalletCards } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Dialog, Empty, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useCreatePlan, useDevelopments, usePlans, useTogglePlan } from "../lib/api";
import { isoDate, money, pct } from "../lib/format";
import { useSession } from "../lib/session";
import type { PaymentPlan } from "../lib/types";

/** Descripción corta y humana del plan, como la leería un vendedor. */
function describePlan(p: PaymentPlan): string[] {
  const parts: string[] = [];
  if (p.discountBp > 0 && p.discountType === "percentage") parts.push(`${pct(p.discountBp)} de descuento`);
  if (p.discountType === "fixed" && p.discountFixedCents > 0) parts.push(`descuento de ${money(p.discountFixedCents)}${p.listPriceType === "total_m2" ? " por m²" : ""}`);
  if (p.reservationCents > 0) parts.push(`apartado ${money(p.reservationCents)}`);
  if (p.calculationType === "with_interest") {
    parts.push(`enganche ${pct(p.downPaymentBp)}`);
    parts.push(`${p.months} mensualidades${p.annualInterestBp ? ` al ${pct(p.annualInterestBp)} anual` : " sin intereses"}`);
  } else if (p.downPaymentBp === 10_000 && p.downPaymentInstallments === 1) {
    parts.push("pago único");
  } else {
    if (p.downPaymentBp) parts.push(`enganche ${pct(p.downPaymentBp)}${p.downPaymentInstallments > 1 ? ` en ${p.downPaymentInstallments} pagos` : ""}`);
    if (p.monthlyBp) parts.push(`${pct(p.monthlyBp)} en ${p.months} mensualidades`);
    if (p.onDeliveryBp) parts.push(`${pct(p.onDeliveryBp)} contra entrega${p.deliveryDate ? ` (${isoDate(p.deliveryDate)})` : ""}`);
  }
  return parts;
}

export function Planes() {
  const plans = usePlans();
  const developments = useDevelopments();
  const toggle = useTogglePlan();
  const { canWrite } = useSession();
  const [creating, setCreating] = useState(false);

  const devName = (id: string | null) => (id ? (developments.data?.find((d) => d.id === id)?.name ?? "—") : "Todos los desarrollos");

  return (
    <div className="page">
      <PageHeader
        title="Planes de pago"
        subtitle="Los planes no se editan para que cualquier cotización emitida se pueda reproducir: se crean nuevos y se desactivan los anteriores."
        actions={
          canWrite && (
            <button className="btn btn--primary" onClick={() => setCreating(true)}>
              <Plus size={16} /> Nuevo plan
            </button>
          )
        }
      />
      {plans.isPending && <Spinner />}
      <ErrorAlert error={plans.error ?? toggle.error} />
      {plans.data?.length === 0 && <Empty icon={<WalletCards size={40} />} title="Sin planes de pago" />}
      <div className="grid grid--cards">
        {plans.data?.map((p) => (
          <div key={p.id} className="card" style={{ opacity: p.active ? 1 : 0.6 }}>
            <div className="card__body stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3 style={{ fontSize: 16 }}>{p.name}</h3>
                <span className={`badge ${p.active ? "badge--available" : "badge--sold"}`}>{p.active ? "Activo" : "Inactivo"}</span>
              </div>
              <span className="muted">{devName(p.developmentId)}</span>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {describePlan(p).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 4 }}>
                <span className="badge badge--info badge--plain">{p.calculationType === "with_interest" ? "Con intereses" : "Sin intereses"}</span>
                {canWrite && (
                  <button className="btn btn--sm" onClick={() => toggle.mutate({ id: p.id, active: !p.active })} disabled={toggle.isPending}>
                    {p.active ? "Desactivar" : "Activar"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {creating && <NewPlanDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

const toBp = (v: string) => Math.round(Number(v || 0) * 100);
const toCents = (v: string) => Math.round(Number(String(v || 0).replace(/[^\d.]/g, "")) * 100);

function NewPlanDialog({ onClose }: { onClose: () => void }) {
  const create = useCreatePlan();
  const developments = useDevelopments();
  const [f, setF] = useState({
    name: "",
    developmentId: "",
    calculationType: "with_interest" as PaymentPlan["calculationType"],
    discount: "0",
    reservation: "10000",
    down: "20",
    downInstallments: "1",
    months: "12",
    interest: "0",
    monthly: "80",
    onDelivery: "0",
    deliveryDate: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const onDelivery = f.calculationType === "on_delivery";
  const sum = Number(f.down || 0) + Number(f.monthly || 0) + Number(f.onDelivery || 0);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name: f.name.trim(),
        developmentId: f.developmentId || null,
        calculationType: f.calculationType,
        discountBp: toBp(f.discount),
        reservationCents: toCents(f.reservation),
        downPaymentBp: toBp(f.down),
        downPaymentInstallments: Number(f.downInstallments) || 1,
        months: Number(f.months) || 0,
        ...(onDelivery
          ? { monthlyBp: toBp(f.monthly), onDeliveryBp: toBp(f.onDelivery), deliveryDate: f.deliveryDate || null }
          : { annualInterestBp: toBp(f.interest) }),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open onClose={onClose} title="Nuevo plan de pago">
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="plan-name">Nombre</label>
          <input id="plan-name" className="input" value={f.name} onChange={set("name")} required minLength={2} placeholder="24 meses sin intereses" />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="plan-dev">Aplica a</label>
            <select id="plan-dev" className="select" value={f.developmentId} onChange={set("developmentId")}>
              <option value="">Todos los desarrollos</option>
              {developments.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="plan-type">Tipo de cálculo</label>
            <select id="plan-type" className="select" value={f.calculationType} onChange={set("calculationType")}>
              <option value="with_interest">Con intereses (amortización)</option>
              <option value="on_delivery">Sin intereses (enganche, mensualidades y contra entrega)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="plan-discount">Descuento %</label>
            <input id="plan-discount" className="input" type="number" min="0" max="100" step="0.01" value={f.discount} onChange={set("discount")} />
          </div>
          <div className="field">
            <label htmlFor="plan-reservation">Apartado $</label>
            <input id="plan-reservation" className="input" inputMode="decimal" value={f.reservation} onChange={set("reservation")} />
          </div>
          <div className="field">
            <label htmlFor="plan-down">Enganche %</label>
            <input id="plan-down" className="input" type="number" min="0" max="100" step="0.01" value={f.down} onChange={set("down")} />
          </div>
          {onDelivery && (
            <div className="field">
              <label htmlFor="plan-down-n">Pagos de enganche</label>
              <input id="plan-down-n" className="input" type="number" min="1" max="60" value={f.downInstallments} onChange={set("downInstallments")} />
            </div>
          )}
          <div className="field">
            <label htmlFor="plan-months">Mensualidades</label>
            <input id="plan-months" className="input" type="number" min="0" max="360" value={f.months} onChange={set("months")} />
          </div>
          {!onDelivery && (
            <div className="field">
              <label htmlFor="plan-interest">Interés anual %</label>
              <input id="plan-interest" className="input" type="number" min="0" max="100" step="0.01" value={f.interest} onChange={set("interest")} />
            </div>
          )}
          {onDelivery && (
            <>
              <div className="field">
                <label htmlFor="plan-monthly">Mensualidades %</label>
                <input id="plan-monthly" className="input" type="number" min="0" max="100" step="0.01" value={f.monthly} onChange={set("monthly")} />
              </div>
              <div className="field">
                <label htmlFor="plan-delivery">Contra entrega %</label>
                <input id="plan-delivery" className="input" type="number" min="0" max="100" step="0.01" value={f.onDelivery} onChange={set("onDelivery")} />
              </div>
              <div className="field">
                <label htmlFor="plan-delivery-date">Fecha de entrega</label>
                <input id="plan-delivery-date" className="input" type="date" value={f.deliveryDate} onChange={set("deliveryDate")} />
              </div>
            </>
          )}
        </div>
        {onDelivery && Math.abs(sum - 100) > 0.001 && (
          <div className="alert alert--warning">Enganche + mensualidades + contra entrega suman {sum} %; deben sumar 100 %.</div>
        )}
        <ErrorAlert error={create.error} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>
            {create.isPending ? "Guardando…" : "Crear plan"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
