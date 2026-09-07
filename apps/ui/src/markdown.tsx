import { createElement, type ReactNode } from "react";

const SAFE_LINK = /^https?:\/\//i;

interface Candidate {
  index: number;
  length: number;
  kind: "code" | "strong" | "em" | "link";
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
    const candidates: Candidate[] = [];
    if (code && code.index !== undefined) candidates.push({ index: code.index, length: code[0].length, kind: "code", match: code });
    if (strong && strong.index !== undefined) candidates.push({ index: strong.index, length: strong[0].length, kind: "strong", match: strong });
    if (em && em.index !== undefined) candidates.push({ index: em.index, length: em[0].length, kind: "em", match: em });
    if (link && link.index !== undefined) candidates.push({ index: link.index, length: link[0].length, kind: "link", match: link });
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

function parseBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  const nextKey = () => `md-${key++}`;
  while (index < lines.length) {
    const line = lines[index]!;
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
    if (line.trim() === "") {
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
    if (/^>\s?/.test(line)) {
      const buffer: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        buffer.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      const bkey = nextKey();
      blocks.push(
        <blockquote key={bkey} className="md__quote">
          {parseInline(buffer.join(" "), bkey)}
        </blockquote>,
      );
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!)) {
        const item = lines[index]!.replace(/^\d+\.\s+/, "");
        const ikey = nextKey();
        items.push(<li key={ikey}>{parseInline(item, ikey)}</li>);
        index += 1;
      }
      blocks.push(
        <ol key={nextKey()} className="md__list">
          {items}
        </ol>,
      );
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index]!)) {
        const item = lines[index]!.replace(/^[-*]\s+/, "");
        const ikey = nextKey();
        items.push(<li key={ikey}>{parseInline(item, ikey)}</li>);
        index += 1;
      }
      blocks.push(
        <ul key={nextKey()} className="md__list">
          {items}
        </ul>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() !== "" &&
      !/^```/.test(lines[index]!) &&
      !/^#{1,6}\s+/.test(lines[index]!) &&
      !/^>\s?/.test(lines[index]!) &&
      !/^\d+\.\s+/.test(lines[index]!) &&
      !/^[-*]\s+/.test(lines[index]!)
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

export function Markdown({ text }: { text: string }): ReactNode {
  return <div className="md">{parseBlocks(text)}</div>;
}
