import { GroupManager } from "../../components/GroupManager";
import type { GroupRecord } from "../../types";

interface Props {
  groups: GroupRecord[];
  onCreateGroup: (name: string, match: string) => void;
  onUpdateGroup: (id: string, fields: { name?: string; match?: string }) => void;
  onDeleteGroup: (id: string) => void;
  onMoveGroup: (id: string, direction: -1 | 1) => void;
}

export function GroupsTab({ groups, onCreateGroup, onUpdateGroup, onDeleteGroup, onMoveGroup }: Props) {
  return (
    <section className="settings__section" id="settings-groups">
      <h2>Groups</h2>
      <p className="hint">
        Sessions are grouped by workspace automatically. Add a group to override that with a path fragment (matched against the session folder); order decides priority.
      </p>
      <GroupManager groups={groups} onCreate={onCreateGroup} onUpdate={onUpdateGroup} onDelete={onDeleteGroup} onMove={onMoveGroup} />
    </section>
  );
}
