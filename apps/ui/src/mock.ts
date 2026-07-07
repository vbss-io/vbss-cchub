import type { GroupRecord, SessionRecord, SessionStatus } from "./types";

export const isMock =
  typeof location !== "undefined" && new URLSearchParams(location.search).has("mock");

const now = Date.now();
const min = (m: number) => now - m * 60_000;

interface Seed {
  id: string;
  status: SessionStatus;
  cwd: string;
  title: string;
  model: string;
  ctx: number;
  tin: number;
  tout: number;
  updated: number;
  source?: string;
  msg?: string;
}

const seeds: Seed[] = [
  { id: "s1", status: "waiting", cwd: "C:/work/api-gateway", title: "Refactor auth middleware", model: "claude-opus-4-8", ctx: 190_000, tin: 1_400_000, tout: 210_000, updated: min(1), msg: "Should I split the token guard into its own module?" },
  { id: "s2", status: "waiting", cwd: "C:/work/api-gateway/billing", title: "Payment webhook retries", model: "claude-opus-4-8", ctx: 640_000, tin: 3_100_000, tout: 480_000, updated: min(3), msg: "Waiting for your input" },
  { id: "s3", status: "idle", cwd: "C:/work/web-app", title: "Vector search tuning", model: "claude-sonnet-4-5", ctx: 152_000, tin: 220_000, tout: 60_000, updated: min(12), msg: "Done — ran 42 tests, all green." },
  { id: "s4", status: "active", cwd: "C:/work/web-app/landing", title: "Landing page polish", model: "claude-opus-4-8", ctx: 230_000, tin: 900_000, tout: 140_000, updated: min(0), msg: "Editing hero section…" },
  { id: "s5", status: "active", cwd: "C:/work/web-app", title: "Fix flaky e2e tests", model: "claude-haiku-4-5", ctx: 24_000, tin: 40_000, tout: 9_000, updated: min(0), msg: "Re-running the suite…" },
  { id: "s6", status: "idle", cwd: "C:/work/infra/db", title: "Migrate to Postgres 16", model: "claude-opus-4-8", ctx: 810_000, tin: 2_600_000, tout: 390_000, updated: min(6), msg: "Stopped — needs a schema decision." },
  { id: "s7", status: "active", cwd: "/home/dev/build-pipeline", title: "CI build pipeline", model: "claude-opus-4-8", ctx: 120_000, tin: 300_000, tout: 55_000, updated: min(0), source: "wsl-Ubuntu-24.04", msg: "Running the build…" },
];

const toSession = (s: Seed): SessionRecord => ({
  sessionId: `${s.id}-mock`,
  status: s.status,
  cwd: s.cwd,
  source: s.source ?? "Desktop",
  hostPid: 1234,
  title: s.title,
  customTitle: null,
  lastMessage: s.msg ?? null,
  model: s.model,
  tokensIn: s.tin,
  tokensOut: s.tout,
  contextTokens: s.ctx,
  archivedAt: null,
  startedAt: s.updated - 3_600_000,
  updatedAt: s.updated,
});

export const MOCK_SESSIONS: SessionRecord[] = seeds.map(toSession);

export const MOCK_GROUPS: GroupRecord[] = [
  { id: "g1", name: "API", match: "api-gateway", position: 0 },
  { id: "g2", name: "Web", match: "web-app", position: 1 },
  { id: "g3", name: "Infra", match: "infra", position: 2 },
  { id: "g4", name: "Infra", match: "build-pipeline", position: 3 },
];
