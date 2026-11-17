import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareFile, ShareRecord } from "../delegation";
import { NOW, shareRecord } from "../test-support/u4-fixtures";
import { bestLink, maskLink, ShareCard, untilText } from "./ShareCard";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "requestAnimationFrame", "cancelAnimationFrame"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("bestLink", () => {
  it("prefers the public link, then the LAN link, then the local one", () => {
    expect(bestLink(shareRecord({ links: { local: "L", lan: "N", public: "P" } }))).toEqual({ url: "P", kind: "public" });
    expect(bestLink(shareRecord({ links: { local: "L", lan: "N", public: null } }))).toEqual({ url: "N", kind: "lan" });
    expect(bestLink(shareRecord({ links: { local: "L", lan: null, public: null } }))).toEqual({ url: "L", kind: "local" });
  });
});

describe("maskLink", () => {
  it("hides the key value and leaves other URLs alone", () => {
    expect(maskLink("http://h/s/1?key=abc123&x=1")).toBe("http://h/s/1?key=••••••••&x=1");
    expect(maskLink("http://h/s/1")).toBe("http://h/s/1");
  });
});

describe("untilText", () => {
  it("formats minutes, hours and days and flags expired", () => {
    expect(untilText(NOW - 1)).toBe("expired");
    expect(untilText(NOW + 5 * 60_000)).toBe("in 5 min");
    expect(untilText(NOW + 3 * 3_600_000)).toBe("in 3 h");
    expect(untilText(NOW + 3 * 86_400_000)).toBe("in 3 days");
  });
});

const setup = (share: ShareRecord = shareRecord(), extra: Partial<Parameters<typeof ShareCard>[0]> = {}) => {
  const fns = { onSelect: vi.fn(), onCopy: vi.fn(), onManage: vi.fn() };
  const view = render(<ShareCard share={share} selected={false} files={undefined} {...fns} {...extra} />);
  return { fns, ...view };
};

const openMenu = () => fireEvent.click(screen.getByRole("button", { name: /^Actions for/ }));

describe("ShareCard", () => {
  it("shows the label, state, trust, workspace and activity and selects on click", () => {
    const { fns } = setup(shareRecord({ repo: "api", sessionId: "s1", uses: 3, lastUsedAt: NOW - 60_000, requestsLastHour: 2 }));
    expect(screen.getByText("Ana doubts")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("Low · read only")).toBeTruthy();
    expect(screen.getByText("api-ws / api")).toBeTruthy();
    expect(screen.getByText("continues a session")).toBeTruthy();
    expect(screen.getByText(/expires in 2 h/)).toBeTruthy();
    expect(screen.getByText(/3 requests · last 1m ago · 2\/20 this hour/)).toBeTruthy();
    fireEvent.click(screen.getByText("Ana doubts"));
    expect(fns.onSelect).toHaveBeenCalledWith("share-1");
  });

  it("shows never for a share without expiry and the selected class", () => {
    setup(shareRecord({ expiresAt: null }), { selected: true });
    expect(screen.getByText(/expires never · no requests yet/)).toBeTruthy();
    expect(screen.getByRole("article").className).toContain("card--sel");
  });

  it("copies the best link and keeps the key masked until revealed", () => {
    const { fns } = setup(shareRecord({ links: { local: "http://l/s?key=secret1", lan: null, public: "https://pub.example/s?key=secret1" } }));
    expect(screen.getByText("https://pub.example/s?key=••••••••")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    expect(fns.onCopy).toHaveBeenCalledWith("https://pub.example/s?key=secret1", "public link");
    expect(fns.onSelect).not.toHaveBeenCalled();
  });

  it("disables Copy link for an inactive share", () => {
    setup(shareRecord({ active: false, state: "paused" }));
    expect((screen.getByRole("button", { name: /Copy link/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reveals the link from the menu, focuses it, and hides it again on blur", () => {
    setup(shareRecord({ links: { local: "http://l/s?key=secret1", lan: null, public: null } }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal link" }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    const code = screen.getByText("http://l/s?key=secret1");
    expect(document.activeElement).toBe(code);
    expect(screen.queryByText("http://l/s?key=••••••••")).toBeNull();
    fireEvent.blur(code);
    expect(screen.queryByText("http://l/s?key=secret1")).toBeNull();
    expect(screen.getByText("http://l/s?key=••••••••")).toBeTruthy();
  });

  it("hides the revealed link from the menu", () => {
    setup(shareRecord({ links: { local: "http://l/s?key=secret1", lan: null, public: null } }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reveal link" }));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide link" }));
    expect(screen.queryByText("http://l/s?key=secret1")).toBeNull();
  });

  it("opens details and copies the prompt from the menu", () => {
    const { fns } = setup();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open details" }));
    expect(fns.onSelect).toHaveBeenCalledWith("share-1");
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy prompt" }));
    expect(fns.onCopy).toHaveBeenCalledWith(expect.stringContaining("http://127.0.0.1:4318/s/share-1?key=k-secret"), "prompt");
    expect(fns.onCopy.mock.calls[0]?.[0]).toContain("Trust is read-only");
  });

  it("forwards pause, rotate and revoke for an active share", () => {
    const share = shareRecord();
    const { fns } = setup(share);
    for (const [label, action] of [["Pause", "pause"], ["Rotate key", "rotate"], ["Revoke", "revoke"]] as const) {
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(fns.onManage).toHaveBeenLastCalledWith(action, share);
    }
  });

  it("forwards resume for a paused share and delete for an expired one", () => {
    const paused = shareRecord({ state: "paused", paused: true, active: false });
    const first = setup(paused);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Resume" }));
    expect(first.fns.onManage).toHaveBeenCalledWith("resume", paused);
    first.unmount();
    const expired = shareRecord({ state: "expired", active: false });
    const second = setup(expired);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(second.fns.onManage).toHaveBeenCalledWith("delete", expired);
  });

  it("lists the files with direction, size and link, or an empty note", () => {
    const files: ShareFile[] = [
      { name: "report.md", size: 2048, modifiedAt: NOW - 120_000, direction: "out" },
      { name: "input.csv", size: 10, modifiedAt: NOW - 3_600_000, direction: "in" },
    ];
    const first = setup(shareRecord(), { files });
    expect(screen.getByText("written")).toBeTruthy();
    expect(screen.getByText("received")).toBeTruthy();
    expect(screen.getByText("2 KB · 2m ago")).toBeTruthy();
    expect(screen.getByText("1 KB · 1h ago")).toBeTruthy();
    expect(screen.getByRole("link", { name: "input.csv" }).getAttribute("href")).toContain("?direction=in");
    expect(screen.getByRole("link", { name: "report.md" }).getAttribute("href")).toContain("/files/report.md");
    fireEvent.click(screen.getByText("report.md"));
    first.unmount();
    const second = setup(shareRecord(), { files: [] });
    expect(screen.getByText(/No files yet\./)).toBeTruthy();
    fireEvent.click(screen.getByText(/No files yet\./));
    expect(second.fns.onSelect).not.toHaveBeenCalled();
  });
});
