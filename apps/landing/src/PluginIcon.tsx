import type { ReactNode } from "react";

export type IconName =
  | "sessions"
  | "today"
  | "tasks"
  | "flow"
  | "delegated"
  | "usage"
  | "limits"
  | "workspaces"
  | "reports"
  | "share"
  | "trail"
  | "widget";

const SHAPES: Record<IconName, ReactNode> = {
  sessions: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <circle cx="7" cy="7" r="1" fill="currentColor" />
      <circle cx="7" cy="17" r="1" fill="currentColor" />
    </>
  ),
  today: (
    <>
      <rect x="3" y="5" width="18" height="15" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
      <path d="m8.5 14 2 2 4-4" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1.5" />
      <rect x="9.5" y="4" width="5" height="10" rx="1.5" />
      <rect x="16" y="4" width="5" height="13" rx="1.5" />
    </>
  ),
  flow: (
    <>
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <path d="M7.5 11 16.5 6.8M7.5 13l9 4.2" />
    </>
  ),
  delegated: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="m4 6 1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </>
  ),
  usage: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  limits: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4-5" />
    </>
  ),
  workspaces: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  reports: (
    <>
      <path d="M4 5h16v11H9l-5 4Z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="19" r="2.5" />
      <path d="M8.3 10.8 15.7 6.2M8.3 13.2l7.4 4.6" />
    </>
  ),
  trail: (
    <>
      <path d="M4 6h2M4 12h2M4 18h2" />
      <path d="M10 6h10M10 12h10M10 18h6" />
    </>
  ),
  widget: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <circle cx="18" cy="9" r="1" fill="currentColor" />
    </>
  ),
};

export function PluginIcon({ name }: { name: IconName }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {SHAPES[name]}
    </svg>
  );
}
