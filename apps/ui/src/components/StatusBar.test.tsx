import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { LimitsSnapshot } from "../delegation";
import { runtimeSnapshot } from "../test-support/u3-fixtures";
import { limitsDetail, providerLimits, StatusBar } from "./StatusBar";

const limits = (claude: number, codex: number): LimitsSnapshot => ({
  updatedAt: 1,
  claude: { source: "api", fiveHour: { utilization: claude, resetsAt: null }, sevenDay: { utilization: claude / 2, resetsAt: null }, models: [] },
  codex: { source: "rollout", primary: { usedPercent: codex, resetsAt: null }, secondary: { usedPercent: codex / 2, resetsAt: null } },
});

const baseProps = { runtimes: runtimeSnapshot(), claudeSessions: 2, codexSessions: 1, hubRunning: 0, hubAttention: 0, limits: null, limitsEnabled: false };

test("providerLimits rounds and clamps percentages and skips sources reported as none", () => {
  const rows = providerLimits(limits(140.4, -5));
  expect(rows.map((row) => row.provider)).toEqual(["claude", "codex"]);
  expect(rows[0]?.windows).toEqual({ fiveHour: 100, sevenDay: 70 });
  expect(rows[1]?.windows).toEqual({ fiveHour: 0, sevenDay: 0 });
  const none: LimitsSnapshot = { updatedAt: 1, claude: { source: "none", fiveHour: { utilization: 1, resetsAt: null }, sevenDay: { utilization: 1, resetsAt: null }, models: [] }, codex: null };
  expect(providerLimits(none)).toEqual([]);
  expect(providerLimits(null)).toEqual([]);
});

test("limitsDetail prints both windows", () => {
  expect(limitsDetail({ fiveHour: 12, sevenDay: 34 })).toBe("5h 12% · 7d 34%");
});

test("renders a status footer with the runtimes and no limits when limits are off", () => {
  render(<StatusBar {...baseProps} limits={limits(10, 10)} />);
  expect(screen.getByRole("contentinfo", { name: "Status" })).toBeTruthy();
  expect(screen.queryByLabelText("Plan limits")).toBeNull();
});

test("shows a chip per provider and flags a window at 80 percent or more", async () => {
  const onOpenUsage = vi.fn();
  render(<StatusBar {...baseProps} limitsEnabled limits={limits(90, 10)} onOpenUsage={onOpenUsage} />);
  const group = screen.getByLabelText("Plan limits");
  const claude = within(group).getByRole("button", { name: /Claude/ });
  const codex = within(group).getByRole("button", { name: /Codex/ });
  expect(claude.className).toContain("runtime--warn");
  expect(codex.className).not.toContain("runtime--warn");
  expect(claude.textContent).toContain("5h 90% · 7d 45%");
  await userEvent.click(codex);
  expect(onOpenUsage).toHaveBeenCalledTimes(1);
});

test("renders passive chips when no usage handler is given", () => {
  render(<StatusBar {...baseProps} limitsEnabled limits={limits(10, 10)} />);
  expect(within(screen.getByLabelText("Plan limits")).queryAllByRole("button")).toHaveLength(0);
});
