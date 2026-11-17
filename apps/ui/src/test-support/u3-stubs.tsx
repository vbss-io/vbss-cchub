import type { ReactElement } from "react";

const registry = new Map<string, object>();

export const resetCaptured = (): void => {
  registry.clear();
};

export const captured = <T extends object>(name: string): T => {
  const props = registry.get(name);
  if (!props) throw new Error(`${name} has not rendered`);
  return props as T;
};

export const stub = (name: string, body?: (props: Record<string, unknown>) => ReactElement | null) =>
  function Stub(props: Record<string, unknown>): ReactElement {
    registry.set(name, props);
    return <div data-testid={name}>{body ? body(props) : null}</div>;
  };
