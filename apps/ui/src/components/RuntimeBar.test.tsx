import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { runtimeSnapshot } from "../test-support/u4-fixtures";
import { RuntimeBar, RuntimeChip } from "./RuntimeBar";

const snapshot = runtimeSnapshot;

const base = { claudeSessions: 0, codexSessions: 0, hubRunning: 0, hubAttention: 0 };

describe("RuntimeChip", () => {
  it("renders a plain chip with its title when there is no click handler", () => {
    render(<RuntimeChip label="Codex app" on detail="open" />);
    const chip = screen.getByTitle("Codex app: open");
    expect(chip.tagName).toBe("SPAN");
    expect(chip.className).toContain("runtime--on");
    expect(chip.className).not.toContain("runtime--button");
  });

  it("renders a button chip that calls onClick and carries the tone", () => {
    const onClick = vi.fn();
    render(<RuntimeChip label="Delegated" on={false} detail="idle" onClick={onClick} tone="warn" />);
    const chip = screen.getByRole("button");
    expect(chip.className).toContain("runtime--button");
    expect(chip.className).toContain("warn");
    expect(chip.className).not.toContain("runtime--on");
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("RuntimeBar", () => {
  it("shows a scanning chip while the snapshot is missing", () => {
    render(<RuntimeBar {...base} runtimes={null} claudeSessions={2} />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("scanning…")).toBeTruthy();
    expect(screen.queryByText("No agents running")).toBeNull();
  });

  it("lists the running runtimes with their counts", () => {
    const runtimes = snapshot({ claudeCode: { running: true, count: 1, pids: [], headless: 0 }, claudeDesktop: { running: true, count: 1, pids: [] }, codexApp: { running: true, count: 1, pids: [] }, codexCli: { running: true, count: 2, pids: [] } });
    render(<RuntimeBar {...base} runtimes={runtimes} claudeSessions={3} codexSessions={4} />);
    expect(screen.getByText("3 live · 1 process")).toBeTruthy();
    expect(screen.getByText("Claude Desktop")).toBeTruthy();
    expect(screen.getByText("open · 4 threads")).toBeTruthy();
    expect(screen.getByText("2 running")).toBeTruthy();
  });

  it("opens the hub from the delegated chip", () => {
    const onOpenHub = vi.fn();
    render(<RuntimeBar {...base} runtimes={snapshot()} hubRunning={2} hubAttention={1} delegatedOn onOpenHub={onOpenHub} />);
    fireEvent.click(screen.getByRole("button", { name: /Delegated/ }));
    expect(onOpenHub).toHaveBeenCalledTimes(1);
    expect(screen.getByText("2 running · 1 need you")).toBeTruthy();
  });

  it("says no agents are running and surfaces the scan error", () => {
    render(<RuntimeBar {...base} runtimes={snapshot({ error: "scan blew up" })} />);
    expect(screen.getByText("No agents running")).toBeTruthy();
    expect(screen.getByText("scan blew up")).toBeTruthy();
  });
});
