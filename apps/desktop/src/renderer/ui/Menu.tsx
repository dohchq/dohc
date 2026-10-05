import { Check, MoreHorizontal } from "lucide-react";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconButton } from "./controls";
import { useDismiss } from "./useDismiss";

export type MenuItem = {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Set to make the row a menuitemradio; the checked row shows a check mark. */
  checked?: boolean;
  /** The row for what is showing now, such as the active tab. */
  current?: boolean;
  /** A row that removes something reads in the danger color. */
  danger?: boolean;
  icon?: ReactNode;
  title?: string;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
};

/** A text field in a row's place, such as a name being typed. The owner holds the value. */
export type MenuField = {
  id: string;
  field: {
    /** The field's accessible name. */
    label: string;
    value: string;
    onChange: (value: string) => void;
    /** Enter. Not called while `busy`. */
    onSubmit: () => void;
    /** Escape. The owner puts the row back, and focus returns to it. */
    onCancel: () => void;
    placeholder?: string;
    maxLength?: number;
    /** The owner is acting on the value: it holds, and the field keeps focus. */
    busy?: boolean;
    hint?: ReactNode;
    testId?: string;
  };
};

/** A line between two groups of rows. */
export const MENU_SEPARATOR = "separator";
export type MenuEntry = MenuItem | MenuField | typeof MENU_SEPARATOR;
type MenuRow = MenuItem | MenuField;

/** What the menu needs on its trigger. Spread it onto the owner's button. */
export type MenuTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

const MENU_WIDTH_PX = 144;
// Between the trigger and the list, and between the list and the window's edge.
const GAP_PX = 4;

type Place = { left: number; maxHeight: number; top?: number; bottom?: number; above: boolean };

// The list-row ladder: hover 7%, and 11% for the current or checked row
// whatever has focus. The focused row takes the same fill, and the global
// :focus-visible outline marks it for the keyboard, so it still reads beside
// a current one. The list's padding holds the outline and its offset.
const ROW =
  "flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75 focus:bg-selected aria-disabled:opacity-50";
// Hover paints only after the pointer moves, so a menu opened from the
// keyboard under a still pointer shows one active row.
const ROW_TONE = {
  rest: { base: "text-muted focus:text-ink", hover: "hover:bg-hover hover:text-ink" },
  current: { base: "bg-selected text-ink", hover: "" },
  danger: { base: "text-danger", hover: "hover:bg-hover" },
};

// During IME composition, Enter, Escape and the arrows work the candidate
// list. Some browsers mark those keys only with keyCode 229.
function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function isField(row: MenuRow): row is MenuField {
  return "field" in row;
}

/**
 * A trigger and the list it opens. The owner holds `open`; the menu reports
 * every way it closes through `onOpenChange`: Escape, a press outside, focus
 * leaving, the window blurring, the trigger again, or a pick. Focus moves to
 * the first row on open and back to the trigger on close. Arrow keys, Home,
 * End, and a typed letter move it; Enter or Space picks. A disabled row keeps
 * focus, so a keyboard user still finds it, but a pick on it does nothing.
 *
 * The list sits at a fixed place under the trigger's right edge, or over it
 * when the window has more room there, so a scrolling list or a panel's edge
 * cannot clip it. It scrolls when the window is shorter than it. Rows carry
 * only their label; what a pick does belongs to the owner's `onSelect`. An
 * owner that answers inside the menu (a copied label, a refusal, a field)
 * passes `closeOnPick={false}` and closes when it is done.
 *
 * A field takes the typed keys: letters, Space, Home and End stay in it, and
 * the arrows move to the rows around it. Its Escape ends the typing, and the
 * next one closes the menu.
 */
