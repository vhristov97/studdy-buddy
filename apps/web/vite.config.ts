import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveApiPort } from "./devProxy";

/** Repo root (apps/web -> repo root), where the shared `.env` lives. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const apiTarget = `http://127.0.0.1:${resolveApiPort(REPO_ROOT)}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": apiTarget,
      "/viz": apiTarget,
    },
  },
  build: {
    outDir: "dist",
  },
});
