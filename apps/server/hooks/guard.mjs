import { resolve, sep } from "node:path";

const SECRET_PATH = /(^|[\\/])(\.env(\.[^\\/]*)?|[^\\/]*\.(pem|key|pfx|p12)|id_rsa[^\\/]*|id_ed25519[^\\/]*|\.mcp\.json|\.claude\.json|settings\.local\.json|credentials[^\\/]*|hub\.token|hub\.db)$/i;
const PROC_ENV = /(^|[\\/])proc[\\/]([^\\/]+[\\/])?environ$|(^|[\\/])proc[\\/]self([\\/]|$)/i;
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;
const NOT_SECRET_NAME = /(URL|PATH|DIR|SOCK|FILE|NAME|SCOPE|LABEL|PORT|TARGET|MODE|SHELL|REGION|TYPE|PROMPTS|SDK|PROJECT_ID)$/i;
const SECRET_VALUES = Object.entries(process.env)
  .filter(([key, value]) => typeof value === "string" && value.length >= 12 && SECRET_NAME.test(key) && !NOT_SECRET_NAME.test(key))
  .map(([, value]) => value);
const SECRET_DIR = /[\\/]\.(ssh|aws|azure|gnupg)([\\/]|$)|[\\/]\.git[\\/]config$/i;
const CONFIG_WRITE = /(^|[\\/])(\.claude|\.github|\.husky|\.vscode|\.codex)([\\/]|$)|(^|[\\/])(CLAUDE\.md|AGENTS\.md|\.mcp\.json|settings(\.local)?\.json|\.gitattributes|\.gitmodules)$|[\\/]\.git([\\/]|$)/i;
const SECRET_MENTION = /\.env\b|\.pem\b|\bid_rsa|\bid_ed25519|\.mcp\.json|\.claude\.json|settings\.local\.json|hub\.token|hub\.db|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]/i;
const HUB_API = /(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):43(1[0-9]|[2-9][0-9])\b|\/delegation\/|hub_delegate|mcp\.cjs/i;
const DESTRUCTIVE = [
  /\bgit\s+(push|commit|reset|rebase|checkout|restore|clean|branch\s+-D|stash\s+drop|filter-branch|update-ref|reflog\s+expire)\b/i,
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r|-rf|-fr)\b/i,
  /\b(rmdir|rd)\b\s+\/s/i,
  /\bdel\b\s+.*\/[sq]/i,
  /\bRemove-Item\b.*-Recurse/i,
  /(^|[\s;&|(`])(format|diskpart|mkfs(\.\w+)?|shutdown|reboot)(\.exe|\.com)?(\s|$)/i,
  /\b(npm|pnpm|yarn)\s+publish\b/i,
  /\bnpm\s+install\s+(-g|--global)\b/i,
  /\b(vercel|az|kubectl|helm|docker|terraform|pulumi|gh\s+release|gh\s+pr\s+merge|gcloud|aws)\b/i,
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|certutil\s+-urlcache|bitsadmin)\b/i,
  /\b(ssh|scp|sftp|rsync|ftp|telnet|nc|ncat|netcat)\b/i,
  /\b(reg|regedit)\b\s+(add|delete|import)/i,
  /\b(schtasks|New-ScheduledTask|Register-ScheduledTask)\b/i,
  /\bpowershell\b.*-(enc|encodedcommand)\b/i,
];
const SHELL_ONLY = [
  /\b(node|nodejs|deno|bun|python3?|py|ruby|perl|php|pwsh|powershell|bash|sh|zsh|cmd)\b[^|&;\n]*\s-{1,2}(e|c|eval|command|encodedcommand|exec)\b/i,
  /\bcmd(\.exe)?\s+\/[ck]\b/i,
  /\bgit\s+config\b/i,
  /\bfind\b[^|&;\n]*\s-delete\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|exec|dlx|x)\b/i,
  /\b(npx|pipx?|pip3|uv|cargo\s+install|gem\s+install|choco|winget|scoop)\b/i,
  /(^|[\s;&|(`])(env|printenv|set)(\.exe)?(\s|$)/i,
  /\b(ANTHROPIC|AWS|GOOGLE|HUB|NGROK)_[A-Z0-9_]+\b/i,
  /\benv:/i,
  /GetEnvironmentVariable|\bEnvironment\]::|\bGet-ChildItem\s+env:|\$env:|\bprocess\.env\b|os\.environ/i,
  /[\\/]proc[\\/][^\s]*environ|\benviron\b/i,
  /(^|[\s;&|(`])(claude|codex|cchub)(\.exe|\.cmd)?(\s|$)/i,
  /share-artifacts[\\/]/i,
];
const SCRIPT_FILE = /\.(ps1|sh|bat|cmd|py|js|mjs|cjs|ts|rb|pl)$/i;
const CONFIG_FILE = /(^|[\\/])(package\.json|Makefile|justfile|Taskfile\.ya?ml|.*\.(ya?ml|toml)|.*\.config\.(js|cjs|mjs|ts))$/i;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `CC Hub share guard: ${reason}` } })}\n`,
  );
  process.exit(0);
}

const text = (value) => (typeof value === "string" ? value : "");

function insideScope(path, scope, base) {
  if (!path) return false;
  const target = resolve(base || process.cwd(), path).toLowerCase();
  const root = resolve(scope).toLowerCase();
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function checkPaths(input) {
  const paths = [input.file_path, input.path, input.notebook_path, input.pattern].map(text).filter(Boolean);
  for (const path of paths) {
    if (SECRET_PATH.test(path) || SECRET_DIR.test(path) || PROC_ENV.test(path)) return `secret file or folder (${path})`;
  }
  return null;
}

function checkContent(content, label) {
  if (!content) return null;
  if (SECRET_MENTION.test(content)) return `${label} mentions a secret file`;
  for (const value of SECRET_VALUES) if (content.includes(value)) return `${label} contains a secret value`;
  for (const rule of DESTRUCTIVE) if (rule.test(content)) return `${label} contains a blocked command (${rule.source.slice(0, 40)})`;
  if (HUB_API.test(content)) return `${label} targets the hub API`;
  return null;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.exit(0);
  }
  const tool = text(payload.tool_name);
  const input = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};
  const allowShell = process.env.HUB_GUARD_SHELL === "1";

  if (tool === "Read" || tool === "Grep" || tool === "Glob" || tool === "LS" || tool === "NotebookEdit") {
    const hit = checkPaths(input);
    if (hit) deny(hit);
  }
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const path = text(input.file_path) || text(input.notebook_path);
    if (SECRET_PATH.test(path) || SECRET_DIR.test(path)) deny(`secret file (${path})`);
    if (CONFIG_WRITE.test(path)) deny(`agent, hook, git or CI configuration files are read-only for shares (${path})`);
    const scope = text(process.env.HUB_WRITE_SCOPE);
    if (scope && !insideScope(path, scope, text(payload.cwd))) deny(`writes are limited to the share artifacts folder (${scope})`);
    const body = [text(input.content), text(input.new_string), ...(Array.isArray(input.edits) ? input.edits.map((edit) => text(edit && edit.new_string)) : [])].join("\n");
    if (body.length > 0) {
      const hit = checkContent(body, "written content");
      if (hit && (SCRIPT_FILE.test(path) || CONFIG_FILE.test(path) || /hub API|secret file|secret value/.test(hit))) deny(hit);
    }
  }
  if (tool === "Bash" || tool === "PowerShell") {
    if (!allowShell) deny("no shell at this trust level");
    const command = text(input.command);
    const hit = checkContent(command, "command");
    if (hit) deny(hit);
    for (const rule of SHELL_ONLY) if (rule.test(command)) deny(`command uses a blocked wrapper or installer (${rule.source.slice(0, 40)})`);
  }
  if (tool === "WebFetch" || tool === "WebSearch") deny("no network access for shares");
  if (tool.startsWith("mcp__")) deny("MCP servers of the owner are not available to shares");
  process.exit(0);
}

main();
