import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isEditableTarget, matchCombo, parseCombo, type EditableTargetLike, type KeyEventLike } from "./use-hotkeys";

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
