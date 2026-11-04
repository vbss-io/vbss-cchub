import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: { port: 1500, strictPort: true },
  build: { outDir: "dist" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-support/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/main.tsx",
        "src/entry-server.tsx",
        "src/**/*.d.ts",
        "src/**/*.test.{ts,tsx}",
        "src/test-support/**",
      ],
      reporter: ["text", "html", "lcov", "json-summary"],
    },
  },
});
