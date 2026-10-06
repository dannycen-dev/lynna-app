import { useEffect, useState } from "react";
import { useChangeLotStatus } from "../lib/api";
import { STATUS_LABEL } from "../lib/format";
import type { Lot, LotStatus } from "../lib/types";
import { Dialog, ErrorAlert, StatusBadge } from "./ui";

function defaultReservationEnd(): string {
  const d = new Date(Date.now() + 7 * 86_400_000);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** Cambio de estado hecho por una persona: exige motivo y, al apartar, fecha de vencimiento. */
export function LotStatusDialog({ lot, onClose }: { lot: Lot | null; onClose: () => void }) {
  const mutation = useChangeLotStatus();
  const [status, setStatus] = useState<LotStatus>("reserved");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState(defaultReservationEnd);

  useEffect(() => {
    if (lot) {
      setStatus(lot.status === "available" ? "reserved" : "available");
      setReason("");
      setUntil(defaultReservationEnd());
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lot?.id]);

  if (!lot) return null;

  const submit = () =>
    mutation.mutate(
      {
        lotId: lot.id,
        status,
        reason,
        ...(status === "reserved" ? { reservedUntil: new Date(until).toISOString() } : {}),
      },
      { onSuccess: onClose },
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Lote ${lot.block}-${lot.number}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={mutation.isPending || reason.trim().length < 3}>
            {mutation.isPending ? "Guardando…" : "Guardar cambio"}
          </button>
        </>
      }
    >
      <div className="row">
        Estado actual: <StatusBadge status={lot.status} />
      </div>
      <div className="field">
        <label htmlFor="lot-status">Nuevo estado</label>
        <select id="lot-status" className="select" value={status} onChange={(e) => setStatus(e.target.value as LotStatus)}>
          {(Object.keys(STATUS_LABEL) as LotStatus[]).map((s) => (
            <option key={s} value={s} disabled={s === lot.status && s !== "reserved"}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      {status === "reserved" && (
        <div className="field">
          <label htmlFor="lot-until">Apartado vence</label>
          <input id="lot-until" className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          <span className="field__hint">Al vencer, el sistema lo libera solo y queda registrado.</span>
        </div>
      )}
      <div className="field">
        <label htmlFor="lot-reason">Motivo</label>
        <textarea
          id="lot-reason"
          className="textarea"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ej. Pago de apartado recibido, recibo 1234"
        />
        <span className="field__hint">Queda en la bitácora de auditoría.</span>
      </div>
      <ErrorAlert error={mutation.error} />
    </Dialog>
  );
}
