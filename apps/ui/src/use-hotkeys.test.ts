import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { findBinding, isEditableTarget, matchCombo, parseCombo, type EditableTargetLike, type HotkeyBinding, type KeyEventLike } from "./use-hotkeys";

const event = (key: string, mods: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const element = (tagName: string, insideEditor = false, isContentEditable = false): EditableTargetLike => ({
  tagName,
  isContentEditable,
  closest: (selector: string) => (insideEditor && selector.includes(".cm-editor") && selector.includes(".mde") ? {} : null),
});

describe("isEditableTarget", () => {
  it("guards inputs, textareas, selects and contenteditable so Ctrl+B stays with the field", () => {
    assert.equal(isEditableTarget(element("INPUT")), true);
    assert.equal(isEditableTarget(element("textarea")), true);
    assert.equal(isEditableTarget(element("SELECT")), true);
    assert.equal(isEditableTarget(element("DIV", false, true)), true);
  });

  it("guards anything inside the Markdown or CodeMirror editor", () => {
    assert.equal(isEditableTarget(element("SPAN", true)), true);
    assert.equal(isEditableTarget(element("PRE", true)), true);
  });

  it("lets the shortcut through on plain page targets", () => {
    assert.equal(isEditableTarget(element("BODY")), false);
    assert.equal(isEditableTarget(element("BUTTON")), false);
    assert.equal(isEditableTarget(null), false);
    assert.equal(isEditableTarget({}), false);
  });
});

describe("Ctrl+B", () => {
  it("matches ctrl+b and cmd+b only", () => {
    assert.equal(matchCombo(event("b", { ctrlKey: true }), "ctrl+b"), true);
    assert.equal(matchCombo(event("B", { metaKey: true }), "ctrl+b"), true);
    assert.equal(matchCombo(event("b", { ctrlKey: true, shiftKey: true }), "ctrl+b"), false);
    assert.equal(matchCombo(event("b"), "ctrl+b"), false);
  });
});

describe("findBinding", () => {
  const handler = () => undefined;
  const sidebar = (enabled: () => boolean): HotkeyBinding => ({ combo: "ctrl+b", handler, enabled });

  it("returns the binding when it matches and is enabled", () => {
    const binding = sidebar(() => true);
    assert.equal(findBinding(event("b", { ctrlKey: true }), false, [binding]), binding);
  });

  it("returns null for a disabled binding so the browser default is not prevented", () => {
    assert.equal(findBinding(event("b", { ctrlKey: true }), false, [sidebar(() => false)]), null);
  });

  it("falls through to a later enabled binding with the same combo", () => {
    const later: HotkeyBinding = { combo: "ctrl+b", handler };
    assert.equal(findBinding(event("b", { ctrlKey: true }), false, [sidebar(() => false), later]), later);
  });

  it("skips bindings in editable targets unless they allow inputs", () => {
    assert.equal(findBinding(event("b", { ctrlKey: true }), true, [sidebar(() => true)]), null);
    const allowed: HotkeyBinding = { combo: "ctrl+k", handler, allowInInputs: true };
    assert.equal(findBinding(event("k", { ctrlKey: true }), true, [allowed]), allowed);
  });

  it("returns null when nothing matches", () => {
    assert.equal(findBinding(event("x"), false, [sidebar(() => true)]), null);
  });
});

describe("matchCombo", () => {
  it("matches ctrl+k and ignores plain k", () => {
    assert.equal(matchCombo(event("k", { ctrlKey: true }), "ctrl+k"), true);
    assert.equal(matchCombo(event("k"), "ctrl+k"), false);
  });

  it("is case insensitive for key and combo", () => {
    assert.equal(matchCombo(event("K", { ctrlKey: true }), "Ctrl+K"), true);
  });

  it("treats meta as ctrl", () => {
    assert.equal(matchCombo(event("k", { metaKey: true }), "ctrl+k"), true);
    assert.equal(matchCombo(event("1", { metaKey: true }), "cmd+1"), true);
  });

  it("matches digits and punctuation", () => {
    assert.equal(matchCombo(event("1", { ctrlKey: true }), "ctrl+1"), true);
    assert.equal(matchCombo(event(",", { ctrlKey: true }), "ctrl+,"), true);
    assert.equal(matchCombo(event(",", { ctrlKey: true }), "ctrl+comma"), true);
    assert.equal(matchCombo(event("2", { ctrlKey: true }), "ctrl+1"), false);
  });

  it("requires exact modifier set", () => {
    assert.equal(matchCombo(event("k", { ctrlKey: true, shiftKey: true }), "ctrl+k"), false);
    assert.equal(matchCombo(event("k", { ctrlKey: true, altKey: true }), "ctrl+k"), false);
    assert.equal(matchCombo(event("k", { ctrlKey: true, shiftKey: true }), "ctrl+shift+k"), true);
    assert.equal(matchCombo(event("k", { altKey: true }), "alt+k"), true);
  });

  it("matches a bare key and escape alias", () => {
    assert.equal(matchCombo(event("Escape"), "esc"), true);
    assert.equal(matchCombo(event("Escape", { ctrlKey: true }), "esc"), false);
  });

  it("handles the plus key", () => {
    assert.equal(matchCombo(event("+", { ctrlKey: true }), "ctrl++"), true);
    assert.equal(matchCombo(event("+", { ctrlKey: true }), "ctrl+plus"), true);
  });

  it("rejects a combo with no key", () => {
    assert.equal(matchCombo(event("Control", { ctrlKey: true }), "ctrl"), false);
    assert.equal(matchCombo(event("k"), ""), false);
  });
});

describe("parseCombo", () => {
  it("parses modifiers and key", () => {
    assert.deepEqual(parseCombo("ctrl+shift+P"), { key: "p", ctrl: true, alt: false, shift: true });
  });
});
