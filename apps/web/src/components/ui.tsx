import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { STATUS_LABEL } from "../lib/format";
import type { LotStatus } from "../lib/types";

export function StatusBadge({ status }: { status: LotStatus }) {
  return <span className={`badge badge--${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Spinner({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <Loader2 size={20} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon ?? <Inbox size={40} aria-hidden />}
      <p style={{ fontWeight: 700, color: "var(--lynna-on-surface)", margin: "4px 0" }}>{title}</p>
      {children}
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Ocurrió un error inesperado.";
  return (
    <div className="alert alert--error" role="alert">
      <AlertTriangle size={16} aria-hidden style={{ flex: "none", marginTop: 1 }} />
      <span>{message}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page__header">
      <div>
        <h1 className="page__title">{title}</h1>
        {subtitle && <p className="page__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page__actions no-print">{actions}</div>}
    </header>
  );
}

export function Kpi({ icon, label, value, hint }: { icon: ReactNode; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="kpi__label">
        {icon}
        {label}
      </div>
      <div className="kpi__value num">{value}</div>
      {hint && <div className="kpi__hint">{hint}</div>}
    </div>
  );
}

export function AvailabilityBar({ available, reserved, sold, blocked }: Record<"available" | "reserved" | "sold" | "blocked", number>) {
  const total = available + reserved + sold + blocked || 1;
  const seg = (n: number, color: string) => <span style={{ width: `${(n / total) * 100}%`, background: color }} />;
  return (
    <div className="availability" aria-label={`${available} disponibles de ${total}`}>
      {seg(available, "var(--lot-available)")}
      {seg(reserved, "var(--lot-reserved)")}
      {seg(blocked, "var(--lot-blocked)")}
      {seg(sold, "var(--lot-sold)")}
    </div>
  );
}

export function StatusLegend() {
  return (
    <div className="legend">
      <span>
        <i style={{ background: "var(--lot-available)" }} />
        Disponible
      </span>
      <span>
        <i style={{ background: "var(--lot-reserved)" }} />
        Apartado
      </span>
      <span>
        <i style={{ background: "var(--lot-blocked)" }} />
        Bloqueado
      </span>
      <span>
        <i style={{ background: "var(--lot-sold)" }} />
        Vendido
      </span>
    </div>
  );
}

/** Diálogo modal nativo (<dialog>): foco atrapado y Escape gratis. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose} aria-labelledby={titleId}>
      <div className="dialog__header" id={titleId}>
        {title}
      </div>
      <div className="dialog__body">{children}</div>
      {footer && <div className="dialog__footer">{footer}</div>}
    </dialog>
  );
}
