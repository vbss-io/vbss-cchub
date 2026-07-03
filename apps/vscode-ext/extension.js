const vscode = require("vscode");
const os = require("os");
const path = require("path");
const fs = require("fs");

const LOG = path.join(os.homedir(), ".claude-code-hub", "ext-focus.log");

async function terminalSnapshot() {
  const terms = [];
  for (const terminal of vscode.window.terminals) {
    terms.push({ name: terminal.name, pid: await terminal.processId });
  }
  return terms;
}

function logMiss(pid, terminals) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid, terminals }) + "\n");
  } catch {
    /* ignore */
  }
}

async function focusTerminalByPid(pid) {
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) === pid) {
      terminal.show(false);
      return true;
    }
  }
  return false;
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        const pid = Number(new URLSearchParams(uri.query).get("pid"));
        if (!Number.isInteger(pid) || pid <= 0) return;
        if (!(await focusTerminalByPid(pid))) logMiss(pid, await terminalSnapshot());
      },
    }),
    vscode.commands.registerCommand("cchFocus.listTerminals", async () => {
      const terminals = await terminalSnapshot();
      await vscode.window.showInformationMessage(
        terminals.length
          ? terminals.map((t) => `${t.name} → pid ${t.pid}`).join("   |   ")
          : "No terminals open",
        { modal: false },
      );
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
