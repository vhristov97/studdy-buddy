import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    setupFiles: ["./src/test/disable-telemetry.ts"],
  },
});
