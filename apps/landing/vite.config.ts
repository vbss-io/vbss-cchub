import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 1500, strictPort: true },
  build: { outDir: "dist" },
});
