import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const version = process.argv[2];
const workspaces = ["apps/server", "apps/ui", "apps/desktop", "apps/landing"];
const downloadUrl =
  "https://github.com/vbss-io/vbss-cchub/releases/latest/download/VBSS-CCHUB-Setup.msi";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function run(command) {
  execSync(command, { stdio: "inherit", cwd: root });
}

function capture(command) {
  return execSync(command, { cwd: root }).toString().trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isNewer(candidate, current) {
  const a = candidate.split(".").map(Number);
  const b = current.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  fail("usage: node scripts/release.mjs <major.minor.patch>");
}

const current = readJson(join(root, "package.json")).version;
if (!isNewer(version, current)) fail(`version ${version} must be greater than current ${current}`);
if (capture("git branch --show-current") !== "main") fail("run from the main branch");
if (capture("git status --porcelain")) fail("working tree must be clean");
try {
  execSync("gh auth status", { cwd: root, stdio: "ignore" });
} catch {
  fail("gh is not authenticated");
}

console.log(`release: bumping ${current} -> ${version}`);
for (const dir of ["", ...workspaces]) {
  const path = join(root, dir, "package.json");
  const pkg = readJson(path);
  pkg.version = version;
  writeJson(path, pkg);
}

const lockPath = join(root, "package-lock.json");
const lock = readJson(lockPath);
lock.version = version;
lock.packages[""].version = version;
for (const dir of workspaces) {
  if (lock.packages[dir]) lock.packages[dir].version = version;
}
writeJson(lockPath, lock);

const tauriConfPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const tauriConf = readJson(tauriConfPath);
tauriConf.version = version;
writeJson(tauriConfPath, tauriConf);

const cargoPath = join(root, "apps/desktop/src-tauri/Cargo.toml");
writeFileSync(
  cargoPath,
  readFileSync(cargoPath, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`),
);

console.log("release: building installer");
run("npm run desktop:build");

const bundleDir = join(root, "apps/desktop/src-tauri/target/release/bundle/msi");
const built = join(bundleDir, `VBSS CCHUB_${version}_x64_en-US.msi`);
if (!existsSync(built)) fail(`installer not found: ${built}`);
const stable = join(bundleDir, "VBSS-CCHUB-Setup.msi");
copyFileSync(built, stable);

console.log("release: committing version bump");
run("git add -A");
run(`git commit -m "chore: release v${version}"`);
run("git push");

console.log(`release: publishing v${version}`);
run(`gh release create v${version} "${stable}" --title "VBSS CCHUB v${version}" --generate-notes`);

let status = 0;
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const response = await fetch(downloadUrl, { method: "HEAD", redirect: "follow" });
  status = response.status;
  if (response.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (status !== 200) fail(`download url returned HTTP ${status}: ${downloadUrl}`);

console.log(`release: v${version} live — ${downloadUrl} -> HTTP ${status}`);
