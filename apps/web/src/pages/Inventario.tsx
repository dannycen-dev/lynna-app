import { ArrowLeft, Building2, CheckCircle2, FileSpreadsheet, FileText, ImagePlus, LandPlot, MapPin, Plus, Trash2, Upload } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { LotStatusDialog } from "../components/LotStatusDialog";
import { AvailabilityBar, Dialog, Empty, ErrorAlert, PageHeader, Spinner, StatusBadge } from "../components/ui";
import { ApiError, useCreateDevelopment, useDeleteMedia, useDevelopments, useImportLots, useLots, useMedia, useSummary, useUploadMedia } from "../lib/api";
import { area, compareLots, dateTime, money, num, slugify, STATUS_LABEL } from "../lib/format";
import type { ImportResult, Lot, LotStatus, Media } from "../lib/types";

// ── Lista de desarrollos ──────────────────────────────────────────────────────

export function InventarioList() {
  const summary = useSummary();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <div className="page">
      <PageHeader
        title="Desarrollos y lotes"
        subtitle="Inventario que usan el cotizador y el agente de WhatsApp."
        actions={
          <button className="btn btn--primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> Nuevo desarrollo
          </button>
        }
      />
      {summary.isPending && <Spinner />}
      <ErrorAlert error={summary.error} />
      {summary.data?.developments.length === 0 && (
        <Empty icon={<Building2 size={40} />} title="Sin desarrollos">
          Crea el primero y después importa sus lotes desde un CSV.
        </Empty>
      )}
      <div className="grid grid--cards">
        {summary.data?.developments.map((d) => (
          <button key={d.developmentId} className="card card--clickable" onClick={() => navigate(`/inventario/${d.slug}`)}>
            <div className="card__body stack" style={{ gap: 10 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3 style={{ fontSize: 16 }}>{d.name}</h3>
                {d.status === "inactive" && <span className="badge badge--sold">Inactivo</span>}
              </div>
              {d.city && (
                <span className="muted row" style={{ gap: 4 }}>
                  <MapPin size={13} /> {d.city}
                </span>
              )}
              <AvailabilityBar {...d} />
              <div className="row muted num" style={{ gap: 12 }}>
                <span>{num(d.total)} lotes</span>
                <span style={{ color: "var(--lot-available)" }}>{num(d.available)} disp.</span>
                <span style={{ color: "var(--lynna-warning-text)" }}>{num(d.reserved)} apart.</span>
                <span>{num(d.sold)} vend.</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <NewDevelopmentDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

function NewDevelopmentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateDevelopment();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: "", slug: "", city: "", state: "", address: "", amenities: "" });
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value, ...(k === "name" && !slugTouched ? { slug: slugify(e.target.value) } : {}) }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name: form.name.trim(),
        slug: form.slug,
        city: form.city || null,
        state: form.state || null,
        address: form.address || null,
        amenities: form.amenities
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      },
      { onSuccess: (dev) => navigate(`/inventario/${dev.slug}`) },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title="Nuevo desarrollo">
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="dev-name">Nombre</label>
          <input id="dev-name" className="input" value={form.name} onChange={set("name")} required minLength={2} placeholder="Residencial Los Almendros" />
        </div>
        <div className="field">
          <label htmlFor="dev-slug">Identificador</label>
          <input
            id="dev-slug"
            className="input"
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug")(e);
            }}
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
          <span className="field__hint">Se usa en la URL. Minúsculas, números y guiones.</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="dev-city">Ciudad</label>
            <input id="dev-city" className="input" value={form.city} onChange={set("city")} />
          </div>
          <div className="field">
            <label htmlFor="dev-state">Estado</label>
            <input id="dev-state" className="input" value={form.state} onChange={set("state")} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="dev-address">Dirección</label>
          <input id="dev-address" className="input" value={form.address} onChange={set("address")} />
        </div>
        <div className="field">
          <label htmlFor="dev-amenities">Amenidades</label>
          <input id="dev-amenities" className="input" value={form.amenities} onChange={set("amenities")} placeholder="Alberca, Casa club, Acceso controlado" />
          <span className="field__hint">Separadas por comas.</span>
        </div>
        <ErrorAlert error={create.error} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary" disabled={create.isPending}>
            {create.isPending ? "Creando…" : "Crear desarrollo"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ── Ficha de un desarrollo ────────────────────────────────────────────────────

type Tab = "lotes" | "importar" | "media";

export function InventarioDevelopment() {
  const { dev = "" } = useParams();
  const developments = useDevelopments();
  const [tab, setTab] = useState<Tab>("lotes");
  const development = developments.data?.find((d) => d.slug === dev);

  if (developments.isPending) return <Spinner />;
  if (!development) {
    return (
      <div className="page">
        <Empty title="Desarrollo no encontrado">
          <Link to="/inventario">Volver a Inventario</Link>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <Link to="/inventario" className="backlink">
        <ArrowLeft size={16} /> Desarrollos
      </Link>
      <PageHeader
        title={development.name}
        subtitle={[development.address, development.city, development.state].filter(Boolean).join(", ") || undefined}
        actions={
          <Link to={`/cotizador/${dev}`} className="btn">
            Abrir en cotizador
          </Link>
        }
      />
      <div className="tabs" role="tablist">
        {(
          [
            ["lotes", "Lotes", <LandPlot size={16} key="i" />],
            ["importar", "Importar CSV", <FileSpreadsheet size={16} key="i" />],
            ["media", "Fotos y planos", <ImagePlus size={16} key="i" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`tabs__btn${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            {icon}
            {label}
          </button>
        ))}
      </div>
      {tab === "lotes" && <LotsTab dev={dev} />}
      {tab === "importar" && <ImportTab dev={dev} onDone={() => setTab("lotes")} />}
      {tab === "media" && <MediaTab dev={dev} />}
    </div>
  );
}

function LotsTab({ dev }: { dev: string }) {
  const lots = useLots(dev);
  const [status, setStatus] = useState<LotStatus | "all">("all");
  const [editing, setEditing] = useState<Lot | null>(null);
  const rows = useMemo(() => (lots.data ?? []).filter((l) => status === "all" || l.status === status).sort(compareLots), [lots.data, status]);

  const counts = (lots.data ?? []).reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.status]: (acc[l.status] ?? 0) + 1 }), {});

  return (
    <div className="stack">
      <div className="chips">
        {(["all", "available", "reserved", "sold", "blocked"] as const).map((s) => (
          <button key={s} className={`chip${status === s ? " active" : ""}`} onClick={() => setStatus(s)}>
            {s === "all" ? `Todos (${lots.data?.length ?? 0})` : `${STATUS_LABEL[s]} (${counts[s] ?? 0})`}
          </button>
        ))}
      </div>
      {lots.isPending && <Spinner />}
      <ErrorAlert error={lots.error} />
      {lots.data?.length === 0 && (
        <Empty icon={<FileSpreadsheet size={40} />} title="Este desarrollo aún no tiene lotes">
          Cárgalos desde la pestaña <strong>Importar CSV</strong>.
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Lote</th>
                <th className="right">Superficie</th>
                <th className="right">Precio m²</th>
                <th className="right">Precio lista</th>
                <th>Estatus</th>
                <th>Apartado vence</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    <strong>
                      Mz {l.block} · Lote {l.number}
                    </strong>
                    {l.features && <div className="muted" style={{ fontSize: 12 }}>{l.features}</div>}
                  </td>
                  <td className="right num">{area(l.areaM2)}</td>
                  <td className="right num">{money(l.pricePerM2Cents)}</td>
                  <td className="right num">{money(l.totalPriceCents)}</td>
                  <td>
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="num muted">{l.reservedUntil ? dateTime(l.reservedUntil) : ""}</td>
                  <td className="right">
                    <button className="btn btn--sm" onClick={() => setEditing(l)}>
                      Cambiar estado
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LotStatusDialog lot={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

const CSV_EXAMPLE = `Manzana,Lote,Superficie m2,Frente,Fondo,Precio por m2,Estado,Características
A,1,250,10,25,3200,Disponible,Esquina
A,2,240,10,24,3200,Disponible,
B,1,300,12,25,3000,Apartado,Frente a parque`;

function ImportTab({ dev, onDone }: { dev: string; onDone: () => void }) {
  const mutation = useImportLots(dev);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setCsv(await file.text());
    setPreview(null);
  };

  const check = () => mutation.mutate({ csv, dryRun: true }, { onSuccess: setPreview });
  const run = () =>
    mutation.mutate(
      { csv, dryRun: false },
      {
        onSuccess: (r) => {
          setPreview(r);
          if (r.valid) setTimeout(onDone, 1200);
        },
      },
    );

  return (
    <div className="grid grid--2">
      <div className="card">
        <div className="card__header">
          <Upload size={16} /> Archivo
        </div>
        <div className="card__body stack">
          <div className="field">
            <span style={{ fontWeight: 600, fontSize: 13 }}>CSV exportado de Excel</span>
            <div className="file-pick">
              <label className="btn">
                <Upload size={16} /> Elegir archivo
                <input type="file" accept=".csv,text/csv" onChange={(e) => readFile(e.target.files?.[0])} />
              </label>
              <span className="muted">{fileName ?? "Ningún archivo seleccionado"}</span>
            </div>
          </div>
          <div className="field">
            <label htmlFor="csv-text">o pega el contenido</label>
            <textarea
              id="csv-text"
              className="textarea"
              style={{ minHeight: 200, fontFamily: "var(--lynna-font-mono)", fontSize: 12 }}
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFileName(null);
                setPreview(null);
              }}
              placeholder={CSV_EXAMPLE}
            />
          </div>
          <div className="row">
            <button className="btn" onClick={check} disabled={!csv.trim() || mutation.isPending}>
              Revisar sin guardar
            </button>
            <button className="btn btn--primary" onClick={run} disabled={!preview?.valid || !preview.dryRun || mutation.isPending}>
              Importar
            </button>
          </div>
          <ErrorAlert error={mutation.error} />
        </div>
      </div>

      <div className="stack">
        {preview?.valid && (
          <div className="alert alert--success">
            <CheckCircle2 size={16} style={{ flex: "none", marginTop: 1 }} />
            <span>
              {preview.dryRun ? "El archivo es válido. Al importar:" : "Importación completa:"} {num(preview.created ?? 0)} nuevos, {num(preview.updated ?? 0)}{" "}
              actualizados, {num(preview.statusChanges ?? 0)} cambios de estado.
            </span>
          </div>
        )}
        {preview && !preview.valid && preview.errors && (
          <div className="card table-wrap">
            <div className="card__header" style={{ color: "var(--lynna-error)" }}>
              {preview.errors.length} {preview.errors.length === 1 ? "error" : "errores"} — no se guardó nada
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Renglón</th>
                  <th>Columna</th>
                  <th>Problema</th>
                </tr>
              </thead>
              <tbody>
                {preview.errors.map((e, i) => (
                  <tr key={i}>
                    <td className="num">{e.line}</td>
                    <td>{e.field ?? "—"}</td>
                    <td>{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card">
          <div className="card__header">Formato</div>
          <div className="card__body stack" style={{ gap: 8 }}>
            <p style={{ margin: 0 }}>
              Obligatorias: <strong>manzana, lote, superficie_m2, precio_m2</strong>. Opcionales: frente, fondo, precio_total, estado, características.
            </p>
            <p className="muted" style={{ margin: 0 }}>
              Acepta separador coma o punto y coma, encabezados con acentos y precios como “$3,200.50”. Si un lote ya existe (misma manzana y número) se
              actualiza; el estado solo cambia si la columna viene y queda auditado. Si hay un error, no se guarda nada.
            </p>
            <pre style={{ margin: 0, padding: 10, background: "var(--lynna-surface-container-low)", borderRadius: 8, fontSize: 12, overflowX: "auto" }}>
              {CSV_EXAMPLE}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<Media["kind"], string> = { photo: "Foto", plan: "Plano", brochure: "Folleto" };

function MediaTab({ dev }: { dev: string }) {
  const media = useMedia(dev);
  const upload = useUploadMedia(dev);
  const remove = useDeleteMedia();
  const [kind, setKind] = useState<Media["kind"]>("photo");
  const [caption, setCaption] = useState("");

  const storageMissing = upload.error instanceof ApiError && upload.error.status === 503;

  return (
    <div className="stack">
      <div className="card">
        <div className="card__body row" style={{ alignItems: "flex-end", gap: 12 }}>
          <div className="field" style={{ width: 160 }}>
            <label htmlFor="media-kind">Tipo</label>
            <select id="media-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as Media["kind"])}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="media-caption">Descripción</label>
            <input id="media-caption" className="input" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Plano general etapa 1" />
          </div>
          <label className="btn btn--primary">
            <Upload size={16} /> {upload.isPending ? "Subiendo…" : "Subir archivo"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              hidden
              disabled={upload.isPending}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate({ file, kind, caption: caption || undefined }, { onSuccess: () => setCaption("") });
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {storageMissing ? (
        <div className="alert alert--warning">El almacenamiento de archivos (R2) aún no está activado en este entorno.</div>
      ) : (
        <ErrorAlert error={upload.error ?? remove.error} />
      )}
      {media.isPending && <Spinner />}
      {media.data?.length === 0 && <Empty icon={<ImagePlus size={40} />} title="Sin fotos ni planos" />}
      <div className="grid grid--cards">
        {media.data?.map((m) => (
          <div key={m.id} className="card">
            {m.mime === "application/pdf" ? (
              <a href={`/media/${m.id}`} target="_blank" rel="noreferrer" className="empty" style={{ display: "block", padding: 32 }}>
                <FileText size={48} />
                <div>Abrir PDF</div>
              </a>
            ) : (
              <img src={`/media/${m.id}`} alt={m.caption ?? KIND_LABEL[m.kind]} style={{ width: "100%", aspectRatio: "4/3", objectFit: "cover", borderRadius: "12px 12px 0 0" }} />
            )}
            <div className="card__body row" style={{ justifyContent: "space-between" }}>
              <div>
                <span className="badge badge--info badge--plain">{KIND_LABEL[m.kind]}</span>
                {m.caption && <div style={{ marginTop: 4 }}>{m.caption}</div>}
              </div>
              <button className="btn btn--sm btn--ghost btn--danger" onClick={() => remove.mutate(m.id)} aria-label="Eliminar">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
