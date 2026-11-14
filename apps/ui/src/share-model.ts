import type { FirewallStatus, ShareRecord, ShareState, TunnelStatus } from "./delegation";

export type ShareFilter = "active" | "paused" | "expired" | "all";

export const SHARE_FILTERS: { key: ShareFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All" },
];

export const DEFAULT_SHARE_FILTER: ShareFilter = "active";

export const isShareFilter = (value: unknown): value is ShareFilter => SHARE_FILTERS.some((item) => item.key === value);

type Filterable = Pick<ShareRecord, "state" | "label" | "workspace" | "repo">;

export const shareCounts = (shares: readonly Pick<ShareRecord, "state">[]): Record<ShareFilter, number> => ({
  active: shares.filter((share) => share.state === "active").length,
  paused: shares.filter((share) => share.state === "paused").length,
  expired: shares.filter((share) => share.state === "expired").length,
  all: shares.length,
});

export const filterShares = <T extends Filterable>(shares: readonly T[], filter: ShareFilter, query: string): T[] => {
  const needle = query.trim().toLowerCase();
  return shares.filter((share) => {
    if (needle && !`${share.label} ${share.workspace} ${share.repo ?? ""}`.toLowerCase().includes(needle)) return false;
    return filter === "all" || share.state === filter;
  });
};

export type ShareMenuKey = "details" | "copy-prompt" | "reveal" | "hide" | "pause" | "resume" | "rotate" | "revoke" | "delete";

export interface ShareMenuEntry {
  key: ShareMenuKey;
  label: string;
  danger?: boolean;
}

export const shareMenuEntries = (state: ShareState, revealed: boolean): ShareMenuEntry[] => {
  const live = state === "active" || state === "paused";
  const entries: ShareMenuEntry[] = [
    { key: "details", label: "Open details" },
    ...(state === "active" ? [{ key: "copy-prompt" as const, label: "Copy prompt" }] : []),
    revealed ? { key: "hide", label: "Hide link" } : { key: "reveal", label: "Reveal link" },
  ];
  if (state === "active") entries.push({ key: "pause", label: "Pause" });
  if (state === "paused") entries.push({ key: "resume", label: "Resume" });
  if (live) entries.push({ key: "rotate", label: "Rotate key" });
  if (live) entries.push({ key: "revoke", label: "Revoke", danger: true });
  if (state === "revoked" || state === "expired") entries.push({ key: "delete", label: "Delete", danger: true });
  return entries;
};

export const activitySummary = (
  share: Pick<ShareRecord, "uses" | "lastUsedAt" | "requestsLastHour" | "maxPerHour">,
  relative: (timestamp: number) => string,
): string => {
  if (share.uses === 0) return "no requests yet";
  const total = `${share.uses} ${share.uses === 1 ? "request" : "requests"}`;
  const last = share.lastUsedAt ? ` · last ${relative(share.lastUsedAt)}` : "";
  const hour = share.requestsLastHour > 0 ? ` · ${share.requestsLastHour}/${share.maxPerHour} this hour` : "";
  return `${total}${last}${hour}`;
};

export type ReachTone = "ok" | "warn" | "off" | "error";

export interface ReachItem {
  key: "lan" | "firewall" | "internet";
  label: string;
  detail: string;
  tone: ReachTone;
  title: string;
}

export const reachItems = (tunnel: TunnelStatus | null, firewall: FirewallStatus | null): ReachItem[] => {
  const items: ReachItem[] = [];
  if (!tunnel) {
    items.push({ key: "lan", label: "LAN", detail: "checking…", tone: "off", title: "Checking the share endpoint" });
  } else if (tunnel.endpointError) {
    items.push({ key: "lan", label: "LAN", detail: "endpoint down", tone: "error", title: `Port ${tunnel.sharePort} could not be opened: ${tunnel.endpointError}` });
  } else if (tunnel.lanUrl) {
    items.push({ key: "lan", label: "LAN", detail: tunnel.lanUrl.replace(/^https?:\/\//, ""), tone: "ok", title: tunnel.lanUrl });
  } else {
    items.push({ key: "lan", label: "LAN", detail: "no address", tone: "off", title: "No LAN address found on this machine" });
  }
  if (firewall === null) {
    items.push({ key: "firewall", label: "Firewall", detail: "checking…", tone: "off", title: "Checking the Windows Firewall rule" });
  } else if (firewall.supported) {
    items.push(
      firewall.allowed === true
        ? { key: "firewall", label: "Firewall", detail: "ok", tone: "ok", title: "Windows Firewall allows LAN access to the share port" }
        : { key: "firewall", label: "Firewall", detail: "blocks LAN", tone: "warn", title: "Adds an inbound rule for the share port; Windows asks for admin" },
    );
  }
  if (tunnel?.state === "running") {
    items.push({ key: "internet", label: "Internet", detail: tunnel.publicUrl ? tunnel.publicUrl.replace(/^https?:\/\//, "") : "on", tone: "ok", title: tunnel.publicUrl ?? "Tunnel running" });
  } else if (tunnel?.state === "error") {
    items.push({ key: "internet", label: "Internet", detail: "tunnel failed", tone: "error", title: tunnel.error ?? "tunnel failed" });
  } else if (tunnel?.state === "installing" || tunnel?.state === "starting") {
    items.push({ key: "internet", label: "Internet", detail: tunnel.state === "installing" ? "installing ngrok…" : "starting…", tone: "warn", title: "The tunnel is coming up" });
  } else {
    items.push({ key: "internet", label: "Internet", detail: "off", tone: "off", title: "No public tunnel; links only work on the LAN" });
  }
  return items;
};

export type ReachMenuKey = "tunnel" | "firewall" | "settings";

export interface ReachMenuEntry {
  key: ReachMenuKey;
  label: string;
}

export const tunnelIsUp = (tunnel: TunnelStatus | null): boolean =>
  tunnel?.state === "running" || tunnel?.state === "installing" || tunnel?.state === "starting";

export const reachMenuEntries = (tunnel: TunnelStatus | null, firewall: FirewallStatus | null): ReachMenuEntry[] => {
  const entries: ReachMenuEntry[] = [{ key: "tunnel", label: tunnelIsUp(tunnel) ? "Stop tunnel" : "Start tunnel" }];
  if (firewall?.supported && firewall.allowed === false) entries.push({ key: "firewall", label: "Allow LAN (admin)" });
  entries.push({ key: "settings", label: "Settings › Sharing" });
  return entries;
};

export const reachProblems = (tunnel: TunnelStatus | null): string[] => {
  const problems: string[] = [];
  if (tunnel?.endpointError) problems.push(`Share endpoint down: port ${tunnel.sharePort} could not be opened (${tunnel.endpointError}). Close whatever uses it or change HUB_SHARE_PORT, then restart the hub.`);
  if (tunnel?.state === "error" && tunnel.error) problems.push(tunnel.error);
  return problems;
};
