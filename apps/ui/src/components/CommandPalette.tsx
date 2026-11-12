import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { KIND_LABEL, loadRecents, pushRecent, rankItems, saveRecents, type PaletteItem } from "../palette-model";
import "../palette.css";

interface Props {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  placeholder?: string;
}

const PAGE_STEP = 8;

export function CommandPalette({ open, items, onClose, placeholder }: Props) {
  if (!open) return null;
  return <PaletteDialog items={items} onClose={onClose} placeholder={placeholder ?? "Search sessions, workspaces, tasks and commands"} />;
}

interface DialogProps {
  items: PaletteItem[];
  onClose: () => void;
  placeholder: string;
}

function PaletteDialog({ items, onClose, placeholder }: DialogProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [previousFocus] = useState<Element | null>(() => document.activeElement);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const results = useMemo(() => rankItems(items, query, recents), [items, query, recents]);
  const activeIndex = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const optionId = (index: number) => `${listId}-opt-${index}`;

  useEffect(() => {
    inputRef.current?.focus();
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) inputRef.current?.focus();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      const current = document.activeElement;
      if ((!current || current === document.body) && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [previousFocus]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const node = document.getElementById(optionId(activeIndex));
    node?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  const choose = (item: PaletteItem) => {
    const next = pushRecent(recents, item.id);
    setRecents(next);
    saveRecents(next);
    onClose();
    item.run();
  };

  const move = (delta: number) => {
    if (results.length === 0) return;
    const target = activeIndex + delta;
    setActive(Math.max(0, Math.min(results.length - 1, target)));
  };

  const wrap = (delta: number) => {
    if (results.length === 0) return;
    setActive((activeIndex + delta + results.length) % results.length);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        wrap(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        wrap(-1);
        break;
      case "PageDown":
        event.preventDefault();
        move(PAGE_STEP);
        break;
      case "PageUp":
        event.preventDefault();
        move(-PAGE_STEP);
        break;
      case "Home":
        if (event.target === inputRef.current && query.length > 0) break;
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        if (event.target === inputRef.current && query.length > 0) break;
        event.preventDefault();
        setActive(Math.max(results.length - 1, 0));
        break;
      case "Enter": {
        event.preventDefault();
        const item = results[activeIndex];
        if (item) choose(item);
        break;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        event.preventDefault();
        inputRef.current?.focus();
        break;
      default:
        break;
    }
  };

  return (
    <div className="palette__overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-autocomplete="list"
          aria-label="Search"
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <ul id={listId} className="palette__list" role="listbox" aria-label="Results">
          {results.map((item, index) => (
            <li
              key={item.id}
              id={optionId(index)}
              className={`palette__item${index === activeIndex ? " palette__item--active" : ""}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseMove={() => index !== activeIndex && setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item)}
            >
              <span className={`palette__kind palette__kind--${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              <span className="palette__text">
                <span className="palette__title">{item.title}</span>
                {item.subtitle && <span className="palette__subtitle">{item.subtitle}</span>}
              </span>
            </li>
          ))}
        </ul>
        {results.length === 0 && <p className="palette__empty">No matches</p>}
        <footer className="palette__foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>Enter</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
}
