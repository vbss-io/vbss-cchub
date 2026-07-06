const vscode = require("vscode");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");

const HUB_URL = "http://127.0.0.1:4317/api/events";
const LOG = path.join(os.homedir(), ".vbss-cchub", "ext-focus.log");

let disposed = false;
let request = null;
let retryTimer = null;

function logMiss(pid, terminals) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), pid, terminals }) + "\n");
  } catch {
    /* ignore */
  }
}

async function terminalSnapshot() {
  const terms = [];
  for (const terminal of vscode.window.terminals) {
    terms.push({ name: terminal.name, pid: await terminal.processId });
  }
  return terms;
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

async function handleFocus(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!(await focusTerminalByPid(pid))) logMiss(pid, await terminalSnapshot());
}

function scheduleReconnect() {
  if (disposed || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, 5000);
}

function connect() {
  if (disposed) return;
  request = http.get(HUB_URL, (res) => {
    let buffer = "";
    let event = null;
    res.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          if (event === "focus-terminal") {
            try {
              void handleFocus(JSON.parse(line.slice(5)).shellPid);
            } catch {
              /* malformed event */
            }
          }
          event = null;
        }
      }
    });
    res.on("end", scheduleReconnect);
    res.on("error", scheduleReconnect);
  });
  request.on("error", scheduleReconnect);
}

function activate(context) {
  connect();
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      async handleUri(uri) {
        await handleFocus(Number(new URLSearchParams(uri.query).get("pid")));
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

function deactivate() {
  disposed = true;
  if (retryTimer) clearTimeout(retryTimer);
  if (request) request.destroy();
}

module.exports = { activate, deactivate };
