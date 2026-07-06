import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";
import { build } from "esbuild";

const root = process.cwd();
const sidecar = join(root, "apps", "desktop", "src-tauri", "sidecar");

rmSync(sidecar, { recursive: true, force: true });
mkdirSync(join(sidecar, "node_modules"), { recursive: true });
mkdirSync(join(sidecar, "scripts"), { recursive: true });
mkdirSync(join(sidecar, "hooks"), { recursive: true });

await build({
  entryPoints: [join(root, "apps", "server", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["better-sqlite3"],
  define: { "import.meta.url": "__cch_import_meta_url" },
  banner: { js: "const __cch_import_meta_url = require('url').pathToFileURL(__filename).href;" },
  outfile: join(sidecar, "server.cjs"),
});

for (const dep of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
  cpSync(join(root, "node_modules", dep), join(sidecar, "node_modules", dep), { recursive: true });
}

copyFileSync(execPath, join(sidecar, "node.exe"));

copyFileSync(join(root, "apps/server/scripts/focus.ps1"), join(sidecar, "scripts", "focus.ps1"));
for (const f of ["configure.mjs", "notify.mjs", "notify.sh", "find-host-window.ps1"]) {
  copyFileSync(join(root, "apps/server/hooks", f), join(sidecar, "hooks", f));
}

mkdirSync(join(sidecar, "vscode-ext"), { recursive: true });
for (const f of ["extension.js", "package.json", "README.md"]) {
  copyFileSync(join(root, "apps/vscode-ext", f), join(sidecar, "vscode-ext", f));
}

console.log(`sidecar built at ${sidecar}`);
