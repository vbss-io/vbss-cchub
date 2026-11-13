export type HighlightKind =
  | "plain"
  | "frontmatter"
  | "heading"
  | "bold"
  | "italic"
  | "quote"
  | "wikilink"
  | "link"
  | "code"
  | "fence"
  | "marker"
  | "task-open"
  | "task-doing"
  | "task-done"
  | "tag"
  | "date"
  | "arrow";

export type HighlightToken = { kind: HighlightKind; text: string };

type LineMode = "none" | "frontmatter" | "fence";

const FRONTMATTER_DELIMITER = /^(?:\uFEFF)?---[ \t]*$/;
const FRONTMATTER_END = /^(?:---|\.\.\.)[ \t]*$/;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^(\s{0,3}#{1,6})(?=\s|$)/;
const QUOTE = /^\s{0,3}>/;
const RULE = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/;
const CHECKBOX = /^\[([ xX-])\](?=\s|$)/;

const INLINE_PARTS: readonly RegExp[] = [
  /(`[^`\n]+`)/,
  /(!?\[\[[^[\]\n]+\]\])/,
  /(!?\[[^[\]\n]*\]\([^()\n]*\))/,
  /(\*\*(?=\S)(?:(?!\*\*)[^\n])+?\*\*|__(?=\S)(?:(?!__)[^\n])+?__)/,
  /(\*[^\s*](?:[^*\n]*[^\s*])?\*(?!\*)|(?<!\w)_[^\s_](?:[^_\n]*[^\s_])?_(?!\w))/,
  /(🔁\uFE0F?(?:\s+every\b[^⏳🛫📅✅🔁#[]*?)?(?=\s*(?:[⏳🛫📅✅🔁#[]|$))|[⏳🛫📅✅]\uFE0F?(?:\s*\d{4}-\d{2}-\d{2})?)/u,
  /((?<![\w#&/])#(?=[\w/-]*[A-Za-z_])[\w/-]+)/,
  /(→)/,
];

const INLINE = new RegExp(INLINE_PARTS.map((part) => part.source).join("|"), "gu");

const INLINE_KINDS: readonly HighlightKind[] = ["code", "wikilink", "link", "bold", "italic", "date", "tag", "arrow"];

const CHECKBOX_KINDS: Record<string, HighlightKind> = {
  " ": "task-open",
  "-": "task-doing",
  x: "task-done",
  X: "task-done",
};

const push = (tokens: HighlightToken[], kind: HighlightKind, text: string): void => {
  if (text === "") return;
  tokens.push({ kind, text });
};

const inlineTokens = (text: string, base: HighlightKind): HighlightToken[] => {
  const tokens: HighlightToken[] = [];
  let cursor = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match[0] === "") {
      INLINE.lastIndex += 1;
      continue;
    }
    const group = INLINE_KINDS.findIndex((_, index) => match[index + 1] !== undefined);
    const kind = INLINE_KINDS[group];
    if (kind === undefined) continue;
    push(tokens, base, text.slice(cursor, match.index));
    push(tokens, kind, match[0]);
    cursor = match.index + match[0].length;
  }
  push(tokens, base, text.slice(cursor));
  return tokens;
};

const bodyTokens = (body: string, mode: LineMode): HighlightToken[] => {
  if (mode === "frontmatter") return body === "" ? [] : [{ kind: "frontmatter", text: body }];
  if (mode === "fence") return body === "" ? [] : [{ kind: "code", text: body }];
  const bom = body.startsWith("\uFEFF") ? "\uFEFF" : "";
  const line = bom === "" ? body : body.slice(1);
  const tokens: HighlightToken[] = [];
  push(tokens, "plain", bom);
  if (FENCE.test(line)) {
    push(tokens, "fence", line);
    return tokens;
  }
  if (HEADING.test(line)) {
    tokens.push(...inlineTokens(line, "heading"));
    return tokens;
  }
  if (QUOTE.test(line)) {
    tokens.push(...inlineTokens(line, "quote"));
    return tokens;
  }
  if (RULE.test(line)) {
    push(tokens, "marker", line);
    return tokens;
  }
  const list = LIST.exec(line);
  if (list !== null) {
    push(tokens, "plain", list[1] ?? "");
    push(tokens, "marker", list[2] ?? "");
    push(tokens, "plain", list[3] ?? "");
    const rest = line.slice(list[0].length);
    const checkbox = CHECKBOX.exec(rest);
    if (checkbox !== null) {
      push(tokens, CHECKBOX_KINDS[checkbox[1] ?? " "] ?? "task-open", checkbox[0]);
      tokens.push(...inlineTokens(rest.slice(checkbox[0].length), "plain"));
      return tokens;
    }
    tokens.push(...inlineTokens(rest, "plain"));
    return tokens;
  }
  tokens.push(...inlineTokens(line, "plain"));
  return tokens;
};

const CACHE_LIMIT = 20000;
const lineCache = new Map<string, HighlightToken[]>();

const lineTokens = (line: string, mode: LineMode): HighlightToken[] => {
  const key = `${mode}|${line}`;
  const hit = lineCache.get(key);
  if (hit !== undefined) return hit;
  const carriage = line.endsWith("\r");
  const body = carriage ? line.slice(0, -1) : line;
  const tokens = bodyTokens(body, mode);
  if (carriage) tokens.push({ kind: "plain", text: "\r" });
  if (lineCache.size >= CACHE_LIMIT) lineCache.clear();
  lineCache.set(key, tokens);
  return tokens;
};

const frontmatterEnd = (lines: readonly string[]): number => {
  const first = lines[0];
  if (first === undefined || !FRONTMATTER_DELIMITER.test(first.replace(/\r$/, ""))) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (FRONTMATTER_END.test((lines[index] ?? "").replace(/\r$/, ""))) return index;
  }
  return -1;
};

export function highlightLines(text: string): HighlightToken[][] {
  const lines = text.split("\n");
  const fmEnd = frontmatterEnd(lines);
  const result: HighlightToken[][] = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (index <= fmEnd) {
      result.push(lineTokens(line, "frontmatter"));
      continue;
    }
    const body = line.replace(/\r$/, "");
    if (inFence) {
      if (FENCE.test(body)) {
        inFence = false;
        result.push(lineTokens(line, "none"));
      } else {
        result.push(lineTokens(line, "fence"));
      }
      continue;
    }
    if (FENCE.test(body.replace(/^\uFEFF/, ""))) inFence = true;
    result.push(lineTokens(line, "none"));
  }
  return result;
}

export const joinHighlight = (lines: readonly (readonly HighlightToken[])[]): string =>
  lines.map((tokens) => tokens.map((token) => token.text).join("")).join("\n");
