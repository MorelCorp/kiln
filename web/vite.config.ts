import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = `http://127.0.0.1:${process.env.KILN_PORT ?? 7420}`;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": { target: api, changeOrigin: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
