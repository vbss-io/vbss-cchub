import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { claudeClient, ClientBadge, codexClient, isHubRun, sessionClient } from "./clients";

test("claudeClient labels every known client and falls back to a plain Claude Code label", () => {
  expect(claudeClient("terminal")).toMatchObject({ label: "Claude Code · terminal", family: "claude" });
  expect(claudeClient("vscode")).toMatchObject({ label: "Claude Code · VS Code", family: "claude" });
  expect(claudeClient("claude-desktop")).toMatchObject({ label: "Claude Desktop", family: "claude" });
  expect(claudeClient("wsl")).toMatchObject({ label: "Claude Code · WSL", family: "claude" });
  expect(claudeClient("headless")).toMatchObject({ label: "Claude Code · headless", family: "hub" });
  expect(claudeClient("hub")).toMatchObject({ label: "Hub run", family: "hub" });
  expect(claudeClient("share")).toMatchObject({ label: "Share", family: "hub" });
  expect(claudeClient("unknown")).toMatchObject({ label: "Claude Code", family: "claude" });
  expect(claudeClient(null)).toMatchObject({ label: "Claude Code", family: "claude" });
  expect(claudeClient(undefined)).toMatchObject({ label: "Claude Code", family: "claude" });
});

test("codexClient labels every Codex surface", () => {
  expect(codexClient("codex-app")).toMatchObject({ label: "Codex app", family: "codex" });
  expect(codexClient("codex-cli")).toMatchObject({ label: "Codex CLI", family: "codex" });
  expect(codexClient("codex-exec")).toMatchObject({ label: "Codex exec", family: "codex" });
  expect(codexClient("codex-vscode")).toMatchObject({ label: "Codex · VS Code", family: "codex" });
});

test("sessionClient names a share session after its label and leaves other clients alone", () => {
  expect(sessionClient({ client: "share", shareLabel: "Ana" }).label).toBe("Share · Ana");
  expect(sessionClient({ client: "share", shareLabel: null }).label).toBe("Share");
  expect(sessionClient({ client: "terminal", shareLabel: "Ana" }).label).toBe("Claude Code · terminal");
  expect(sessionClient({}).label).toBe("Claude Code");
});

test("isHubRun is true for hub, headless and share clients only", () => {
  expect(isHubRun("hub")).toBe(true);
  expect(isHubRun("headless")).toBe(true);
  expect(isHubRun("share")).toBe(true);
  expect(isHubRun("terminal")).toBe(false);
  expect(isHubRun(null)).toBe(false);
  expect(isHubRun(undefined)).toBe(false);
});

test("ClientBadge shows the icon and label with the family class and a title", () => {
  const { container } = render(<ClientBadge info={codexClient("codex-cli")} />);
  const badge = container.querySelector(".client");
  expect(badge?.classList.contains("client--codex")).toBe(true);
  expect(badge?.getAttribute("title")).toBe("Codex CLI");
  expect(badge?.querySelector("svg")).not.toBeNull();
  expect(screen.getByText("Codex CLI")).toBeTruthy();
});
