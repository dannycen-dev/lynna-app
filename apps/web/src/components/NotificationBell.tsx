import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useMarkNotificationsRead, useNotifications } from "../lib/api";
import { timeAgo } from "../lib/format";

/** Campana de avisos (p. ej. "Ana quiere comprar"). Se consulta cada 10 s. */
export function NotificationBell() {
  const notifications = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = notifications.data?.unread ?? 0;
  const items = notifications.data?.items ?? [];

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="bell" ref={ref}>
      <button
        className="navbar__btn bell__btn"
        onClick={() => setOpen((v) => !v)}
        aria-label={unread ? `Avisos: ${unread} sin leer` : "Avisos"}
        aria-expanded={open}
      >
        <Bell size={18} />
        {unread > 0 && <span className="bell__count">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="bell__panel card" role="dialog" aria-label="Avisos">
          <div className="card__header">
            Avisos
            {unread > 0 && (
              <button className="btn btn--sm btn--ghost" style={{ marginLeft: "auto" }} onClick={() => markRead.mutate(undefined)}>
                Marcar todo como leído
              </button>
            )}
          </div>
          <div className="bell__list">
            {items.length === 0 && <p className="muted" style={{ padding: 16, margin: 0 }}>Sin avisos por ahora.</p>}
            {items.map((n) => (
              <button
                key={n.id}
                className={`bell__item${n.readAt ? "" : " bell__item--unread"}`}
                onClick={() => {
                  if (!n.readAt) markRead.mutate([n.id]);
                  setOpen(false);
                  if (n.prospectId) navigate(`/prospectos/${n.prospectId}`);
                }}
              >
                <strong>{n.title}</strong>
                {n.body && <span className="bell__body">{n.body}</span>}
                <span className="muted" style={{ fontSize: 12 }}>
                  {timeAgo(n.createdAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
