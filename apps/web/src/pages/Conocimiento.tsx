import { BookOpen, CheckCircle2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, Empty, ErrorAlert, PageHeader, Spinner } from "../components/ui";
import { useDeleteArticle, useDevelopments, useKnowledge, useKnowledgeSearch, useSaveArticle } from "../lib/api";
import { dateTime } from "../lib/format";
import { useSession } from "../lib/session";
import type { KbArticle, KbCategory } from "../lib/types";

export const KB_CATEGORY_LABEL: Record<KbCategory, string> = {
  desarrollo: "Desarrollo y servicios",
  compra: "Proceso de compra",
  pagos: "Formas de pago",
  construccion: "Construcción y reglamento",
  oficina: "Oficina de ventas",
  general: "General",
};
const CATEGORIES = Object.keys(KB_CATEGORY_LABEL) as KbCategory[];

/** Textos que la IA puede citar. Solo los aprobados llegan al agente. */
export function Conocimiento() {
  const { canWrite } = useSession();
  const articles = useKnowledge();
  const [editing, setEditing] = useState<KbArticle | "new" | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<KbCategory, KbArticle[]>();
    for (const a of articles.data ?? []) map.set(a.category, [...(map.get(a.category) ?? []), a]);
    return CATEGORIES.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [articles.data]);

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <PageHeader
        title="Base de conocimiento"
        subtitle="Lo que la IA puede responder sobre servicios, proceso de compra, formas de pago y más. Solo usa los textos aprobados, tal cual."
        actions={
          canWrite && (
            <button className="btn btn--primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> Nuevo texto
            </button>
          )
        }
      />
      <div className="stack">
        <SearchTester />
        {articles.isPending && <Spinner />}
        <ErrorAlert error={articles.error} />
        {articles.data?.length === 0 && (
          <Empty icon={<BookOpen size={40} />} title="Aún no hay textos">
            Agrega las preguntas frecuentes que aprobó la desarrolladora: servicios, requisitos, formas de pago…
          </Empty>
        )}
        {grouped.map(([category, items]) => (
          <section key={category} className="card" aria-label={KB_CATEGORY_LABEL[category]}>
            <div className="card__header">
              <BookOpen size={16} /> {KB_CATEGORY_LABEL[category]}
            </div>
            <div className="card__body stack" style={{ gap: 12 }}>
              {items.map((a) => (
                <article key={a.id} className="note" aria-label={a.title}>
                  <div className="row" style={{ justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
                    <strong>{a.title}</strong>
                    <span className="row" style={{ gap: 6 }}>
                      {a.status === "approved" ? (
                        <span className="badge badge--available">
                          <CheckCircle2 size={12} /> Aprobado
                        </span>
                      ) : (
                        <span className="badge badge--reserved">Borrador · la IA no lo usa</span>
                      )}
                      {canWrite && (
                        <button className="btn btn--sm btn--ghost" onClick={() => setEditing(a)} aria-label={`Editar ${a.title}`}>
                          <Pencil size={14} />
                        </button>
                      )}
                    </span>
                  </div>
                  <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{a.body}</p>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {[a.developmentName ?? "Todos los desarrollos", a.keywords ? `Palabras clave: ${a.keywords}` : null, a.approvedByName && a.approvedAt ? `Aprobó ${a.approvedByName}, ${dateTime(a.approvedAt)}` : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
      {editing && <ArticleDialog article={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** "Probar como la IA": qué textos aprobados encontraría con una pregunta. */
function SearchTester() {
  const [q, setQ] = useState("");
  const search = useKnowledgeSearch(q);
  return (
    <div className="card">
      <div className="card__header">
        <Search size={16} /> Probar como la IA
      </div>
      <div className="card__body stack" style={{ gap: 10 }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Escribe una pregunta como la haría un prospecto: ¿el terreno tiene luz?" aria-label="Pregunta de prueba" />
        {q.trim().length >= 3 && search.data && (
          <div className="stack" style={{ gap: 6 }} aria-label="Resultados de la prueba" role="list">
            {search.data.hits.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                La IA no encontraría nada aprobado: diría que un asesor lo confirma.
              </p>
            ) : (
              search.data.hits.map((h, i) => (
                <div key={h.id} role="listitem" className="row" style={{ gap: 8 }}>
                  <span className="badge badge--info">{i + 1}</span> {h.title}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ArticleDialog({ article, onClose }: { article: KbArticle | null; onClose: () => void }) {
  const save = useSaveArticle();
  const remove = useDeleteArticle();
  const developments = useDevelopments();
  const [form, setForm] = useState({
    title: article?.title ?? "",
    body: article?.body ?? "",
    keywords: article?.keywords ?? "",
    category: article?.category ?? ("general" as KbCategory),
    developmentId: article?.developmentId ?? "",
    approved: article ? article.status === "approved" : false,
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const valid = form.title.trim().length >= 3 && form.body.trim().length >= 10;
  const submit = () =>
    save.mutate(
      {
        ...(article ? { id: article.id } : {}),
        title: form.title.trim(),
        body: form.body.trim(),
        keywords: form.keywords.trim() || null,
        category: form.category,
        developmentId: form.developmentId || null,
        status: form.approved ? "approved" : "draft",
      },
      { onSuccess: onClose },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={article ? "Editar texto" : "Nuevo texto"}
      footer={
        <>
          {article && (
            <button className="btn btn--ghost" style={{ marginRight: "auto" }} disabled={remove.isPending} onClick={() => remove.mutate(article.id, { onSuccess: onClose })}>
              <Trash2 size={14} /> Eliminar
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn--primary" disabled={!valid || save.isPending} onClick={submit}>
            Guardar
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12, minWidth: "min(560px, 80vw)" }}>
        <div className="field">
          <label htmlFor="kb-title">Pregunta o tema</label>
          <input id="kb-title" className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="¿Qué servicios tiene el terreno?" />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="kb-category">Categoría</label>
            <select id="kb-category" className="select" value={form.category} onChange={(e) => set({ category: e.target.value as KbCategory })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {KB_CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="kb-dev">Aplica a</label>
            <select id="kb-dev" className="select" value={form.developmentId} onChange={(e) => set({ developmentId: e.target.value })}>
              <option value="">Todos los desarrollos</option>
              {developments.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="kb-body">Respuesta aprobada</label>
          <textarea id="kb-body" className="textarea" style={{ minHeight: 140 }} value={form.body} onChange={(e) => set({ body: e.target.value })} />
          <span className="field__hint">La IA la puede resumir, pero no agrega datos. Sin promesas de fechas de escrituración ni temas legales: eso lo atiende un asesor.</span>
        </div>
        <div className="field">
          <label htmlFor="kb-keywords">Palabras clave</label>
          <input id="kb-keywords" className="input" value={form.keywords} onChange={(e) => set({ keywords: e.target.value })} placeholder="luz, electricidad, CFE" />
          <span className="field__hint">Cómo lo preguntan los prospectos. Mejoran la búsqueda.</span>
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={form.approved} onChange={(e) => set({ approved: e.target.checked })} />
          Aprobado: la IA puede usar este texto
        </label>
        <ErrorAlert error={save.error ?? remove.error} />
      </div>
    </Dialog>
  );
}
