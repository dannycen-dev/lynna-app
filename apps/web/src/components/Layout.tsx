import {
  Bot,
  Building2,
  CalendarCheck,
  Calculator,
  Home,
  LogOut,
  Menu,
  MessageCircle,
  Settings,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useSession } from "../lib/session";
import { NotificationBell } from "./NotificationBell";

type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean; soon?: boolean };

// Mismo orden que el sidebar de la app Inmobiliaria en Lynna (Odoo).
const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: "/", label: "Inicio", icon: <Home size={18} />, end: true }] },
  {
    section: "Ventas",
    items: [
      { to: "/cotizador", label: "Cotizador", icon: <Calculator size={18} /> },
      { to: "/prospectos", label: "Prospectos", icon: <Users size={18} /> },
      { to: "/agente", label: "Agente de IA", icon: <Bot size={18} /> },
      { to: "/conversaciones", label: "WhatsApp", icon: <MessageCircle size={18} />, soon: true },
      { to: "/citas", label: "Citas", icon: <CalendarCheck size={18} />, soon: true },
    ],
  },
  {
    section: "Inventario",
    items: [
      { to: "/inventario", label: "Desarrollos y lotes", icon: <Building2 size={18} /> },
      { to: "/planes", label: "Planes de pago", icon: <WalletCards size={18} /> },
    ],
  },
  { section: "Ajustes", items: [{ to: "/ajustes", label: "Configuración", icon: <Settings size={18} />, soon: true }] },
];

const ENV_LABEL: Record<string, string> = { localhost: "local", "127.0.0.1": "local" };

function environmentLabel(): string | null {
  const host = window.location.hostname;
  if (ENV_LABEL[host]) return ENV_LABEL[host];
  // devlynna.igniastudio.mx → "dev", stglynna… → "stg"; producción no muestra etiqueta.
  const match = /^(dev|stg)lynna\./.exec(host);
  return match ? match[1]! : null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Layout() {
  const { me, roleLabel, tenant, tenants, setTenant, signOut } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const env = environmentLabel();

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className={`shell${menuOpen ? " shell--menu-open" : ""}`}>
      <header className="navbar">
        <button
          className="navbar__btn navbar__menu-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label={menuOpen ? "Cerrar menú" : "Abrir menú"}
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
        <NavLink to="/" className="navbar__brand">
          <img className="navbar__logo" src="/lynna-icon-192.png" alt="" />
          Lynna
        </NavLink>
        {env && <span className="navbar__env navbar__hide-sm">{env}</span>}
        <div className="navbar__spacer" />
        {tenants.length > 1 ? (
          <label className="navbar__hide-sm">
            <span className="sr-only">Desarrolladora</span>
            <select className="navbar__select" value={tenant} onChange={(e) => setTenant(e.target.value)}>
              {tenants.map((t) => (
                <option key={t.id} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="navbar__tenant navbar__hide-sm">{tenants[0]?.name}</span>
        )}
        {me && (
          <span className="navbar__user navbar__hide-sm" title={me.user.email}>
            <span className="navbar__avatar" aria-hidden>
              {initials(me.user.name)}
            </span>
            <span>
              <span className="navbar__user-name">{me.user.name}</span>
              <span className="navbar__user-role">{roleLabel}</span>
            </span>
          </span>
        )}
        <NotificationBell />
        <button className="navbar__btn" onClick={() => void signOut()} title="Cerrar sesión">
          <LogOut size={16} />
          <span className="navbar__hide-sm">Salir</span>
        </button>
      </header>

      <nav className="sidebar" aria-label="Navegación principal">
        {NAV.map((group, i) => (
          <div key={group.section ?? i}>
            {group.section && <div className="sidebar__section">{group.section}</div>}
            {group.items.map((item) =>
              item.soon ? (
                <span key={item.to} className="sidebar__link sidebar__link--disabled" aria-disabled>
                  {item.icon}
                  {item.label}
                  <span className="sidebar__soon">Pronto</span>
                </span>
              ) : (
                <NavLink key={item.to} to={item.to} end={item.end} className="sidebar__link">
                  {item.icon}
                  {item.label}
                </NavLink>
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="scrim" onClick={() => setMenuOpen(false)} />

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
