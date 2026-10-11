// Browser UI (web/). Dev: `pnpm dev:web` on :5317, proxying the API server on :4317.
// Build: `pnpm vite build` -> web/dist, which the server serves in production.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API = "http://127.0.0.1:4317";

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    strictPort: true,
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        // Server-sent events must stream straight through: no compression, no buffering.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (req.url?.endsWith("/events")) proxyReq.setHeader("accept-encoding", "identity");
          });
          proxy.on("proxyRes", (proxyRes) => {
            const type = String(proxyRes.headers["content-type"] ?? "");
            if (type.includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
              delete proxyRes.headers["content-length"];
            }
          });
        },
      },
      "/media": { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist", // relative to root: web/dist
    emptyOutDir: true,
  },
});
