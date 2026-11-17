import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exclusions = JSON.parse(readFileSync(join(root, "scripts/coverage-exclusions.json"), "utf8"));
const TARGETS = { lines: 90, branches: 80, functions: 90, statements: 90 };
const METRICS = ["lines", "branches", "functions", "statements"];
const COMPONENTS = ["ui", "server", "vscode-ext", "desktop"];
const isWindows = process.platform === "win32";

function usage() {
  console.log(`usage: node scripts/coverage.mjs [options]

  --only <names>      comma-separated components to run (${COMPONENTS.join(", ")}); repeatable
  --concurrency <n>   node:test file concurrency for server and vscode-ext (default 2)
  --files             print the per-file table of every component
  --markdown <path>   write totals and per-file tables as markdown to <path>

Targets: lines ${TARGETS.lines}, branches ${TARGETS.branches}, functions ${TARGETS.functions}, statements ${TARGETS.statements}.
Exclusions live in scripts/coverage-exclusions.json, each with its reason.`);
}

function parseArgs(argv) {
  const options = { only: [], concurrency: 2, files: false, markdown: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else if (arg === "--only") options.only.push(...value().split(",").map((name) => name.trim()).filter(Boolean));
    else if (arg.startsWith("--only=")) options.only.push(...arg.slice(7).split(",").map((name) => name.trim()).filter(Boolean));
    else if (arg === "--concurrency") options.concurrency = Number(value());
    else if (arg === "--files") options.files = true;
    else if (arg === "--markdown") options.markdown = resolve(value());
    else throw new Error(`unknown argument ${arg}`);
  }
  const unknown = options.only.filter((name) => !COMPONENTS.includes(name));
  if (unknown.length > 0) throw new Error(`unknown component ${unknown.join(", ")}; known: ${COMPONENTS.join(", ")}`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be a positive integer");
  return options;
}

function posix(path) {
  return path.split("\\").join("/");
}

function walk(dir, accept, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, accept, base, out);
    } else {
      const rel = posix(relative(base, full));
      if (accept(rel)) out.push(rel);
    }
  }
  return out.sort();
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function counter(total, covered) {
  return { total, covered: Math.min(covered, total) };
}

function pct(metric) {
  if (!metric) return null;
  return metric.total === 0 ? 100 : (metric.covered / metric.total) * 100;
}

function fmtPct(metric) {
  const value = pct(metric);
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

function physicalLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function estimateMissing(absPath, language) {
  const text = readFileSync(absPath, "utf8");
  const lines = physicalLines(text);
  if (language === "rust") {
    const functions = (text.match(/\bfn\s+\w+/g) ?? []).length;
    return { lines: counter(lines, 0), branches: null, functions: counter(functions, 0), statements: counter(lines, 0) };
  }
  const functions = (text.match(/\bfunction\b|=>/g) ?? []).length;
  const twoWay = (text.match(/\bif\s*\(|&&|\|\||\?\?|\?\s/g) ?? []).length;
  const cases = (text.match(/\bcase\b/g) ?? []).length;
  return {
    lines: counter(lines, 0),
    branches: counter(twoWay * 2 + cases, 0),
    functions: counter(functions, 0),
    statements: counter(lines, 0),
  };
}

function parseLcov(text, baseDir) {
  const files = new Map();
  let current = null;
  const fresh = () => ({ lf: 0, lh: 0, brf: 0, brh: 0, fnf: 0, fnh: 0, da: [], brda: [], fnda: [] });
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = { file: posix(relative(baseDir, resolve(baseDir, line.slice(3)))), ...fresh() };
    } else if (!current) {
      continue;
    } else if (line === "end_of_record") {
      const lines = current.lf || current.da.length;
      const linesHit = current.lh || current.da.filter((hits) => hits > 0).length;
      const record = {
        lines: counter(lines, linesHit),
        branches: counter(current.brf || current.brda.length, current.brh || current.brda.filter((hits) => hits > 0).length),
        functions: counter(current.fnf || current.fnda.length, current.fnh || current.fnda.filter((hits) => hits > 0).length),
      };
      record.statements = { ...record.lines };
      const previous = files.get(current.file);
      if (!previous || previous.lines.covered < record.lines.covered) files.set(current.file, record);
      current = null;
    } else {
      const [key, value = ""] = line.split(/:(.*)/s);
      if (key === "LF") current.lf = Number(value);
      else if (key === "LH") current.lh = Number(value);
      else if (key === "BRF") current.brf = Number(value);
      else if (key === "BRH") current.brh = Number(value);
      else if (key === "FNF") current.fnf = Number(value);
      else if (key === "FNH") current.fnh = Number(value);
      else if (key === "DA") current.da.push(Number(value.split(",")[1]));
      else if (key === "BRDA") current.brda.push(Number(value.split(",")[3]) || 0);
      else if (key === "FNDA") current.fnda.push(Number(value.split(",")[0]));
    }
  }
  return files;
}

