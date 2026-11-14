import { focusCodexApp } from "../api";
import { useState, type MouseEvent } from "react";
import { codexClient } from "../clients";
import { IconFocus } from "../icons";
import { relativeTime } from "../time";
import type { CodexSessionRecord } from "../types";
import { shortFolder } from "../wsmatch";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import type { TaskTone } from "../runs-model";
import { RunFoot, RunMeta, RunStatus } from "./RunChips";

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

const originLabel = (session: CodexSessionRecord): string => {
  if (session.origin === "hub") return "via hub";
  return session.threadSource ? (THREAD_SOURCE[session.threadSource] ?? session.threadSource.replace(/_/g, " ")) : "";
};

interface Props {
  session: CodexSessionRecord;
  workspace: string | null;
  codexAppRunning: boolean;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onDelete: (id: string) => void;
}

export function CodexCard({ session, workspace, codexAppRunning, onOpen, onRename, onArchive, onUnarchive, onDelete }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menu = useCardMenu();

  const archived = session.archivedAt != null;
  const name = session.customTitle ?? session.title;
  const clientInfo = codexClient(session.client);
  const tone: TaskTone = !archived && session.status === "active" ? "go" : "muted";
  const folder = shortFolder(session.cwd);
  const origin = originLabel(session);

  const stop = (event: MouseEvent) => event.stopPropagation();
  const menuItems: CardMenuItem[] = [
    { key: "rename", label: "Rename", onSelect: () => setRenaming(true) },
    archived ? { key: "unarchive", label: "Unarchive", onSelect: () => onUnarchive(session.id) } : { key: "archive", label: "Archive", onSelect: () => onArchive(session.id) },
  ];
  const actions = (
    <>
      {codexAppRunning && (
        <button
          className="act rc__act"
          title="Brings the Codex app window to the front; a single thread cannot be targeted"
          onClick={(event) => {
            stop(event);
            void focusCodexApp();
          }}
        >
          <IconFocus /> Focus app
        </button>
      )}
      {archived && !confirming && (
        <button
          className="act rc__act"
          title="Hides the thread from the hub; the rollout file on disk is untouched"
          onClick={(event) => {
            stop(event);
            setConfirming(true);
          }}
        >
          Delete
        </button>
      )}
      {archived && confirming && (
        <>
          <button
            className="act act--ghost rc__act"
            onClick={(event) => {
              stop(event);
              setConfirming(false);
            }}
          >
            Cancel
          </button>
          <button
            className="act act--danger rc__act"
            onClick={(event) => {
              stop(event);
              onDelete(session.id);
            }}
          >
            Confirm delete
          </button>
        </>
      )}
    </>
  );
  const submitRename = (value: string) => {
    setRenaming(false);
    onRename(session.id, value.trim());
  };

  return (
    <article
      className={`card card--run card--tone-${tone} card--codex card--codex-${session.status} ${archived ? "card--archived" : ""} card--clickable`}
      onClick={() => onOpen(session.id)}
      onContextMenu={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        menu.openAt(event.clientX, event.clientY);
      }}
    >
      <div className="card__head">
        {renaming ? (
          <input
            className="in card__rename"
            autoFocus
            defaultValue={session.customTitle ?? session.title}
            placeholder={session.id.slice(0, 8)}
            onClick={stop}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitRename(event.currentTarget.value);
              if (event.key === "Escape") setRenaming(false);
            }}
            onBlur={(event) => submitRename(event.currentTarget.value)}
          />
        ) : (
          <span className="card__name" title={name}>
            {name}
          </span>
        )}
        <RunStatus tone={tone} label={STATUS_LABEL[session.status]} />
        <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />
      </div>

      <RunMeta client={clientInfo} clientTitle={`${clientInfo.label} · ${folder}`} parts={[
          { key: "where", text: workspace ?? folder, title: session.cwd ?? folder },
          ...(workspace && workspace !== folder ? [{ key: "folder", text: folder, title: session.cwd ?? folder }] : []),
        ]} extras={origin ? [origin] : []} />

      <RunFoot actions={codexAppRunning || archived ? actions : undefined}>
        <span className="rc__model">
          {session.turns} turn{session.turns === 1 ? "" : "s"}
        </span>
        <time className="rc__time">{relativeTime(session.updatedAt)}</time>
      </RunFoot>
    </article>
  );
}
