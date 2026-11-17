import { afterEach, describe, expect, test, vi } from "vitest";
import { bootFlags, bridgeNavigation, isTauri, prepareDocument, type NavigateListen } from "./boot";

const tauriWindow = window as Window & { __TAURI_INTERNALS__?: unknown };

const report = () => vi.fn<(payload: Record<string, unknown>) => Promise<void>>(async () => undefined);

const visit = (search: string) => window.history.replaceState(null, "", `/${search}`);

afterEach(() => {
  visit("");
  localStorage.clear();
  delete tauriWindow.__TAURI_INTERNALS__;
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

describe("bootFlags", () => {
  test("reads the widget and toast flags only when they are exactly 1", () => {
    expect(bootFlags("")).toEqual({ widget: false, toast: false });
    expect(bootFlags("?widget=1")).toEqual({ widget: true, toast: false });
    expect(bootFlags("?toast=1")).toEqual({ widget: false, toast: true });
    expect(bootFlags("?widget=true&toast=0")).toEqual({ widget: false, toast: false });
    expect(bootFlags("?widget=1&toast=1")).toEqual({ widget: true, toast: true });
  });
});

describe("isTauri", () => {
  test("detects the Tauri internals on the window", () => {
    expect(isTauri(window)).toBe(false);
    tauriWindow.__TAURI_INTERNALS__ = {};
    expect(isTauri(window)).toBe(true);
  });
});

describe("prepareDocument", () => {
  test("the main window gets the dracula theme, no window class and reports itself", () => {
    const diag = report();
    const flags = prepareDocument(window, document, diag);
    expect(flags).toEqual({ widget: false, toast: false });
    expect(document.documentElement.dataset.theme).toBe("dracula");
    expect(document.documentElement.classList.contains("toast-window")).toBe(false);
    expect(document.documentElement.classList.contains("widget-window")).toBe(false);
    expect(diag).toHaveBeenCalledWith({ window: "main", loaded: true, href: window.location.href, tauri: false, visibility: document.visibilityState });
  });

  test("the midnight preference picks the midnight theme and anything else falls back to dracula", () => {
    localStorage.setItem("hub.theme", "midnight");
    prepareDocument(window, document, report());
    expect(document.documentElement.dataset.theme).toBe("midnight");
    localStorage.setItem("hub.theme", "light");
    prepareDocument(window, document, report());
    expect(document.documentElement.dataset.theme).toBe("dracula");
  });

  test("the widget window is marked and reported as widget inside Tauri", () => {
    visit("?widget=1");
    tauriWindow.__TAURI_INTERNALS__ = {};
    const diag = report();
    expect(prepareDocument(window, document, diag)).toEqual({ widget: true, toast: false });
    expect(document.documentElement.classList.contains("widget-window")).toBe(true);
    expect(document.documentElement.classList.contains("toast-window")).toBe(false);
    expect(diag).toHaveBeenCalledWith(expect.objectContaining({ window: "widget", tauri: true, href: `${window.location.origin}/?widget=1` }));
  });

  test("the toast window is marked and reported as toast, which wins the report when both flags are set", () => {
    visit("?toast=1&widget=1");
    const diag = report();
    prepareDocument(window, document, diag);
    expect(document.documentElement.classList.contains("toast-window")).toBe(true);
    expect(document.documentElement.classList.contains("widget-window")).toBe(true);
    expect(diag).toHaveBeenCalledWith(expect.objectContaining({ window: "toast" }));
  });
});

describe("bridgeNavigation", () => {
  const listener = () => {
    const handlers: Array<(event: { payload: string }) => void> = [];
    const listen = vi.fn<NavigateListen>(async (_event, handler) => {
      handlers.push(handler);
      return () => undefined;
    });
    return { handlers, listen, load: vi.fn(async () => listen) };
  };

  test("outside Tauri nothing is loaded", () => {
    const { load } = listener();
    expect(bridgeNavigation(window, { widget: false, toast: false }, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  test("widget and toast windows never bridge navigation", () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    const { load } = listener();
    expect(bridgeNavigation(window, { widget: true, toast: false }, load)).toBe(false);
    expect(bridgeNavigation(window, { widget: false, toast: true }, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  test("the main Tauri window turns hub:navigate into a cchub:goto-hash event", async () => {
    tauriWindow.__TAURI_INTERNALS__ = {};
    const { handlers, listen, load } = listener();
    const seen: unknown[] = [];
    const onGoto = (event: Event) => seen.push((event as CustomEvent<string>).detail);
    window.addEventListener("cchub:goto-hash", onGoto);
    expect(bridgeNavigation(window, { widget: false, toast: false }, load)).toBe(true);
    await vi.waitFor(() => expect(listen).toHaveBeenCalledWith("hub:navigate", expect.any(Function)));
    handlers[0]?.({ payload: "#/usage" });
    window.removeEventListener("cchub:goto-hash", onGoto);
    expect(seen).toEqual(["#/usage"]);
  });
});
