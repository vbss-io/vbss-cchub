import { effectiveProjectOrder, moveInProjectOrder, type MoveDirection } from "../board-model";
import type { BoardProject } from "../delegation";

interface Props {
  projects: BoardProject[];
  order: string[];
  disabled: boolean;
  onChange: (order: string[]) => void;
}

const INDENT_PX = 16;

export function DailyProjectOrder({ projects, order, disabled, onChange }: Props) {
  const effective = effectiveProjectOrder(projects, order);
  const byId = new Map(projects.map((project) => [project.id, project]));
  const move = (id: string, direction: MoveDirection) => onChange(moveInProjectOrder(effective, id, direction));
  return (
    <div className="field">
      <span>Project order</span>
      {projects.length === 0 ? (
        <small className="muted">No projects yet. Set up Tasks and its projects folder to order them.</small>
      ) : (
        <ol className="porder">
          {effective.map((id, index) => {
            const project = byId.get(id);
            if (!project) return null;
            return (
              <li key={id} className="porder__row">
                <span className="porder__name" style={{ paddingLeft: project.depth * INDENT_PX }} title={project.path}>
                  {project.title}
                </span>
                <button className="act" disabled={disabled || index === 0} aria-label={`Move ${project.title} up`} onClick={() => move(id, "up")}>
                  Move up
                </button>
                <button className="act" disabled={disabled || index === effective.length - 1} aria-label={`Move ${project.title} down`} onClick={() => move(id, "down")}>
                  Move down
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="frow">
        <button className="act" disabled={disabled || order.length === 0} onClick={() => onChange([])}>
          Reset to tree order
        </button>
      </div>
      <small>Where a task added from Tasks lands in the focus section. Projects you do not move follow the tree order.</small>
    </div>
  );
}
