import { createElement, type ReactNode } from "react";

const SAFE_LINK = /^https?:\/\//i;

interface Candidate {
  index: number;
  length: number;
  kind: "code" | "strong" | "em" | "link" | "wikilink";
  match: RegExpMatchArray;
}

function parseInline(input: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let text = input;
  let counter = 0;
  const nextKey = () => `${keyBase}-${counter++}`;
  while (text.length > 0) {
    const code = text.match(/`([^`]+)`/);
    const strong = text.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
    const em = text.match(/\*([^*]+)\*|_([^_]+)_/);
    const link = text.match(/\[([^\]]+)\]\(([^)\s]+)\)/);
    const wikilink = text.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    const candidates: Candidate[] = [];
    if (code && code.index !== undefined) candidates.push({ index: code.index, length: code[0].length, kind: "code", match: code });
    if (strong && strong.index !== undefined) candidates.push({ index: strong.index, length: strong[0].length, kind: "strong", match: strong });
    if (em && em.index !== undefined) candidates.push({ index: em.index, length: em[0].length, kind: "em", match: em });
    if (link && link.index !== undefined) candidates.push({ index: link.index, length: link[0].length, kind: "link", match: link });
    if (wikilink && wikilink.index !== undefined) candidates.push({ index: wikilink.index, length: wikilink[0].length, kind: "wikilink", match: wikilink });
    if (candidates.length === 0) {
      out.push(text);
      break;
    }
    candidates.sort((a, b) => a.index - b.index);
    const chosen = candidates[0]!;
    if (chosen.index > 0) out.push(text.slice(0, chosen.index));
    const key = nextKey();
    if (chosen.kind === "code") {
      out.push(<code key={key} className="md__inline">{chosen.match[1]}</code>);
    } else if (chosen.kind === "strong") {
      out.push(<strong key={key}>{parseInline(chosen.match[1] ?? chosen.match[2] ?? "", key)}</strong>);
    } else if (chosen.kind === "em") {
      out.push(<em key={key}>{parseInline(chosen.match[1] ?? chosen.match[2] ?? "", key)}</em>);
    } else if (chosen.kind === "wikilink") {
      const target = chosen.match[1] ?? "";
      const label = chosen.match[2] ?? target;
      out.push(
        <span key={key} className="md__wikilink">
          {label}
        </span>,
      );
    } else {
      const href = chosen.match[2] ?? "";
      const label = chosen.match[1] ?? "";
      if (SAFE_LINK.test(href)) {
        out.push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {parseInline(label, key)}
          </a>,
        );
      } else {
        out.push(chosen.match[0]);
      }
    }
    text = text.slice(chosen.index + chosen.length);
  }
  return out;
}

function CodeBlock({ code }: { code: string }): ReactNode {
  const copy = () => void navigator.clipboard?.writeText(code).catch(() => undefined);
  return (
    <pre className="md__pre">
      <button type="button" className="md__copy" onClick={copy}>
        copy
      </button>
      <code>{code}</code>
    </pre>
  );
}

type ListKind = "ul" | "ol";

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function bulletKind(stripped: string): ListKind | null {
  if (/^[-*]\s+/.test(stripped)) return "ul";
  if (/^\d+\.\s+/.test(stripped)) return "ol";
  return null;
}

function stripBullet(stripped: string, kind: ListKind): string {
  return kind === "ul" ? stripped.replace(/^[-*]\s+/, "") : stripped.replace(/^\d+\.\s+/, "");
}

function parseTaskContent(content: string): { checked: boolean; rest: string } | null {
  const match = content.match(/^\[([ xX])\]\s*(.*)$/);
  if (!match) return null;
  return { checked: match[1]!.toLowerCase() === "x", rest: match[2] ?? "" };
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;

function parseListBlock(
  lines: string[],
  start: number,
  indent: number,
  lineBase: number,
  nextKey: () => string,
  onToggleTask?: (lineIndex: number, checked: boolean) => void,
): { node: ReactNode; next: number } {
  const kind = bulletKind(lines[start]!.slice(indent))!;
  const items: ReactNode[] = [];
  let index = start;
  while (index < lines.length) {
    const raw = lines[index]!;
    if (raw.trim() === "") break;
    const curIndent = leadingSpaces(raw);
    if (curIndent !== indent) break;
    const stripped = raw.slice(indent);
    const itemKind = bulletKind(stripped);
    if (itemKind !== kind) break;
    const content = stripBullet(stripped, itemKind);
    const lineNo = lineBase + index;
    const task = parseTaskContent(content);
    index += 1;
    let nested: ReactNode = null;
    if (index < lines.length) {
      const nextRaw = lines[index]!;
      const nextIndent = leadingSpaces(nextRaw);
      if (nextRaw.trim() !== "" && nextIndent > indent && bulletKind(nextRaw.slice(nextIndent))) {
        const result = parseListBlock(lines, index, nextIndent, lineBase, nextKey, onToggleTask);
        nested = result.node;
        index = result.next;
      }
    }
    const ikey = nextKey();
    const body = task ? task.rest : content;
    const inline = parseInline(body, ikey);
    if (task) {
      items.push(
        <li key={ikey} className="md__task">
          <label>
            <input
              type="checkbox"
              checked={task.checked}
              disabled={!onToggleTask}
              onChange={(event) => onToggleTask?.(lineNo, event.target.checked)}
            />
            <span>{inline}</span>
          </label>
          {nested}
        </li>,
      );
    } else {
      items.push(
        <li key={ikey}>
          {inline}
          {nested}
        </li>,
      );
    }
  }
  const node =
    kind === "ol" ? (
      <ol key={nextKey()} className="md__list">
        {items}
      </ol>
    ) : (
      <ul key={nextKey()} className="md__list">
        {items}
      </ul>
    );
  return { node, next: index };
}

function parseBlockLines(
  lines: string[],
  lineBase: number,
  nextKey: () => string,
  onToggleTask?: (lineIndex: number, checked: boolean) => void,
): ReactNode[] {
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        buffer.push(lines[index]!);
        index += 1;
      }
      index += 1;
      blocks.push(<CodeBlock key={nextKey()} code={buffer.join("\n")} />);
      continue;
    }
    if (HR_RE.test(line.trim())) {
      blocks.push(<hr key={nextKey()} className="md__hr" />);
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, Math.max(1, heading[1]!.length));
      const bkey = nextKey();
      blocks.push(createElement(`h${level}`, { key: bkey, className: "md__h" }, parseInline(heading[2]!, bkey)));
      index += 1;
      continue;
    }
    if (/^>/.test(line)) {
      const start = index;
      const buffer: string[] = [];
      while (index < lines.length && /^>/.test(lines[index]!)) {
        buffer.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      const bkey = nextKey();
      blocks.push(
        <blockquote key={bkey} className="md__quote">
          {parseBlockLines(buffer, lineBase + start, nextKey, onToggleTask)}
        </blockquote>,
      );
      continue;
    }
    const indent = leadingSpaces(line);
    if (bulletKind(line.slice(indent))) {
      const result = parseListBlock(lines, index, indent, lineBase, nextKey, onToggleTask);
      blocks.push(result.node);
      index = result.next;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^```/.test(lines[index]!) &&
      !/^#{1,6}\s+/.test(lines[index]!) &&
      !/^>/.test(lines[index]!) &&
      !HR_RE.test(lines[index]!.trim()) &&
      !bulletKind(lines[index]!.slice(leadingSpaces(lines[index]!)))
    ) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    const bkey = nextKey();
    blocks.push(
      <p key={bkey} className="md__p">
        {parseInline(paragraph.join(" "), bkey)}
      </p>,
    );
  }
  return blocks;
}

