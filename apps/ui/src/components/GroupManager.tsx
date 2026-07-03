import { useState } from "react";
import type { GroupRecord } from "../types";

interface Props {
  groups: GroupRecord[];
  onCreate: (name: string, match: string) => void;
  onUpdate: (id: string, fields: { name?: string; match?: string }) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
}

export function GroupManager({ groups, onCreate, onUpdate, onDelete, onMove }: Props) {
  const [name, setName] = useState("");
  const [match, setMatch] = useState("");

  const add = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), match.trim());
    setName("");
    setMatch("");
  };

  return (
    <div className="groupmgr">
      {groups.map((group, index) => (
        <div key={group.id} className="groupmgr__row">
          <input
            className="in"
            defaultValue={group.name}
            onBlur={(event) => {
              if (event.target.value.trim() && event.target.value !== group.name) {
                onUpdate(group.id, { name: event.target.value.trim() });
              }
            }}
          />
          <input
            className="in"
            defaultValue={group.match}
            placeholder="path fragment (cwd)"
            onBlur={(event) => {
              if (event.target.value !== group.match) onUpdate(group.id, { match: event.target.value.trim() });
            }}
          />
          <button
            className="act"
            disabled={index === 0}
            onClick={() => onMove(group.id, -1)}
            aria-label={`Move ${group.name} up`}
          >
            ↑
          </button>
          <button
            className="act"
            disabled={index === groups.length - 1}
            onClick={() => onMove(group.id, 1)}
            aria-label={`Move ${group.name} down`}
          >
            ↓
          </button>
          <button
            className="act act--danger"
            onClick={() => onDelete(group.id)}
            aria-label={`Delete ${group.name}`}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="groupmgr__row groupmgr__add">
        <input
          className="in"
          placeholder="group name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className="in"
          placeholder="path fragment (cwd)"
          value={match}
          onChange={(event) => setMatch(event.target.value)}
        />
        <button className="act" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
