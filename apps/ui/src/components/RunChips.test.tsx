import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { claudeClient, codexClient, sessionClient } from "../clients";
import { CtxMeter, ctxLevel, RunChip, RunFoot, RunMeta, RunStatus, RunWhy, shortClientName } from "./RunChips";

describe("shortClientName", () => {
  it("maps families to short names and keeps Share", () => {
    expect(shortClientName(claudeClient("terminal"))).toBe("Claude");
    expect(shortClientName(codexClient("codex-app"))).toBe("Codex");
    expect(shortClientName(claudeClient("hub"))).toBe("Hub");
    expect(shortClientName(sessionClient({ client: "share", shareLabel: "Ana" }))).toBe("Share");
  });
});

describe("ctxLevel", () => {
  it("buckets the context percentage", () => {
    expect(ctxLevel(10)).toBe("ok");
    expect(ctxLevel(59.9)).toBe("ok");
    expect(ctxLevel(60)).toBe("warn");
    expect(ctxLevel(84)).toBe("warn");
    expect(ctxLevel(85)).toBe("high");
  });
});

describe("run chip parts", () => {
  it("RunChip shows the label with the client icon name and title", () => {
    render(<RunChip info={codexClient("codex-cli")} label="Thread" title="a thread" />);
    expect(screen.getByTitle("a thread").className).toContain("chip--run-codex");
    expect(screen.getByRole("img", { name: "Codex CLI" })).toBeTruthy();
    expect(screen.getByText("Thread")).toBeTruthy();
  });

  it("RunStatus renders the label with its tone class", () => {
    render(<RunStatus tone="hold" label="Needs you" />);
    expect(screen.getByText("Needs you").className).toContain("rc__status--hold");
  });

  it("RunMeta renders parts and the extras count", () => {
    render(<RunMeta client={claudeClient("vscode")} parts={[{ key: "a", text: "api" }, { key: "b", text: "main", title: "branch main" }]} extras={["one", "two"]} />);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("api").getAttribute("title")).toBe("api");
    expect(screen.getByText("main").getAttribute("title")).toBe("branch main");
    const extras = screen.getByRole("note");
    expect(extras.textContent).toBe("+2");
    expect(extras.getAttribute("aria-label")).toBe("2 more: one, two");
  });

  it("RunMeta without extras has no more marker and honours a client title", () => {
    render(<RunMeta client={claudeClient("terminal")} clientTitle="custom" parts={[]} extras={[]} />);
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByTitle("custom")).toBeTruthy();
  });

  it("RunWhy puts the detail in the title only when present", () => {
    const { container, rerender } = render(<RunWhy tone="go" headline="Done" detail="all green" />);
    expect(container.querySelector(".rc__why")?.getAttribute("title")).toBe("Done\nall green");
    rerender(<RunWhy tone="go" headline="Done" detail={null} />);
    expect(container.querySelector(".rc__why")?.getAttribute("title")).toBe("Done");
  });

  it("CtxMeter clamps the bar width to at least 4 percent and rounds the label", () => {
    const { container, rerender } = render(<CtxMeter pct={1.2} title="ctx" />);
    expect((container.querySelector(".rc__fill") as HTMLElement).style.width).toBe("4%");
    expect(screen.getByTitle("ctx").textContent).toBe("1%");
    rerender(<CtxMeter pct={86.6} title="ctx" />);
    expect(screen.getByTitle("ctx").getAttribute("data-level")).toBe("high");
    expect((container.querySelector(".rc__fill") as HTMLElement).style.width).toBe("87%");
  });

  it("RunFoot renders actions only when given", () => {
    const { container, rerender } = render(<RunFoot>facts</RunFoot>);
    expect(container.querySelector(".rc__acts")).toBeNull();
    rerender(<RunFoot actions={<button>Go</button>}>facts</RunFoot>);
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
  });
});
