import type { ReactNode } from "react";

export function Advanced({ children }: { children: ReactNode }) {
  return (
    <details className="advanced">
      <summary className="advanced__summary">Advanced</summary>
      <div className="form advanced__body">{children}</div>
    </details>
  );
}
