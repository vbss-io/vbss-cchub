import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_APP_LOG;
const mode = process.env.FAKE_APP_MODE ?? "";
const record = (line) => {
  if (log) appendFileSync(log, `${line}\n`);
};
const reply = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

record(`start ${process.pid} ${process.argv.slice(2).join(" ")}`);

const snapshot = (used) => ({
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: used, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: used, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    },
    codex_other: {
      limitId: "codex_other",
      limitName: "codex_other",
      primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: Math.floor(Date.now() / 1000) + 1800 },
    },
  },
});

let reads = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  record(`method ${message.method}`);
  if (message.method === "initialize") {
    reply({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
    return;
  }
  if (message.method !== "account/rateLimits/read") return;
  reads += 1;
  reply({ id: message.id, result: snapshot(20 + reads) });
  if (mode === "push") {
    setTimeout(() => {
      reply({
        method: "account/rateLimits/updated",
        params: { rateLimits: { limitId: "codex", primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3000 } } },
      });
    }, 20);
  }
  if (mode === "die-after-read") setTimeout(() => process.exit(3), 20);
});
