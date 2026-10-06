import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Empty } from "./components/ui";
import { CotizadorDevelopments, CotizadorLot, CotizadorLots } from "./pages/Cotizador";
import { Home } from "./pages/Home";
import { InventarioDevelopment, InventarioList } from "./pages/Inventario";
import { Login } from "./pages/Login";
import { Planes } from "./pages/Planes";
import { Conversacion, Prospectos } from "./pages/Prospectos";
import { SessionProvider, useSession } from "./lib/session";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

/** Sin sesión, todo lleva al login; con sesión, a la app. */
function Protected() {
  const { token } = useSession();
  return token ? <Layout /> : <Navigate to="/login" replace />;
}

function LoginRoute() {
  const { token } = useSession();
  return token ? <Navigate to="/" replace /> : <Login />;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginRoute /> },
  {
    element: <Protected />,
    children: [
      { index: true, element: <Home /> },
      { path: "cotizador", element: <CotizadorDevelopments /> },
      { path: "cotizador/:dev", element: <CotizadorLots /> },
      { path: "cotizador/:dev/lotes/:lotId", element: <CotizadorLot /> },
      { path: "inventario", element: <InventarioList /> },
      { path: "inventario/:dev", element: <InventarioDevelopment /> },
      { path: "planes", element: <Planes /> },
      { path: "prospectos", element: <Prospectos /> },
      { path: "prospectos/:conversationId", element: <Conversacion /> },
      { path: "*", element: <div className="page"><Empty title="Página no encontrada" /></div> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </SessionProvider>
  </StrictMode>,
);
