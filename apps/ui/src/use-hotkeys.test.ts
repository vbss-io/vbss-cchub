import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchCombo, parseCombo, type KeyEventLike } from "./use-hotkeys";

const event = (key: string, mods: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
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
