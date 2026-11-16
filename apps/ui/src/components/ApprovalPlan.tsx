import type { PlanView } from "../approvals-model";
import { Markdown } from "../markdown";
import { ClampText } from "./ShowMore";

interface Props {
  plan: PlanView;
  lines: number;
}

export function ApprovalPlan({ plan, lines }: Props) {
  return (
    <div className="approval__plan">
      {plan.plan.trim().length > 0 ? (
        <ClampText markdown lines={lines}>
          <Markdown text={plan.plan} />
        </ClampText>
      ) : (
        <span className="approval__cwd">The plan text did not come with the request.</span>
      )}
      {plan.path && (
        <span className="approval__cwd" title={plan.path}>
          {plan.path.split(/[\\/]/).pop()}
        </span>
      )}
    </div>
  );
}
