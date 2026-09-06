import { ClientBadge, codexClient } from "../clients";
import { relativeTime } from "../time";
import type { CodexSessionRecord } from "../types";

const STATUS_LABEL: Record<CodexSessionRecord["status"], string> = {
  active: "Active",
  idle: "Idle",
  ended: "Ended",
};

const THREAD_SOURCE: Record<string, string> = {
  voice_chat: "voice chat",
  agent_created_thread: "created by an agent",
  user: "started by you",
};

const originLabel = (session: CodexSessionRecord): string =>
  session.threadSource ? (THREAD_SOURCE[session.threadSource] ?? session.threadSource.replace(/_/g, " ")) : "";

export function CodexCard({ session, workspace }: { session: CodexSessionRecord; workspace: string | null }) {
  return (
    <article className={`card card--codex card--codex-${session.status}`}>
      <div className="card__head">
        <span className="card__name" title={session.title}>
          {session.title}
        </span>
        <span className="card__status">{STATUS_LABEL[session.status]}</span>
      </div>
      <div className="card__badges">
        <ClientBadge info={codexClient(session.client)} />
        {workspace && <span className="chip chip--ws">{workspace}</span>}
      </div>
      <p className="card__msg">{session.lastMessage ?? "No assistant message yet."}</p>
      <div className="card__metrics">
        <div className="card__meta">
          <span className="chip">{session.turns} turn{session.turns === 1 ? "" : "s"}</span>
          {originLabel(session) && <span className="card__id">{originLabel(session)}</span>}
          <span className="card__id" title={session.id}>
            {session.id.slice(0, 8)}
          </span>
        </div>
      </div>
      <div className="card__foot">
        <span title={session.cwd ?? ""}>{session.cwd ?? "—"}</span>
        <time>{relativeTime(session.updatedAt)}</time>
      </div>
    </article>
  );
}
