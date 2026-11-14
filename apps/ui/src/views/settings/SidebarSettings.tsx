import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import type { DelegationSettings } from "../../delegation";
import { defaultSidebarPrefs, sidebarModel } from "../../plugins/registry";
import type { PluginViewKey } from "../../plugins/types";
import { canMoveRow, canSetPinned, commitSidebar, dropRow, moveRow, sameRows, setRowPinned, sidebarRows, type SidebarRow } from "../../settings-model";
import { useUiPrefs } from "../../ui-prefs-context";

type FocusPart = "handle" | "up" | "down";

interface PendingFocus {
  key: PluginViewKey;
  part: FocusPart;
}

export function SidebarSettings({ settings }: { settings: DelegationSettings | null }) {
  const { uiPrefs, updateUiPrefs } = useUiPrefs();
  const features = settings?.features ?? null;
  const loaded = settings !== null;
  const rows = useMemo(() => sidebarRows(sidebarModel(features, uiPrefs.sidebar)), [features, uiPrefs.sidebar]);
  const [dragKey, setDragKey] = useState<PluginViewKey | null>(null);
  const [overKey, setOverKey] = useState<PluginViewKey | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pendingFocus = useRef<PendingFocus | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const row = listRef.current?.querySelector(`[data-row="${pending.key}"]`);
    const target = row?.querySelector<HTMLButtonElement>(`[data-part="${pending.part}"]`);
    const fallback = row?.querySelector<HTMLButtonElement>('[data-part="handle"]');
    (target && !target.disabled ? target : fallback)?.focus();
  }, [rows]);

  const commit = (next: SidebarRow[], focus?: PendingFocus) => {
    if (!loaded || sameRows(next, rows)) return;
    if (focus) pendingFocus.current = focus;
    void updateUiPrefs({ sidebar: commitSidebar(next, uiPrefs.sidebar ?? defaultSidebarPrefs()) });
  };

  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, key: PluginViewKey) => {
    if (!loaded || !event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    commit(moveRow(rows, key, event.key === "ArrowUp" ? -1 : 1), { key, part: "handle" });
  };

  const onDragStart = (event: DragEvent<HTMLDivElement>, key: PluginViewKey) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", key);
    setDragKey(key);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>, key: PluginViewKey) => {
    if (!loaded || !dragKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (overKey !== key) setOverKey(key);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>, key: PluginViewKey) => {
    event.preventDefault();
    const source = dragKey;
    setDragKey(null);
    setOverKey(null);
    if (source) commit(dropRow(rows, source, key), { key: source, part: "handle" });
  };

  const endDrag = () => {
    setDragKey(null);
    setOverKey(null);
  };

  const hasMore = rows.some((row) => !row.pinned);

  return (
    <div className="sidebar-settings">
      <div className="sidebar-settings__head">
        <h3>Sidebar</h3>
        <button type="button" className="act" disabled={!loaded || uiPrefs.sidebar === null} onClick={() => void updateUiPrefs({ sidebar: null })}>
          Reset to default
        </button>
      </div>
      <p className="hint">Pick what stays in the sidebar and what goes under More. Drag a row, use the arrows, or press Alt+Up and Alt+Down on the grip. Saved for the window and the phone.</p>
      <ul className="sidebar-list" ref={listRef} aria-busy={!loaded}>
        {rows.map((row, index) => {
          const firstMore = !row.pinned && (index === 0 || rows[index - 1]?.pinned === true);
          return (
            <li key={row.key} className="sidebar-list__entry">
              {index === 0 && <div className="sidebar-list__group">In the sidebar</div>}
              {firstMore && hasMore && <div className="sidebar-list__group">In More</div>}
              <div
                className={`sidebar-row ${dragKey === row.key ? "sidebar-row--drag" : ""} ${overKey === row.key && dragKey !== row.key ? "sidebar-row--over" : ""}`}
                data-row={row.key}
                draggable={loaded}
                onDragStart={(event) => onDragStart(event, row.key)}
                onDragOver={(event) => onDragOver(event, row.key)}
                onDrop={(event) => onDrop(event, row.key)}
                onDragEnd={endDrag}
              >
                <button type="button" className="sidebar-row__handle" data-part="handle" disabled={!loaded} aria-label={`Move ${row.label}. Alt+Up or Alt+Down reorders.`} onKeyDown={(event) => onHandleKey(event, row.key)}>
                  ⋮⋮
                </button>
                <span className="sidebar-row__label">{row.label}</span>
                <div className="seg" role="radiogroup" aria-label={`${row.label} placement`}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={row.pinned}
                    className="seg__opt"
                    disabled={!loaded || (!row.pinned && !canSetPinned(rows, row.key, true))}
                    onClick={() => commit(setRowPinned(rows, row.key, true), { key: row.key, part: "handle" })}
                  >
                    Pinned
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!row.pinned}
                    className="seg__opt"
                    disabled={!loaded || (row.pinned && !canSetPinned(rows, row.key, false))}
                    title={row.pinned && !canSetPinned(rows, row.key, false) ? "Keep at least one item pinned" : undefined}
                    onClick={() => commit(setRowPinned(rows, row.key, false), { key: row.key, part: "handle" })}
                  >
                    In More
                  </button>
                </div>
                <div className="sidebar-row__moves">
                  <button
                    type="button"
                    className="act sidebar-row__move"
                    data-part="up"
                    aria-label={`Move ${row.label} up`}
                    disabled={!loaded || !canMoveRow(rows, row.key, -1)}
                    onClick={() => commit(moveRow(rows, row.key, -1), { key: row.key, part: "up" })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="act sidebar-row__move"
                    data-part="down"
                    aria-label={`Move ${row.label} down`}
                    disabled={!loaded || !canMoveRow(rows, row.key, 1)}
                    onClick={() => commit(moveRow(rows, row.key, 1), { key: row.key, part: "down" })}
                  >
                    ↓
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
