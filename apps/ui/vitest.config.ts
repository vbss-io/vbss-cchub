import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

const exclusions = JSON.parse(
  readFileSync(new URL("../../scripts/coverage-exclusions.json", import.meta.url), "utf8"),
) as { ui: Record<string, string> };

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      projects: [
        {
          extends: true,
          test: { name: "model", environment: "node", include: ["src/**/*.test.ts"] },
        },
        {
          extends: true,
          test: {
            name: "dom",
            environment: "jsdom",
            include: ["src/**/*.test.tsx"],
            setupFiles: ["src/test-support/dom-setup.ts"],
          },
        },
      ],
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/**/*.d.ts",
          "src/**/*.test.{ts,tsx}",
          "src/test-support/**",
          ...Object.keys(exclusions.ui),
        ],
        reporter: ["text-summary", "lcovonly", "json-summary"],
        reportsDirectory: "coverage",
        thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
      },
    },
  }),
);
