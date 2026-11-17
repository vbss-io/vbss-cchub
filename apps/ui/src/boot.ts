export type BootFlags = { widget: boolean; toast: boolean };

export type ReportDiag = (payload: Record<string, unknown>) => Promise<void>;

export type NavigateListen = (event: string, handler: (event: { payload: string }) => void) => Promise<unknown>;

export function bootFlags(search: string): BootFlags {
  const params = new URLSearchParams(search);
  return { widget: params.get("widget") === "1", toast: params.get("toast") === "1" };
}

export function isTauri(win: Window): boolean {
  return "__TAURI_INTERNALS__" in win;
}

export function prepareDocument(win: Window, doc: Document, report: ReportDiag): BootFlags {
  doc.documentElement.dataset.theme = win.localStorage.getItem("hub.theme") === "midnight" ? "midnight" : "dracula";
  const flags = bootFlags(win.location.search);
  void report({ window: flags.toast ? "toast" : flags.widget ? "widget" : "main", loaded: true, href: win.location.href, tauri: isTauri(win), visibility: doc.visibilityState });
  if (flags.toast) doc.documentElement.classList.add("toast-window");
  if (flags.widget) doc.documentElement.classList.add("widget-window");
  return flags;
}

export function bridgeNavigation(win: Window, flags: BootFlags, loadListen: () => Promise<NavigateListen>): boolean {
  if (flags.widget || flags.toast || !isTauri(win)) return false;
  void loadListen().then((listen) => {
    void listen("hub:navigate", (event) => {
      win.dispatchEvent(new CustomEvent<string>("cchub:goto-hash", { detail: event.payload }));
    });
  });
  return true;
}
