import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")) as { version: string };
const changelog = JSON.parse(readFileSync(join(rootDir, "changelog.json"), "utf8")) as unknown;

export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  build: { outDir: "dist" },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __CHANGELOG__: JSON.stringify(changelog),
  },
});
