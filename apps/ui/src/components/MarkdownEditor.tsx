import { memo, useLayoutEffect, useMemo, useRef, type ComponentPropsWithRef } from "react";
import { highlightLines, type HighlightToken } from "../md-highlight";
import "../markdown-editor.css";

type Props = Omit<ComponentPropsWithRef<"textarea">, "value" | "defaultValue" | "children"> & {
  value: string;
  fill?: boolean;
};

const MIN_FILL_HEIGHT = 320;
const STATUS_ALLOWANCE = 8;

const edgeBottom = (element: Element): number => {
  const style = getComputedStyle(element);
  return (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
};

const ancestorsBottom = (frame: HTMLElement): number => {
  let total = 0;
  for (let node = frame.parentElement; node !== null; node = node.parentElement) {
    total += edgeBottom(node);
    if (node.classList.contains("main")) break;
  }
  return total;
};

const siblingsBelow = (frame: HTMLElement): number => {
  const parent = frame.parentElement;
  const gap = parent === null ? 0 : parseFloat(getComputedStyle(parent).rowGap) || 0;
  let total = 0;
  for (let sibling = frame.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
    if (sibling instanceof HTMLElement && !sibling.hidden) total += sibling.offsetHeight + gap;
  }
  return total;
};

const stickyStatusBar = (): number => {
  const bar = document.querySelector<HTMLElement>(".statusbar");
  if (bar === null || getComputedStyle(bar).position !== "sticky") return 0;
  return bar.offsetHeight;
};

export const fillHeight = (frame: HTMLElement): number => {
  const top = frame.getBoundingClientRect().top + window.scrollY;
  const bottom = ancestorsBottom(frame) + stickyStatusBar() + siblingsBelow(frame) + STATUS_ALLOWANCE;
  return Math.max(MIN_FILL_HEIGHT, Math.floor(window.innerHeight - top - bottom));
};

const TokenView = ({ token }: { token: HighlightToken }) =>
  token.kind === "plain" ? <>{token.text === "\r" ? "" : token.text}</> : <span className={`mde__${token.kind}`}>{token.text}</span>;

const LineView = memo(function LineView({ tokens }: { tokens: readonly HighlightToken[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <TokenView key={index} token={token} />
      ))}
      {"\n"}
    </>
  );
});

export function MarkdownEditor({ value, fill = false, className, ref, ...rest }: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const display = useMemo(() => value.replace(/\r\n?/g, "\n"), [value]);
  const lines = useMemo(() => highlightLines(display), [display]);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!fill || frame === null) return;
    const apply = () => {
      frame.style.height = `${fillHeight(frame)}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(document.body);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [fill]);

  return (
    <div ref={frameRef} className={`mde ${fill ? "mde--fill" : ""}`}>
      <div className="mde__sheet">
        <pre className="mde__pre" aria-hidden="true">
          {lines.map((tokens, index) => (
            <LineView key={index} tokens={tokens} />
          ))}
        </pre>
        <textarea ref={ref} spellCheck={false} {...rest} className={`mde__input ${className ?? ""}`} value={value} />
      </div>
    </div>
  );
}
