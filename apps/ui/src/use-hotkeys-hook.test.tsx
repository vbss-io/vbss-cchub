import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useHotkeys, type HotkeyBinding } from "./use-hotkeys";

function Host({ bindings }: { bindings: HotkeyBinding[] }) {
  useHotkeys(bindings);
  return (
    <div>
      <input aria-label="field" />
      <div className="cm-editor">
        <span data-testid="editor-leaf" />
      </div>
    </div>
  );
}

test("fires the handler for a matching combo and prevents the default", () => {
  const handler = vi.fn();
  render(<Host bindings={[{ combo: "ctrl+k", handler }]} />);
  const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
});

test("ignores combos that do not match", () => {
  const handler = vi.fn();
  render(<Host bindings={[{ combo: "ctrl+k", handler }]} />);
  fireEvent.keyDown(window, { key: "k" });
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  expect(handler).not.toHaveBeenCalled();
});

test("skips typing targets unless the binding allows inputs", () => {
  const blocked = vi.fn();
  const allowed = vi.fn();
  const { getByLabelText, getByTestId } = render(
    <Host
      bindings={[
        { combo: "ctrl+k", handler: allowed, allowInInputs: true },
        { combo: "ctrl+1", handler: blocked },
      ]}
    />,
  );
  fireEvent.keyDown(getByLabelText("field"), { key: "1", ctrlKey: true });
  fireEvent.keyDown(getByTestId("editor-leaf"), { key: "1", ctrlKey: true });
  expect(blocked).not.toHaveBeenCalled();
  fireEvent.keyDown(getByLabelText("field"), { key: "k", ctrlKey: true });
  expect(allowed).toHaveBeenCalledTimes(1);
});

test("honours the enabled predicate and skips handled or composing events", () => {
  const handler = vi.fn();
  let on = false;
  render(<Host bindings={[{ combo: "ctrl+b", handler, enabled: () => on }]} />);
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(handler).not.toHaveBeenCalled();
  on = true;
  const handled = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, cancelable: true });
  handled.preventDefault();
  window.dispatchEvent(handled);
  expect(handler).not.toHaveBeenCalled();
  const composing = new KeyboardEvent("keydown", { key: "b", ctrlKey: true, cancelable: true, isComposing: true });
  window.dispatchEvent(composing);
  expect(handler).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "b", ctrlKey: true });
  expect(handler).toHaveBeenCalledTimes(1);
});

test("uses the latest bindings after a re-render and stops listening on unmount", () => {
  const first = vi.fn();
  const second = vi.fn();
  const view = render(<Host bindings={[{ combo: "ctrl+k", handler: first }]} />);
  view.rerender(<Host bindings={[{ combo: "ctrl+k", handler: second }]} />);
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  view.unmount();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  expect(second).toHaveBeenCalledTimes(1);
});
