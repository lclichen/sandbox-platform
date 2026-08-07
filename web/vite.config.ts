import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: `npm run dev` serves the SPA on :5173 and proxies /api to the platform
// on :3000 so cookie/fetch calls hit the real backend. Production build
// outputs static assets to dist/, served by the platform's express.static.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/health": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
