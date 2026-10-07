import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider, useRouteError } from "react-router";
import { Layout } from "./components/Layout";
import { Empty, Spinner } from "./components/ui";
import { Agenda } from "./pages/Agenda";
import { CotizadorDevelopments, CotizadorLot, CotizadorLots } from "./pages/Cotizador";
import { Configuracion } from "./pages/Configuracion";
import { Home } from "./pages/Home";
import { InventarioDevelopment, InventarioList } from "./pages/Inventario";
import { Login } from "./pages/Login";
import { Planes } from "./pages/Planes";
import { ProspectoFicha } from "./pages/ProspectoFicha";
import { Prospectos } from "./pages/Prospectos";
import { Simulador } from "./pages/Simulador";
import { SessionProvider, useSession } from "./lib/session";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

/** Sin sesión, todo lleva al login; con sesión, a la app. */
function Protected() {
  const { status } = useSession();
  if (status === "loading") return <Spinner label="Cargando Lynna…" />;
  return status === "signed-in" ? <Layout /> : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const { status } = useSession();
  if (status === "loading") return <Spinner label="Cargando Lynna…" />;
  return status === "signed-in" ? <Navigate to="/" replace /> : <Login />;
}

/** Error inesperado en una pantalla: mensaje claro en lugar del volcado técnico. */
function RouteError() {
  const error = useRouteError();
  console.error(error);
  return (
    <div className="page">
      <Empty title="Algo salió mal en esta pantalla">
        <p>Recarga la página. Si vuelve a pasar, avísanos qué estabas haciendo.</p>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Recargar
        </button>
      </Empty>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginRoute />, errorElement: <RouteError /> },
  {
    element: <Protected />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Home /> },
      { path: "cotizador", element: <CotizadorDevelopments /> },
      { path: "cotizador/:dev", element: <CotizadorLots /> },
      { path: "cotizador/:dev/lotes/:lotId", element: <CotizadorLot /> },
      { path: "inventario", element: <InventarioList /> },
      { path: "inventario/:dev", element: <InventarioDevelopment /> },
      { path: "planes", element: <Planes /> },
      { path: "prospectos", element: <Prospectos /> },
      { path: "prospectos/:id", element: <ProspectoFicha /> },
      { path: "agente", element: <Simulador /> },
      { path: "citas", element: <Agenda /> },
      { path: "ajustes", element: <Configuracion /> },
      { path: "*", element: <div className="page"><Empty title="Página no encontrada" /></div> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
