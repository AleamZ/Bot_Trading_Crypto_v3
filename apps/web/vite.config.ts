import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// `npm run dev -w @bot-v3/web` proxies the API to a bot started with `npm run dev` (port 8787 by default).
const api = process.env.BOT_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/health": { target: api },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 900 },
  test: { environment: "node" },
});
