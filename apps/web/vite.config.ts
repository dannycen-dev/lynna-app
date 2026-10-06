import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// En desarrollo: Vite (5173) para la interfaz + `pnpm dev` de la API (8787) detrás del proxy.
// En dev/stg/prod: el mismo Worker sirve la API y estos archivos estáticos (mismo origen, sin CORS).
const API = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": API, "/media": API, "/health": API, "/whatsapp": API },
  },
  build: { outDir: "dist", sourcemap: true },
});