function scopeRows(scope, measured, baseDir, language) {
  return scope.map((file) => {
    const found = measured.get(file);
    if (found) return { file, missing: false, ...found };
    return { file, missing: true, ...estimateMissing(join(baseDir, file), language) };
  });
}

function total(rows, metric) {
  if (rows.length > 0 && rows.every((row) => row[metric] === null)) return null;
  return rows.reduce(
    (sum, row) => (row[metric] ? counter(sum.total + row[metric].total, sum.covered + row[metric].covered) : sum),
    counter(0, 0),
  );
}

function excludedBy(component) {
  const entries = exclusions[component] ?? {};
  for (const [file, reason] of Object.entries(entries)) {
    if (typeof reason !== "string" || reason.trim() === "") throw new Error(`exclusion ${component}:${file} has no written reason`);
  }
  return new Set(Object.keys(entries));
}

function gatesTmp() {
  const dir = resolve(process.env.CCHUB_GATES_TMP ?? join(tmpdir(), "cchub-gates"));
  if (isInside(root, dir)) throw new Error(`gate TMP ${dir} must be outside the repo`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runNodeSuite({ name, cwd, testFiles, testGlob, includes, scope, importTsx, notes, concurrency }) {
  const coverageDir = join(cwd, "coverage");
  const lcovPath = join(coverageDir, "lcov.info");
  rmSync(lcovPath, { force: true });
  mkdirSync(coverageDir, { recursive: true });
  let testsOk = true;
  let testNote = `${testFiles.length} test files`;
  if (testFiles.length === 0) {
    testNote = `no test files matching ${testGlob}`;
  } else {
    const tmp = gatesTmp();
    const args = [
      ...(importTsx ? ["--import", "tsx"] : []),
      "--test",
      `--test-concurrency=${concurrency}`,
      "--experimental-test-coverage",
      ...includes.map((glob) => `--test-coverage-include=${glob}`),
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${posix(relative(cwd, lcovPath))}`,
      testGlob,
    ];
    console.log(`\n[${name}] node ${args.join(" ")}  (cwd ${posix(relative(root, cwd)) || "."}, TMP ${tmp})`);
    const result = spawnSync(process.execPath, args, {
      cwd,
      stdio: "inherit",
      env: { ...process.env, TMP: tmp, TEMP: tmp, TMPDIR: tmp, HUB_SHARE_PORT: "0" },
    });
    testsOk = result.status === 0;
    if (!testsOk) testNote += `, node --test exited ${result.status ?? result.signal}`;
  }
  const measured = existsSync(lcovPath) ? parseLcov(readFileSync(lcovPath, "utf8"), cwd) : new Map();
  return {
    name,
    rows: scopeRows(scope, measured, cwd, "js"),
    testsOk,
    notes: [testNote, ...notes],
  };
}

function runServer(options) {
  const cwd = join(root, "apps/server");
  const excluded = excludedBy("server");
  const scope = [
    ...walk(join(cwd, "src"), (file) => file.endsWith(".ts") && !file.endsWith(".d.ts")).map((file) => `src/${file}`),
    ...walk(join(cwd, "hooks"), (file) => !file.includes("/") && file.endsWith(".mjs")).map((file) => `hooks/${file}`),
  ].filter((file) => !excluded.has(file));
  return runNodeSuite({
    name: "server",
    cwd,
    testFiles: walk(join(cwd, "test"), (file) => file.endsWith(".test.ts")),
    testGlob: "test/**/*.test.ts",
    includes: ["src/**/*.ts", "hooks/*.mjs"],
    scope,
    importTsx: true,
    concurrency: options.concurrency,
    notes: ["statements = lines (node:test coverage reports no statement counts)"],
  });
}

function runVscodeExt(options) {
  const cwd = join(root, "apps/vscode-ext");
  const excluded = excludedBy("vscode-ext");
  return runNodeSuite({
    name: "vscode-ext",
    cwd,
    testFiles: walk(join(cwd, "test"), (file) => !file.includes("/") && file.endsWith(".test.mjs")),
    testGlob: "test/*.test.mjs",
    includes: ["extension.js"],
    scope: ["extension.js"].filter((file) => !excluded.has(file)),
    importTsx: false,
    concurrency: options.concurrency,
    notes: ["statements = lines (node:test coverage reports no statement counts)"],
  });
}

function runUi() {
  const cwd = join(root, "apps/ui");
  const coverageDir = join(cwd, "coverage");
  const resultsPath = join(coverageDir, "test-results.json");
  const summaryPath = join(coverageDir, "coverage-summary.json");
  rmSync(summaryPath, { force: true });
  rmSync(resultsPath, { force: true });
  const args = ["run", "coverage", "--", "--maxWorkers=2", "--reporter=default", "--reporter=json", `--outputFile.json=${posix(relative(cwd, resultsPath))}`];
  console.log(`\n[ui] npm ${args.join(" ")}  (cwd apps/ui)`);
  const result = spawnSync("npm", args, { cwd, stdio: "inherit", shell: isWindows });
  const notes = [];
  let testsOk = result.status === 0;
  if (existsSync(resultsPath)) {
    const results = JSON.parse(readFileSync(resultsPath, "utf8"));
    testsOk = results.numFailedTests === 0 && results.numFailedTestSuites === 0;
    notes.push(`${results.numTotalTests} tests in ${results.testResults.length} files, ${results.numFailedTests} failed`);
  } else {
    notes.push(`vitest exited ${result.status ?? result.signal} without a results file`);
  }
  const measured = new Map();
  if (existsSync(summaryPath)) {
    const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
    for (const [file, data] of Object.entries(summary)) {
      if (file === "total") continue;
      measured.set(posix(relative(cwd, file)), {
        lines: counter(data.lines.total, data.lines.covered),
        branches: counter(data.branches.total, data.branches.covered),
        functions: counter(data.functions.total, data.functions.covered),
        statements: counter(data.statements.total, data.statements.covered),
      });
    }
  }
  const excluded = excludedBy("ui");
  const scope = walk(
    join(cwd, "src"),
    (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith(".d.ts") && !/\.test\.tsx?$/.test(file) && !file.startsWith("test-support/"),
  )
    .map((file) => `src/${file}`)
    .filter((file) => !excluded.has(file));
  const processFailure = result.status === 0 ? null : `vitest exited ${result.status ?? result.signal}`;
  return { name: "ui", rows: scopeRows(scope, measured, cwd, "js"), testsOk, notes, processFailure };
}

function rustTools() {
  const sysroot = spawnSync("rustc", ["--print", "sysroot"], { encoding: "utf8" });
  const version = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (sysroot.status !== 0 || version.status !== 0) throw new Error("rustc not found on PATH");
  const host = /^host:\s*(\S+)/m.exec(version.stdout)?.[1];
  if (!host) throw new Error("could not read the rustc host triple");
  const bin = join(sysroot.stdout.trim(), "lib", "rustlib", host, "bin");
  const exe = isWindows ? ".exe" : "";
  const tools = { profdata: join(bin, `llvm-profdata${exe}`), cov: join(bin, `llvm-cov${exe}`) };
  if (!existsSync(tools.profdata) || !existsSync(tools.cov)) {
    throw new Error(`llvm tools not found in ${bin}; run: rustup component add llvm-tools-preview`);
  }
  return tools;
}

function runDesktop() {
  const crate = join(root, "apps/desktop/src-tauri");
  const notes = [
    "statements = regions (llvm source-based coverage)",
    "branches n/a: stable rustc has no branch coverage (-Z coverage-options=branch is nightly-only)",
  ];
  const excluded = excludedBy("desktop");
  const scope = walk(join(crate, "src"), (file) => !file.includes("/") && file.endsWith(".rs"))
    .map((file) => `src/${file}`)
    .filter((file) => !excluded.has(file));
  const fail = (message) => ({ name: "desktop", rows: scopeRows(scope, new Map(), crate, "rust"), testsOk: false, notes: [message, ...notes] });
  let tools;
  try {
    tools = rustTools();
  } catch (error) {
    return fail(error.message);
  }
  const targetDir = resolve(process.env.CCHUB_COV_CARGO_TARGET_DIR ?? join(root, ".tmp/cargo-cov"));
  if (isInside(resolve(crate, "target"), targetDir)) {
    return fail(`CARGO_TARGET_DIR ${targetDir} must not be the release target dir`);
  }
  const profDir = join(targetDir, "profraw");
  rmSync(profDir, { recursive: true, force: true });
  mkdirSync(join(profDir, "build"), { recursive: true });
  mkdirSync(join(profDir, "test"), { recursive: true });
  const env = { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: "-C instrument-coverage" };
  delete env.CARGO_ENCODED_RUSTFLAGS;
  const buildArgs = ["test", "--lib", "--no-run", "--message-format=json-render-diagnostics"];
  console.log(`\n[desktop] cargo ${buildArgs.join(" ")}  (cwd apps/desktop/src-tauri, CARGO_TARGET_DIR ${targetDir}, RUSTFLAGS -C instrument-coverage)`);
  const build = spawnSync("cargo", buildArgs, {
    cwd: crate,
    env: { ...env, LLVM_PROFILE_FILE: join(profDir, "build", "build-%p-%m.profraw") },
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (build.status !== 0) return fail(`cargo test --no-run exited ${build.status ?? build.signal}`);
  const binaries = build.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
    .filter((message) => message.reason === "compiler-artifact" && message.profile?.test && message.executable)
    .map((message) => message.executable);
  if (binaries.length === 0) return fail("cargo produced no test binary");
  let testsOk = true;
  for (const binary of binaries) {
    console.log(`[desktop] ${posix(relative(root, binary))}`);
    const run = spawnSync(binary, [], {
      cwd: crate,
      stdio: "inherit",
      env: { ...env, LLVM_PROFILE_FILE: join(profDir, "test", "test-%p-%m.profraw") },
    });
    if (run.status !== 0) testsOk = false;
  }
  const profraws = readdirSync(join(profDir, "test")).filter((file) => file.endsWith(".profraw")).map((file) => join(profDir, "test", file));
  if (profraws.length === 0) return fail("the test run wrote no .profraw file");
  const merged = join(profDir, "merged.profdata");
  const merge = spawnSync(tools.profdata, ["merge", "-sparse", ...profraws, "-o", merged], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (merge.status !== 0) return fail(`llvm-profdata merge exited ${merge.status}`);
  const exportArgs = ["export", "-summary-only", `-instr-profile=${merged}`, binaries[0], ...binaries.slice(1).flatMap((binary) => ["-object", binary])];
  const exported = spawnSync(tools.cov, exportArgs, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] });
  if (exported.status !== 0) return fail(`llvm-cov export exited ${exported.status}`);
  const measured = new Map();
  for (const entry of JSON.parse(exported.stdout).data?.[0]?.files ?? []) {
    const file = posix(relative(crate, resolve(entry.filename)));
    const summary = entry.summary;
    measured.set(file, {
      lines: counter(summary.lines.count, summary.lines.covered),
      branches: null,
      functions: counter(summary.functions.count, summary.functions.covered),
      statements: counter(summary.regions.count, summary.regions.covered),
    });
  }
  return { name: "desktop", rows: scopeRows(scope, measured, crate, "rust"), testsOk, notes: [`${binaries.length} test binary`, ...notes] };
}

function evaluate(result) {
  const totals = Object.fromEntries(METRICS.map((metric) => [metric, total(result.rows, metric)]));
  const failures = [];
  if (!result.testsOk) failures.push("tests");
  for (const metric of METRICS) {
    const value = pct(totals[metric]);
    if (value !== null && value < TARGETS[metric]) failures.push(`${metric} ${value.toFixed(2)} < ${TARGETS[metric]}`);
  }
  if (result.rows.length === 0) failures.push("empty scope");
  if (failures.length === 0 && result.processFailure) failures.push(result.processFailure);
  return { ...result, totals, missing: result.rows.filter((row) => row.missing).length, failures, pass: failures.length === 0 };
}

function uncovered(row) {
  return row.lines.total - row.lines.covered;
}

function sortedRows(rows) {
  return [...rows].sort((a, b) => uncovered(b) - uncovered(a) || a.file.localeCompare(b.file));
}

function pad(cells, widths) {
  return cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ").trimEnd();
}

function printTable(header, body) {
  const widths = header.map((cell, i) => Math.max(String(cell).length, ...body.map((row) => String(row[i]).length)));
  console.log(pad(header, widths));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) console.log(pad(row, widths));
}

function metricCell(metric) {
  return metric ? `${fmtPct(metric)} (${metric.covered}/${metric.total})` : "n/a";
}

function printComponent(result, withFiles) {
  console.log(`\n== ${result.name}: ${result.pass ? "PASS" : "FAIL"} ==`);
  printTable(
    ["metric", "coverage", "target"],
    METRICS.map((metric) => [metric, metricCell(result.totals[metric]), result.totals[metric] ? `${TARGETS[metric]}%` : "n/a"]),
  );
  console.log(`files: ${result.rows.length} in scope, ${result.missing} MISSING (never loaded: counted as uncovered with estimated totals)`);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const row of result.rows.filter((item) => item.missing)) console.log(`MISSING ${row.file} (${row.lines.total} lines)`);
  if (!result.pass) console.log(`failed: ${result.failures.join("; ")}`);
  if (withFiles) {
    console.log("");
    printTable(
      ["file", "lines", "branches", "functions", "uncovered lines"],
      sortedRows(result.rows).map((row) => [`${row.file}${row.missing ? " (MISSING)" : ""}`, fmtPct(row.lines), fmtPct(row.branches), fmtPct(row.functions), uncovered(row)]),
    );
  }
}

function summaryRow(result) {
  return [
    result.name,
    fmtPct(result.totals.lines),
    fmtPct(result.totals.branches),
    fmtPct(result.totals.functions),
    fmtPct(result.totals.statements),
    result.rows.length,
    result.missing,
    result.testsOk ? "ok" : "FAILED",
    result.pass ? "PASS" : "FAIL",
  ];
}

const SUMMARY_HEADER = ["component", "lines", "branches", "functions", "statements", "files", "missing", "tests", "verdict"];

function markdown(results) {
  const row = (cells) => `| ${cells.join(" | ")} |`;
  const out = [
    "# Coverage report",
    "",
    `Generated ${new Date().toISOString()} by \`node scripts/coverage.mjs\`. Targets: lines ${TARGETS.lines}, branches ${TARGETS.branches}, functions ${TARGETS.functions}, statements ${TARGETS.statements}.`,
    "",
    row(SUMMARY_HEADER),
    row(SUMMARY_HEADER.map(() => "---")),
    ...results.map((result) => row(summaryRow(result))),
    "",
  ];
  for (const result of results) {
    out.push(`## ${result.name}`, "");
    for (const metric of METRICS) out.push(`- ${metric}: ${metricCell(result.totals[metric])}`);
    for (const note of result.notes) out.push(`- note: ${note}`);
    if (!result.pass) out.push(`- failed: ${result.failures.join("; ")}`);
    out.push("", row(["file", "lines", "branches", "functions", "uncovered lines"]), row(["---", "---", "---", "---", "---"]));
    for (const item of sortedRows(result.rows)) {
      out.push(row([`${item.file}${item.missing ? " (MISSING)" : ""}`, fmtPct(item.lines), fmtPct(item.branches), fmtPct(item.functions), uncovered(item)]));
    }
    out.push("");
  }
  return out.join("\n");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`coverage: ${error.message}`);
    usage();
    process.exit(2);
  }
  const selected = options.only.length > 0 ? COMPONENTS.filter((name) => options.only.includes(name)) : COMPONENTS;
  const runners = { ui: runUi, server: runServer, "vscode-ext": runVscodeExt, desktop: runDesktop };
  const results = selected.map((name) => evaluate(runners[name](options)));
  for (const result of results) printComponent(result, options.files);
  console.log("");
  printTable(SUMMARY_HEADER, results.map(summaryRow));
  if (options.markdown) {
    mkdirSync(dirname(options.markdown), { recursive: true });
    writeFileSync(options.markdown, `${markdown(results)}\n`);
    console.log(`\nmarkdown report: ${options.markdown}`);
  }
  const failed = results.filter((result) => !result.pass);
  console.log(`\ncoverage gate: ${failed.length === 0 ? "PASS" : `FAIL (${failed.map((result) => result.name).join(", ")})`}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
