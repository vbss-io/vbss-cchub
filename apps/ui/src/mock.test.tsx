import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.resetModules();
});

test("isMock follows the mock query parameter", async () => {
  vi.resetModules();
  expect((await import("./mock")).isMock).toBe(false);
  window.history.replaceState(null, "", "/?mock");
  vi.resetModules();
  expect((await import("./mock")).isMock).toBe(true);
});

test("the mock sessions cover waiting, idle and active states with unique ids", async () => {
  const { MOCK_SESSIONS } = await import("./mock");
  expect(MOCK_SESSIONS).toHaveLength(7);
  expect(new Set(MOCK_SESSIONS.map((session) => session.sessionId)).size).toBe(7);
  expect(new Set(MOCK_SESSIONS.map((session) => session.status))).toEqual(new Set(["waiting", "idle", "active"]));
  const wsl = MOCK_SESSIONS.find((session) => session.sessionId === "s7-mock");
  expect(wsl).toMatchObject({ source: "wsl-Ubuntu-24.04", cwd: "/home/dev/build-pipeline" });
  const first = MOCK_SESSIONS[0];
  expect(first).toMatchObject({ source: "Desktop", archivedAt: null, tokensIn: 1_400_000, contextTokens: 190_000 });
  expect(first?.startedAt).toBe((first?.updatedAt ?? 0) - 3_600_000);
});

test("the mock groups match mock session folders in order", async () => {
  const { MOCK_GROUPS, MOCK_SESSIONS } = await import("./mock");
  expect(MOCK_GROUPS.map((group) => group.position)).toEqual([0, 1, 2, 3]);
  for (const group of MOCK_GROUPS) {
    expect(MOCK_SESSIONS.some((session) => (session.cwd ?? "").includes(group.match))).toBe(true);
  }
});
