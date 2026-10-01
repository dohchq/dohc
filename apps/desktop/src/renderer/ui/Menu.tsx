import { Check, MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { IconButton } from "./controls";
import { useDismiss } from "./useDismiss";

export type MenuItem = {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Set to make the row a menuitemradio; the checked row shows a check mark. */
  checked?: boolean;
  testId?: string;
};

const MENU_WIDTH_PX = 144;

/**
 * A trigger and the list it opens. The owner holds `open`; the menu reports
 * every way it closes through `onOpenChange`: Escape, a press outside, focus
 * leaving, the window blurring, or a pick. Focus moves to the first row on
 * open and back to the trigger on close. Arrow keys, Home, End, and a typed
 * letter move it; Enter or Space picks. A disabled row keeps focus, so a
 * keyboard user still finds it, but a pick on it does nothing.
 *
 * The list sits at a fixed place under the trigger's right edge, so a
 * scrolling list or a panel's edge cannot clip it. Rows carry only their
 * label; what a pick does belongs to the owner's `onSelect`. An owner that
 * answers inside the menu (a copied label, a refusal) passes
 * `closeOnPick={false}` and closes when it is done.
 */
export function Menu(props: {
  label: string;
  items: readonly MenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Trigger content; the ••• glyph by default. */
  icon?: ReactNode;
  testId?: string;
  width?: number;
  closeOnPick?: boolean;
  /** Rendered under the rows, inside the list. */
  children?: ReactNode;
}) {
  const { open, onOpenChange } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const width = props.width ?? MENU_WIDTH_PX;
  const [place, setPlace] = useState({ top: 0, left: 0 });
  useDismiss({ open, container, trigger, onClose: () => onOpenChange(false) });

  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current?.getBoundingClientRect();
    if (box) setPlace({ top: box.bottom + 4, left: Math.max(4, box.right - width) });
    rows.current[0]?.focus();
  }, [open, width]);

  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    if (props.closeOnPick !== false) close();
    item.onSelect();
  };
  const count = props.items.length;
  const focusRow = (index: number) => rows.current[((index % count) + count) % count]?.focus();
  const current = () => rows.current.findIndex((row) => row === document.activeElement);
  const typeahead = (key: string) => {
    const from = current();
    for (let step = 1; step <= count; step += 1) {
      const row = rows.current[(from + step) % count];
      if (row?.textContent?.trimStart().toLocaleLowerCase().startsWith(key.toLocaleLowerCase())) {
        row.focus();
        return;
      }
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusRow(current() + 1),
      ArrowUp: () => focusRow(current() - 1),
      Home: () => focusRow(0),
      End: () => focusRow(-1),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    } else if (event.key === "Escape") {
      // useDismiss already closed it; one Escape closes one surface.
      event.stopPropagation();
    } else if (event.key === "Tab") {
      // The trigger takes focus first, so the key then moves on from it in
      // either direction instead of landing on the trigger with the menu open.
      close();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      typeahead(event.key);
    }
  };

  return (
    <div ref={container} className="shrink-0">
      <IconButton
        ref={trigger}
        data-testid={props.testId}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        {props.icon ?? <MoreHorizontal size={14} aria-hidden />}
      </IconButton>
      {open ? (
        <div
          role="menu"
          aria-label={props.label}
          onKeyDown={onKeyDown}
          // A press on the padding or on what the owner adds under the rows
          // must not send focus to the page, where the keys stop working.
          onMouseDown={(event) => event.preventDefault()}
          style={{ top: place.top, left: place.left, width }}
          className="dohc-popover dohc-pop-in fixed z-40 rounded-lg border border-line bg-panel p-1"
        >
          {props.items.map((item, index) => (
            <button
              key={item.id}
              ref={(element) => {
                rows.current[index] = element;
              }}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              data-testid={item.testId}
              tabIndex={-1}
              aria-disabled={item.disabled ? true : undefined}
              onMouseEnter={(event) => event.currentTarget.focus()}
              onClick={() => pick(item)}
              className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink focus:bg-selected focus:text-ink aria-disabled:opacity-50"
            >
              {item.checked === undefined ? null : (
                <Check size={14} aria-hidden className={item.checked ? "shrink-0" : "invisible shrink-0"} />
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