export function Menu(props: {
  /** The list's accessible name, and the default trigger's. */
  label: string;
  items: readonly MenuEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that opens the list; the ••• icon button named `label` by default. */
  trigger?: (trigger: MenuTriggerProps) => ReactNode;
  /** The default trigger's test id. */
  testId?: string;
  menuTestId?: string;
  width?: number;
  closeOnPick?: boolean;
  /** Rendered under the rows, inside the list. */
  children?: ReactNode;
}) {
  const { open, onOpenChange } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const rowElements = useRef<Array<HTMLElement | null>>([]);
  // The row a cancelled field gives focus back to, once it renders again.
  const refocus = useRef<string | null>(null);
  const width = props.width ?? MENU_WIDTH_PX;
  const [place, setPlace] = useState<Place | null>(null);
  const [pointerMoved, setPointerMoved] = useState(false);
  useDismiss({ open, container, trigger, onClose: () => onOpenChange(false) });

  const rows = props.items.filter((entry): entry is MenuRow => entry !== MENU_SEPARATOR);
  const count = rows.length;
  // One leading column for every row when any row needs it, so labels line up.
  const lead = rows.some((row) => !isField(row) && (row.icon !== undefined || row.checked !== undefined));

  // Measured before the first paint, at its full height, so the side with
  // room is known before anything shows.
  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current?.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    if (box) {
      const left = Math.max(GAP_PX, box.right - width);
      const below = window.innerHeight - box.bottom - 2 * GAP_PX;
      const above = box.top - 2 * GAP_PX;
      setPlace(
        height > below && above > below
          ? { left, bottom: window.innerHeight - box.top + GAP_PX, maxHeight: above, above: true }
          : { left, top: box.bottom + GAP_PX, maxHeight: below, above: false },
      );
    }
    // A field that took focus as it mounted keeps it.
    if (!list.current?.contains(document.activeElement)) rowElements.current[0]?.focus({ preventScroll: true });
    return () => {
      setPlace(null);
      setPointerMoved(false);
    };
  }, [open, width]);

  useLayoutEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    rowElements.current[rows.findIndex((row) => row.id === id)]?.focus();
  });

  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    if (props.closeOnPick !== false) close();
    item.onSelect();
  };
  const typing = () => document.activeElement instanceof HTMLInputElement && !!list.current?.contains(document.activeElement);
  const focusRow = (index: number) => rowElements.current[((index % count) + count) % count]?.focus();
  const current = () => rowElements.current.findIndex((row) => row === document.activeElement);
  const typeahead = (key: string) => {
    const from = current();
    for (let step = 1; step <= count; step += 1) {
      const row = rowElements.current[(from + step) % count];
      if (row?.textContent?.trimStart().toLocaleLowerCase().startsWith(key.toLocaleLowerCase())) {
        row.focus();
        return;
      }
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const inField = typing();
    if (inField && composing(event)) return;
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusRow(current() + 1),
      ArrowUp: () => focusRow(current() - 1),
      ...(inField ? {} : { Home: () => focusRow(0), End: () => focusRow(-1) }),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      move();
    } else if (event.key === "Escape") {
      // useDismiss already closed it; one Escape closes one surface.
      event.stopPropagation();
    } else if (event.key === "Tab") {
      // Closed without moving focus: a dialog's trap may already have chosen
      // where the key goes, and otherwise the focus return puts focus on the
      // trigger before the browser moves on from it.
      onOpenChange(false);
    } else if (!inField && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== " ") {
      typeahead(event.key);
    }
  };

  const triggerProps: MenuTriggerProps = {
    ref: trigger,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onClick: () => onOpenChange(!open),
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        onOpenChange(true);
      }
    },
  };

  let rowIndex = 0;
  return (
    // No box of its own: the trigger lays out where the owner puts it.
    <div ref={container} className="contents">
      {props.trigger ? (
        props.trigger(triggerProps)
      ) : (
        <IconButton {...triggerProps} data-testid={props.testId} aria-label={props.label} title={props.label} className="shrink-0">
          <MoreHorizontal size={14} aria-hidden />
        </IconButton>
      )}
      {open ? (
        <div
          ref={list}
          role="menu"
          aria-label={props.label}
          data-testid={props.menuTestId}
          onKeyDown={onKeyDown}
          // A press on the padding or on what the owner adds under the rows
          // must not send focus to the page, where the keys stop working. A
          // field still takes the press that puts its caret.
          onMouseDown={(event) => {
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
          }}
          onMouseMove={(event) => {
            if (!pointerMoved && (event.movementX || event.movementY)) setPointerMoved(true);
          }}
          style={{
            width,
            ...(place
              ? {
                  left: place.left,
                  top: place.top,
                  bottom: place.bottom,
                  maxHeight: place.maxHeight,
                  // The list enters from its trigger's side.
                  "--dohc-menu-from": place.above ? `${GAP_PX}px` : `-${GAP_PX}px`,
                }
              : { left: 0, top: 0 }),
          } as CSSProperties}
          className={`dohc-popover fixed z-40 overflow-y-auto rounded-lg border border-line bg-panel p-1 ${place ? "dohc-menu-in" : ""}`}
        >
          {props.items.map((entry, entryIndex) => {
            if (entry === MENU_SEPARATOR) {
              return <div key={`separator-${entryIndex}`} role="separator" className="mx-1.5 my-1 h-px bg-line" />;
            }
            const index = rowIndex++;
            const setElement = (element: HTMLElement | null) => {
              rowElements.current[index] = element;
            };
            if (isField(entry)) {
              const { field } = entry;
              return (
                <div key={entry.id} className="py-0.5">
                  <input
                    ref={setElement}
                    autoFocus
                    aria-label={field.label}
                    data-testid={field.testId}
                    value={field.value}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    readOnly={field.busy}
                    onChange={(event) => field.onChange(event.target.value)}
                    // Taken while the key is still on its way down, before the
                    // menu's own Escape closes the whole menu. Escape that
                    // ends a composition, or comes while the owner acts on
                    // the value, leaves the field and the menu as they are.
                    onKeyDownCapture={(event) => {
                      if (event.key !== "Escape") return;
                      event.stopPropagation();
                      if (composing(event) || field.busy) return;
                      refocus.current = entry.id;
                      field.onCancel();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || composing(event)) return;
                      event.preventDefault();
                      if (!field.busy) field.onSubmit();
                    }}
                    className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle"
                  />
                  {field.hint ? <p className="m-0 mt-1 px-2 text-[11px] leading-4 text-subtle">{field.hint}</p> : null}
                </div>
              );
            }
            const tone = entry.danger ? ROW_TONE.danger : entry.current || entry.checked ? ROW_TONE.current : ROW_TONE.rest;
            const hover = pointerMoved ? tone.hover : "";
            return (
              <button
                key={entry.id}
                ref={setElement}
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                aria-current={entry.current || undefined}
                aria-disabled={entry.disabled || undefined}
                title={entry.title}
                data-testid={entry.testId}
                {...entry.data}
                tabIndex={-1}
                // Hover and the keyboard share one active row, but only a
                // pointer that moves takes focus. A row that opens under a
                // still pointer leaves focus on the first row, and a field
                // keeps focus while the pointer crosses the rows.
                onMouseMove={(event) => {
                  if ((event.movementX || event.movementY) && !typing() && document.activeElement !== event.currentTarget) {
                    event.currentTarget.focus();
                  }
                }}
                onClick={() => pick(entry)}
                className={`${ROW} ${tone.base} ${hover}`}
              >
                {lead ? (
                  <span className={`grid size-3.5 shrink-0 place-items-center ${entry.danger ? "" : "text-subtle"}`}>
                    {entry.checked === undefined ? entry.icon : entry.checked ? <Check size={14} aria-hidden className="text-accent" /> : null}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              </button>
            );
          })}
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
