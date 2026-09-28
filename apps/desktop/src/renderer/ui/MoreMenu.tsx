import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "./controls";

export type MoreMenuItem = { label: string; onSelect: () => void; disabled?: boolean };

const MENU_WIDTH_PX = 144;

/**
 * A ••• menu for a row or a panel. Focus moves between its items: arrow keys, Home, and
 * End move it, Enter or Space picks, and Escape or a pick returns it to the
 * trigger. It sits at a fixed place under its trigger, so a scrolling list
 * or a panel's edge cannot clip it.
 */
export function MoreMenu(props: { label: string; items: readonly MoreMenuItem[]; testId?: string }) {
  const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open !== null]);
  const close = () => {
    setOpen(null);
    trigger.current?.focus();
  };
  const pick = (item: MoreMenuItem) => {
    if (item.disabled) return;
    close();
    item.onSelect();
  };
  const move = (to: (current: number, count: number) => number) => {
    const count = props.items.length;
    const current = items.current.findIndex((item) => item === document.activeElement);
    items.current[(to(current, count) + count) % count]?.focus();
  };
  return (
    <div>
      <IconButton
        ref={trigger}
        data-testid={props.testId}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={() => {
          const box = trigger.current?.getBoundingClientRect();
          setOpen((value) => (value || !box ? null : { top: box.bottom + 4, left: Math.max(4, box.right - MENU_WIDTH_PX) }));
        }}
      >
        <MoreHorizontal size={14} aria-hidden />
      </IconButton>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={props.label}
          onKeyDown={(event) => {
            const moves: Record<string, (current: number, count: number) => number> = {
              ArrowDown: (current) => current + 1,
              ArrowUp: (current) => current - 1,
              Home: () => 0,
              End: (_current, count) => count - 1,
            };
            const to = moves[event.key];
            if (to) {
              event.preventDefault();
              move(to);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "Tab") {
              setOpen(null);
            }
          }}
          style={{ top: open.top, left: open.left, width: MENU_WIDTH_PX }}
          className="dohc-popover dohc-pop-in fixed z-40 rounded-lg border border-line bg-panel p-1"
        >
          {props.items.map((item, index) => (
            <button
              key={item.label}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              // Disabled items keep focus, so arrow keys pass over them.
              aria-disabled={item.disabled ? true : undefined}
              onMouseEnter={(event) => event.currentTarget.focus()}
              onClick={() => pick(item)}
              className="flex h-7 w-full items-center rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink focus:bg-selected focus:text-ink aria-disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
