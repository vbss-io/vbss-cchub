import { useEffect, useRef } from "react";

export interface HotkeyBinding {
  combo: string;
  handler: (event: KeyboardEvent) => void;
  allowInInputs?: boolean;
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

interface ParsedCombo {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const MODIFIER_ALIASES: Record<string, "ctrl" | "alt" | "shift"> = {
  ctrl: "ctrl",
  control: "ctrl",
  cmd: "ctrl",
  meta: "ctrl",
  mod: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  space: " ",
  plus: "+",
  comma: ",",
};

export const parseCombo = (combo: string): ParsedCombo => {
  const parsed: ParsedCombo = { key: "", ctrl: false, alt: false, shift: false };
  const text = combo.trim().toLowerCase();
  const parts = text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) parsed[modifier] = true;
    else if (part) parsed.key = KEY_ALIASES[part] ?? part;
  }
  return parsed;
};

export const matchCombo = (event: KeyEventLike, combo: string): boolean => {
  const parsed = parseCombo(combo);
  if (!parsed.key) return false;
  if ((event.ctrlKey || event.metaKey) !== parsed.ctrl) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  return event.key.toLowerCase() === parsed.key;
};

export interface EditableTargetLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: unknown;
}

const EDITOR_SELECTOR = ".mde, .cm-editor, [contenteditable=\"true\"], [contenteditable=\"\"]";

const EDITABLE_TAGS: ReadonlySet<string> = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export const isEditableTarget = (target: EventTarget | EditableTargetLike | null): boolean => {
  if (typeof target !== "object" || target === null) return false;
  const node = target as EditableTargetLike;
  if (node.isContentEditable === true) return true;
  if (typeof node.tagName === "string" && EDITABLE_TAGS.has(node.tagName.toUpperCase())) return true;
  if (typeof node.closest !== "function") return false;
  return (node.closest as (selector: string) => unknown).call(target, EDITOR_SELECTOR) != null;
};

export const useHotkeys = (bindings: HotkeyBinding[]): void => {
  const latest = useRef(bindings);

  useEffect(() => {
    latest.current = bindings;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const inEditable = isEditableTarget(event.target);
      for (const binding of latest.current) {
        if (inEditable && !binding.allowInInputs) continue;
        if (!matchCombo(event, binding.combo)) continue;
        event.preventDefault();
        binding.handler(event);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
};
