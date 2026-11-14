import { focusCodexApp } from "../api";
import { useState, type MouseEvent } from "react";
import { codexClient } from "../clients";
import { IconFocus } from "../icons";
import { relativeTime } from "../time";
import type { CodexSessionRecord } from "../types";
import { shortFolder } from "../wsmatch";
import { CardMenu, useCardMenu, type CardMenuItem } from "./CardMenu";
import { MoreChip, RunChip } from "./RunChips";

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

  const stop = (event: MouseEvent) => event.stopPropagation();
  const menuItems: CardMenuItem[] = [
    { key: "rename", label: "Rename", onSelect: () => setRenaming(true) },
    archived ? { key: "unarchive", label: "Unarchive", onSelect: () => onUnarchive(session.id) } : { key: "archive", label: "Archive", onSelect: () => onArchive(session.id) },
  ];
  const submitRename = (value: string) => {
    setRenaming(false);
    onRename(session.id, value.trim());
  };

  return (
    <article
      className={`card card--codex card--codex-${session.status} ${archived ? "card--archived" : ""} card--clickable`}
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
        <span className="card__status">{STATUS_LABEL[session.status]}</span>
        <CardMenu menu={menu} items={menuItems} label={`Actions for ${name}`} />
      </div>
      <div className="card__badges">
        <RunChip info={clientInfo} label={workspace ?? shortFolder(session.cwd)} title={`${clientInfo.label} · ${shortFolder(session.cwd)}`} />
        <MoreChip extras={originLabel(session) ? [originLabel(session)] : []} />
      </div>
      <div className="card__line">
        <span className="card__model">
          {session.turns} turn{session.turns === 1 ? "" : "s"}
        </span>
        <time>{relativeTime(session.updatedAt)}</time>
      </div>

      <div className="card__actions">
        <div className="card__open">
          {codexAppRunning && (
            <button
              className="act act--focus"
              title="Brings the Codex app window to the front; a single thread cannot be targeted"
              onClick={(event) => {
                stop(event);
                void focusCodexApp();
              }}
            >
              <IconFocus /> Focus app
            </button>
          )}
        </div>
        <div className="card__manage">
          {archived && !confirming && (
            <button
              className="act"
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
                className="act act--ghost"
                onClick={(event) => {
                  stop(event);
                  setConfirming(false);
                }}
              >
                Cancel
              </button>
              <button
                className="act act--danger"
                onClick={(event) => {
                  stop(event);
                  onDelete(session.id);
                }}
              >
                Confirm delete
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