export interface FrontmatterResult {
  frontmatter: Record<string, string> | null;
  body: string;
  bodyOffset: number;
}

export function splitFrontmatter(markdown: string): FrontmatterResult {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { frontmatter: null, body: markdown, bodyOffset: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: null, body: markdown, bodyOffset: 0 };
  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]!] = (match[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: lines.slice(end + 1).join("\n"), bodyOffset: end + 1 };
}

export function toggleTaskLine(markdown: string, lineIndex: number, checked: boolean): string {
  const parts = markdown.split(/(\r\n|\n)/);
  let counter = 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (counter === lineIndex) {
      parts[i] = (parts[i] ?? "").replace(/\[[ xX]\]/, checked ? "[x]" : "[ ]");
      break;
    }
    counter += 1;
  }
  return parts.join("");
}

interface MarkdownProps {
  text: string;
  frontmatter?: "hidden" | "chip";
  onToggleTask?: (lineIndex: number, checked: boolean) => void;
}

export function Markdown({ text, frontmatter, onToggleTask }: MarkdownProps): ReactNode {
  let key = 0;
  const nextKey = () => `md-${key++}`;
  if (!frontmatter) {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    return <div className="md">{parseBlockLines(lines, 0, nextKey, onToggleTask)}</div>;
  }
  const { frontmatter: fm, body, bodyOffset } = splitFrontmatter(text);
  const lines = body.split("\n");
  const summary = fm ? Object.values(fm).filter((value) => value.length > 0) : [];
  return (
    <div className="md">
      {frontmatter === "chip" && summary.length > 0 && <div className="chip md__frontmatter">{summary.join(" · ")}</div>}
      {parseBlockLines(lines, bodyOffset, nextKey, onToggleTask)}
    </div>
  );
}
