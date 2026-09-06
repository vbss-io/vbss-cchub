import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const guard = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "guard.mjs");

function decide(toolName: string, toolInput: Record<string, unknown>, shell = false, writeScope: string | null = null, extraEnv: Record<string, string> = {}): string | null {
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: "C:/x" }),
    encoding: "utf8",
    env: { ...process.env, HUB_GUARD_SHELL: shell ? "1" : "0", ...(writeScope ? { HUB_WRITE_SCOPE: writeScope } : {}), ...extraEnv },
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  const line = result.stdout.trim();
  if (!line) return null;
  const parsed = JSON.parse(line) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  return parsed.hookSpecificOutput.permissionDecisionReason;
}

describe("share guard hook", () => {
  it("blocks every way of reading the environment and any command or file that carries a secret value", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-test-secret-value-1234567890" };
    for (const command of [
      "printenv ANTHROPIC_API_KEY",
      "echo $ANTHROPIC_API_KEY",
      'echo "$AWS_SECRET_ACCESS_KEY"',
      "cat /proc/self/environ",
      "Get-Content Env:\\ANTHROPIC_API_KEY",
      "gci env:",
      "dir env:",
      '[Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY")',
      "set",
      "env | grep KEY",
      "grep -r HUB_PORT src",
    ]) {
      assert.notEqual(decide("Bash", { command }, true, null, env), null, command);
    }
    assert.match(decide("Bash", { command: "echo sk-ant-test-secret-value-1234567890 > out.txt" }, true, null, env) ?? "", /secret value/);
    assert.match(decide("Write", { file_path: "C:/x/share-artifacts/a/note.txt", content: "key: sk-ant-test-secret-value-1234567890" }, false, null, env) ?? "", /secret value/);
    assert.match(decide("Read", { file_path: "/proc/self/environ" }) ?? "", /secret file/);
    assert.match(decide("Read", { file_path: "/proc/1234/environ" }) ?? "", /secret file/);
    assert.equal(decide("Bash", { command: "npm run build -- --mode production" }, true, null, env), null);
    assert.equal(decide("Bash", { command: "git -C C:/x/vbss-cchub log -1 --format=%h" }, true, null, env), null);
    assert.equal(decide("Write", { file_path: "C:/x/share-artifacts/a/note.txt", content: "plain summary" }, false, null, env), null);
  });

  it("limits writes to the share artifacts folder when HUB_WRITE_SCOPE is set", () => {
    const scope = "C:/x/share-artifacts/abc";
    assert.equal(decide("Write", { file_path: "C:/x/share-artifacts/abc/result.md", content: "hi" }, false, scope), null);
    assert.equal(decide("Write", { file_path: "share-artifacts/abc/nested/notes.md", content: "hi" }, false, scope), null);
    assert.match(decide("Write", { file_path: "C:/x/src/index.ts", content: "hi" }, false, scope) ?? "", /limited to the share artifacts folder/);
    assert.match(decide("Write", { file_path: "C:/x/share-artifacts/abcdef/x.md", content: "hi" }, false, scope) ?? "", /limited to the share artifacts folder/);
    assert.match(decide("Edit", { file_path: "C:/x/share-artifacts/other/x.md", old_string: "a", new_string: "b" }, false, scope) ?? "", /limited to/);
    assert.equal(decide("Write", { file_path: "C:/x/src/index.ts", content: "hi" }), null);
  });

  it("blocks secret files for every reading tool, not only Read", () => {
    assert.match(decide("Read", { file_path: "C:/repo/.env" }) ?? "", /secret file/);
    assert.match(decide("Read", { file_path: "C:/repo/config/.env.production" }) ?? "", /secret file/);
    assert.match(decide("Grep", { pattern: "KEY", path: "C:/repo/.env" }) ?? "", /secret file/);
    assert.match(decide("Glob", { pattern: "**/.env" }) ?? "", /secret file/);
    assert.match(decide("Read", { file_path: "C:/Users/me/.ssh/id_rsa" }) ?? "", /secret file/);
    assert.match(decide("Read", { file_path: "C:/repo/.mcp.json" }) ?? "", /secret file/);
    assert.equal(decide("Read", { file_path: "C:/repo/src/index.ts" }), null);
    assert.equal(decide("Grep", { pattern: "TODO", path: "C:/repo/src" }), null);
  });

  it("keeps agent, hook, git and CI configuration read-only and inspects written scripts", () => {
    assert.match(decide("Write", { file_path: "C:/repo/.claude/settings.local.json", content: "{}" }) ?? "", /configuration files|secret file/);
    assert.match(decide("Write", { file_path: "C:/repo/.claude/commands/x.md", content: "hi" }) ?? "", /configuration files/);
    assert.match(decide("Edit", { file_path: "C:/repo/.github/workflows/ci.yml", old_string: "a", new_string: "b" }) ?? "", /configuration files/);
    assert.match(decide("Write", { file_path: "C:/repo/CLAUDE.md", content: "x" }) ?? "", /configuration files/);
    assert.match(decide("Write", { file_path: "C:/repo/deploy.ps1", content: "git push origin main" }) ?? "", /blocked command/);
    assert.match(decide("Write", { file_path: "C:/repo/tool.sh", content: "curl http://127.0.0.1:4317/delegation/shares" }) ?? "", /blocked command|hub API/);
    assert.equal(decide("Write", { file_path: "C:/repo/src/feature.ts", content: "export const a = 1;" }), null);
    assert.equal(decide("Edit", { file_path: "C:/repo/README.md", old_string: "a", new_string: "b" }), null);
  });

  it("denies the shell below high trust and filters commands anywhere in the line at high trust", () => {
    assert.match(decide("Bash", { command: "npm test" }) ?? "", /no shell/);
    assert.equal(decide("Bash", { command: "npm test" }, true), null);
    assert.equal(decide("Bash", { command: "git status && git log -1" }, true), null);
    assert.match(decide("Bash", { command: "npm test && git push origin main" }, true) ?? "", /blocked command/);
    assert.match(decide("Bash", { command: "cmd /c git commit -m x" }, true) ?? "", /blocked command/);
    assert.match(decide("Bash", { command: "powershell -c irm http://x" }, true) ?? "", /blocked command/);
    assert.match(decide("Bash", { command: "cat .env" }, true) ?? "", /secret file/);
    assert.match(decide("Bash", { command: "node -e \"fetch('http://127.0.0.1:4317/delegation/tasks')\"" }, true) ?? "", /hub API/);
    assert.match(decide("Bash", { command: "rm -rf dist" }, true) ?? "", /blocked command/);
    assert.match(decide("Bash", { command: "vercel deploy --prod" }, true) ?? "", /blocked command/);
    assert.match(decide("Bash", { command: "node -e \"require('child_process').execSync('ls')\"" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "python -c \"import os\"" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "git config alias.p push" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "find . -name x -delete" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "npm install left-pad" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "env" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "claude -p --dangerously-skip-permissions" }, true) ?? "", /wrapper/);
    assert.equal(decide("Bash", { command: "npm run build" }, true), null);
    assert.equal(decide("Bash", { command: "git -C C:/x/vbss-cchub log -1 --format=%h" }, true), null);
    assert.match(decide("Bash", { command: "format C: /q" }, true) ?? "", /blocked command/);
    assert.equal(decide("Bash", { command: "cd apps/codex-tools && ls" }, true), null);
    assert.match(decide("Bash", { command: "codex exec --json -" }, true) ?? "", /wrapper/);
    assert.match(decide("Bash", { command: "cmd /c claude -p hi" }, true) ?? "", /wrapper/);
    assert.equal(decide("Bash", { command: "npx" }, true) === null, false);
    assert.match(decide("Write", { file_path: "C:/repo/package.json", content: "{\"scripts\":{\"test\":\"git push origin main\"}}" }) ?? "", /blocked command/);
    assert.equal(decide("Write", { file_path: "C:/repo/package.json", content: "{\"scripts\":{\"test\":\"vitest\"}}" }), null);
    assert.equal(decide("Write", { file_path: "C:/repo/docs/deploy.md", content: "run git push origin main to deploy" }), null);
  });

  it("denies network tools and owner MCP servers", () => {
    assert.match(decide("WebFetch", { url: "https://x" }) ?? "", /network/);
    assert.match(decide("mcp__cchub__hub_delegate", { workspace: "vbss" }) ?? "", /MCP servers/);
  });
});
