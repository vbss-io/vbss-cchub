import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

export interface CardMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface MenuAnchor {
  x: number;
  y: number;
  fromButton: boolean;
}

export interface CardMenuState {
  anchor: MenuAnchor | null;
  open: boolean;
  openAt: (x: number, y: number) => void;
  openFromButton: (rect: DOMRect) => void;
  close: () => void;
}

export function useCardMenu(): CardMenuState {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const openAt = useCallback((x: number, y: number) => setAnchor({ x, y, fromButton: false }), []);
  const openFromButton = useCallback((rect: DOMRect) => setAnchor({ x: rect.right, y: rect.bottom + 4, fromButton: true }), []);
  const close = useCallback(() => setAnchor(null), []);
  return { anchor, open: anchor !== null, openAt, openFromButton, close };
}

const VIEWPORT_MARGIN = 8;

interface Props {
  menu: CardMenuState;
  items: CardMenuItem[];
  label: string;
}

export function CardMenu({ menu, items, label }: Props) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const { anchor, close } = menu;

  const focusItem = useCallback((index: number) => {
    const nodes = popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (!nodes || nodes.length === 0) return;
    nodes[(index + nodes.length) % nodes.length]?.focus();
  }, []);

  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    const rawLeft = anchor.fromButton ? anchor.x - width : anchor.x;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rawLeft, window.innerWidth - width - VIEWPORT_MARGIN));
    const overflowsBottom = anchor.y + height > window.innerHeight - VIEWPORT_MARGIN;
    const top = Math.max(VIEWPORT_MARGIN, overflowsBottom ? window.innerHeight - height - VIEWPORT_MARGIN : anchor.y);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.visibility = "visible";
    focusItem(0);
  }, [anchor, focusItem]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const onDismiss = () => close();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    window.addEventListener("blur", onDismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("blur", onDismiss);
    };
  }, [anchor, close]);

  const onPopupKey = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const nodes = Array.from(popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
    const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(index <= 0 ? nodes.length - 1 : index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(nodes.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    } else if (event.key === "Tab") {
      close();
    }
  };

  const onButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (menu.open) close();
    else menu.openFromButton(event.currentTarget.getBoundingClientRect());
  };

  const onButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      menu.openFromButton(event.currentTarget.getBoundingClientRect());
    }
  };

  const select = (item: CardMenuItem) => (event: MouseEvent) => {
    event.stopPropagation();
    if (item.disabled) return;
    close();
    item.onSelect();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="card__menu-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        onClick={onButtonClick}
        onKeyDown={onButtonKey}
      >
        ⋯
      </button>
      {anchor &&
        createPortal(
          <div
            ref={popupRef}
            id={menuId}
            className="card-menu"
            role="menu"
            aria-label={label}
            style={{ visibility: "hidden", left: 0, top: 0 }}
            onKeyDown={onPopupKey}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            {items.map((item) => (
              <button key={item.key} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled} className={`card-menu__item ${item.danger ? "card-menu__item--danger" : ""}`} onClick={select(item)}>
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
