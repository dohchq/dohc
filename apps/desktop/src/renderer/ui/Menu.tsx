import { Check, MoreHorizontal } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconButton } from "./controls";
import { isComposingKey } from "./keys";
import { focusedElementIn } from "./focusedElement";
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
  /** A second line under the label, such as why a disabled row cannot run. It stays at full strength. */
  description?: string;
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
    /** A line under the field that describes it. */
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
// Between the trigger and the list.
const GAP_PX = 4;
// Between the list and the window's edge, as toasts and the editor's menus keep.
const EDGE_PX = 12;

type Place = { left: number; maxHeight: number; top?: number; bottom?: number; above: boolean };

// The Menu part's recipe. A menu whose DOM another owner builds, such as the
// editor's block and table menus, draws itself from these too, so every
// menu has one frame, one row, one ladder and one set of keys.

/** The list's frame. The owner adds its position and width. */
export const MENU_FRAME = "dohc-popover overflow-y-auto rounded-lg border border-line bg-panel p-1";
/**
 * One row. The list-row ladder: hover 7%, and 11% for the current or checked
 * row whatever has focus. A disabled row dims its icon and label, not the
 * row, so the focus outline and any second line keep their strength.
 */
export const MENU_ROW =
  "flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75";
export const MENU_ROW_TONE = { rest: "text-muted", current: "bg-selected text-ink", danger: "text-danger" };
/**
 * The active option of a list whose focus stays on its frame, with
 * aria-activedescendant naming the option: the selected fill and the accent
 * outline inside the row, whether the keyboard or the pointer moved it, since
 * it is where Enter acts. The fill alone measures about 1.2:1. A rest row
 * also takes `data-active:text-ink`; a destructive row keeps its color.
 */
export const MENU_ACTIVE_OPTION =
  "data-active:bg-selected data-active:outline-2 data-active:outline-accent data-active:-outline-offset-2";
/** The leading icon column; a destructive row keeps its own color here. */
export const MENU_ICON = "grid size-3.5 shrink-0 place-items-center";
export const MENU_LABEL = "min-w-0 flex-1 truncate";
/** A row's label when a detail follows it on the same line, such as a path or a hint. */
export const MENU_TITLE = "max-w-[65%] shrink-0 truncate";
/** The detail after a row's title, in the rest of the row. */
export const MENU_DETAIL = "min-w-0 flex-1 truncate text-[12px] text-subtle";
/** The line a list shows when nothing matches. */
export const MENU_EMPTY = "px-2 py-1.5 text-[12px] text-subtle";

/**
 * Whether a mousemove came from a pointer that moved. A row that opens or
 * scrolls under a still pointer gets mouse events too, and must not take the
 * active row from the keyboard.
 */
export function movedPointer(event: { movementX: number; movementY: number }): boolean {
  return event.movementX !== 0 || event.movementY !== 0;
}
/** A row's shortcut, after its label. Hidden from the row's name; the row says it with aria-keyshortcuts. */
export const MENU_SHORTCUT = "shrink-0 font-sans text-[12px] text-subtle";

/**
 * The key that runs a menu's destructive row, labelled as the keyboard in
 * front of the person labels it: ⌫ on macOS, where that key is Backspace,
 * and Del elsewhere. `keys` is the row's aria-keyshortcuts.
 */
export function deleteShortcut(platform = window.dohcDesktop?.platform): { label: string; keys: string } {
  return platform === "darwin" ? { label: "⌫", keys: "Backspace" } : { label: "Del", keys: "Delete" };
}

/**
 * Scrolls a menu's list just enough to show a row, as block "nearest" would,
 * keeping the list's own padding around it. Only the list scrolls:
 * scrollIntoView would also scroll the editor's pane or the window. `start`
 * is the element whose top must show too, such as the row's section label.
 * For a list whose focus stays on its frame; a row that takes focus is
 * revealed by the browser.
 */
export function revealMenuRow(list: HTMLElement, row: HTMLElement | null | undefined, start: HTMLElement | null = row ?? null): void {
  if (!row || !start) return;
  const style = list.ownerDocument.defaultView?.getComputedStyle(list);
  const top = start.offsetTop - (Number.parseFloat(style?.paddingTop ?? "") || 0);
  const bottom = row.offsetTop + row.offsetHeight + (Number.parseFloat(style?.paddingBottom ?? "") || 0);
  if (top < list.scrollTop) list.scrollTop = Math.max(0, top);
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
export const MENU_SEPARATOR_LINE = "mx-1.5 my-1 h-px bg-line";
export const MENU_SECTION = "dohc-section-label px-2 pb-1 pt-1.5";
/** The entrance: 130ms, rising 4px from the trigger's side, a 60ms fade under reduced motion. */
export const MENU_ENTER = "dohc-menu-in";
/** The custom properties MENU_ENTER reads: where the list starts, toward its trigger. */
export function menuEnterFrom(side: "above" | "below" | "left" | "right"): CSSProperties {
  const offset = `${side === "below" || side === "right" ? "-" : ""}${GAP_PX}px`;
  const properties: Record<string, string> =
    side === "left" || side === "right"
      ? { "--dohc-menu-from": "0px", "--dohc-menu-from-x": offset }
      : { "--dohc-menu-from": offset };
  return properties as CSSProperties;
}

/**
 * Where a key moves a menu's active row among `labels`: the arrows wrap,
 * Home and End jump, and a typed letter finds the next row whose label
 * starts with it. Null for every other key, for a letter no row starts with,
 * and for a letter held with Ctrl, Meta or Alt, which is a shortcut the app
 * answers, so the caller leaves it alone.
 */
export function moveInMenu(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
  current: number,
  labels: readonly string[],
): number | null {
  const { key } = event;
  const count = labels.length;
  if (count === 0) return null;
  const wrap = (index: number) => ((index % count) + count) % count;
  if (key === "ArrowDown") return wrap(current + 1);
  if (key === "ArrowUp") return wrap(current - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key.length !== 1 || key === " " || event.ctrlKey || event.metaKey || event.altKey) return null;
  const letter = key.toLocaleLowerCase();
  for (let step = 1; step <= count; step += 1) {
    const index = wrap(current + step);
    if (labels[index]?.trimStart().toLocaleLowerCase().startsWith(letter)) return index;
  }
  return null;
}

// The Menu part's own rows take DOM focus, so focus is the active row: the
// fill and the accent outline, whether the keyboard or the pointer moved it,
// as MENU_ACTIVE_OPTION draws it. The fill alone would match the current
// row's. The list scrolls, so the outline sits inside the row, where the
// scroller cannot clip it on a row scrolled to an edge.
const ROW = `${MENU_ROW} focus:bg-selected focus:outline-2 focus:outline-accent focus:-outline-offset-2`;
// Hover paints only after the pointer moves, so a menu opened from the
// keyboard under a still pointer shows one active row.
const ROW_TONE = {
  rest: { base: `${MENU_ROW_TONE.rest} focus:text-ink`, hover: "hover:bg-hover hover:text-ink" },
  current: { base: MENU_ROW_TONE.current, hover: "" },
  danger: { base: MENU_ROW_TONE.danger, hover: "hover:bg-hover" },
};

function isField(row: MenuRow): row is MenuField {
  return "field" in row;
}

/**
 * A trigger and the list it opens. The owner holds `open`; the menu reports
 * every way it closes through `onOpenChange`: Escape, a press outside, focus
 * leaving, the window blurring, the trigger again, or a pick. Focus moves to
 * the checked row on open, or to the first row when no row is checked, and
 * back to the trigger on close. Arrow keys, Home, End, and a typed letter
 * move it; Enter or Space picks. A disabled row keeps focus, so a keyboard
 * user still finds it, but a pick on it does nothing. Its description says
 * why on a second line.
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
  /** The default trigger stays in its place but cannot open the list. */
  disabled?: boolean;
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
  // The row focus starts on: the checked one, where Enter keeps things as they are.
  const openRow = useRef(0);
  openRow.current = Math.max(0, rows.findIndex((row) => !isField(row) && row.checked === true));
  const descriptionId = useId();
  // One leading column for every row when any row needs it, so labels line up.
  const lead = rows.some((row) => !isField(row) && (row.icon !== undefined || row.checked !== undefined));

  // Measured before the first paint, at its full height, so the side with
  // room is known before anything shows.
  useLayoutEffect(() => {
    if (!open) return;
    const box = trigger.current?.getBoundingClientRect();
    const height = list.current?.offsetHeight ?? 0;
    if (box) {
      const left = Math.max(EDGE_PX, Math.min(box.right, window.innerWidth - EDGE_PX) - width);
      const below = window.innerHeight - box.bottom - GAP_PX - EDGE_PX;
      const above = box.top - GAP_PX - EDGE_PX;
      setPlace(
        height > below && above > below
          ? { left, bottom: window.innerHeight - box.top + GAP_PX, maxHeight: above, above: true }
          : { left, top: box.bottom + GAP_PX, maxHeight: below, above: false },
      );
    }
    // A field that took focus as it mounted keeps it.
    if (!list.current?.contains(document.activeElement)) rowElements.current[openRow.current]?.focus({ preventScroll: true });
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
  const typing = () => {
    const focused = focusedElementIn(list.current);
    return focused instanceof HTMLInputElement && !!list.current?.contains(focused);
  };
  const current = () => rowElements.current.findIndex((row) => row === focusedElementIn(row));
  const onKeyDown = (event: KeyboardEvent) => {
    const inField = typing();
    if (inField && isComposingKey(event)) return;
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
    const letter = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    // A field keeps Home, End and the typed letters; the arrows leave it.
    const next = arrow || (!inField && (letter || event.key === "Home" || event.key === "End"))
      ? moveInMenu(event, current(), rows.map((row, index) =>
        "label" in row && typeof row.label === "string" ? row.label : rowElements.current[index]?.textContent ?? ""))
      : null;
    if (next !== null) {
      if (!letter) event.preventDefault();
      rowElements.current[next]?.focus();
    } else if (event.key === "Escape") {
      // useDismiss already closed it; one Escape closes one surface.
      event.stopPropagation();
    } else if (event.key === "Tab") {
      // Closed without moving focus: a dialog's trap may already have chosen
      // where the key goes, and otherwise the focus return puts focus on the
      // trigger before the browser moves on from it.
      onOpenChange(false);
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
        <IconButton {...triggerProps} disabled={props.disabled} data-testid={props.testId} aria-label={props.label} title={props.label} className="shrink-0">
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
            if (!pointerMoved && movedPointer(event)) setPointerMoved(true);
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
                  ...menuEnterFrom(place.above ? "above" : "below"),
                }
              : { left: 0, top: 0 }),
          } as CSSProperties}
          className={`${MENU_FRAME} fixed z-40 ${place ? MENU_ENTER : ""}`}
        >
          {props.items.map((entry, entryIndex) => {
            if (entry === MENU_SEPARATOR) {
              return <div key={`separator-${entryIndex}`} role="separator" className={MENU_SEPARATOR_LINE} />;
            }
            const index = rowIndex++;
            const setElement = (element: HTMLElement | null) => {
              rowElements.current[index] = element;
            };
            if (isField(entry)) {
              const { field } = entry;
              const hintId = field.hint ? `${descriptionId}-${index}` : undefined;
              return (
                <div key={entry.id} className="relative py-0.5">
                  <input
                    ref={setElement}
                    autoFocus
                    aria-label={field.label}
                    aria-describedby={hintId}
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
                      if (isComposingKey(event) || field.busy) return;
                      refocus.current = entry.id;
                      field.onCancel();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || isComposingKey(event)) return;
                      event.preventDefault();
                      if (!field.busy) field.onSubmit();
                    }}
                    className="h-7 w-full rounded-md border border-line bg-bg pl-2 pr-7 text-[13px] text-ink placeholder:text-subtle"
                  />
                  {/* Enter submits every field; the key says so at its end. */}
                  <kbd aria-hidden className="pointer-events-none absolute right-1.5 top-2 rounded border border-line bg-bg px-1 font-sans text-[10px] leading-[14px] text-subtle">↵</kbd>
                  {field.hint ? <p id={hintId} className="m-0 mt-1 px-2 text-[11px] leading-4 text-subtle">{field.hint}</p> : null}
                </div>
              );
            }
            const tone = entry.danger ? ROW_TONE.danger : entry.current || entry.checked ? ROW_TONE.current : ROW_TONE.rest;
            const hover = pointerMoved ? tone.hover : "";
            const dim = entry.disabled ? "opacity-50" : "";
            const describedBy = entry.description ? `${descriptionId}-${index}` : undefined;
            return (
              <button
                key={entry.id}
                ref={setElement}
                type="button"
                role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={entry.checked}
                aria-current={entry.current || undefined}
                aria-disabled={entry.disabled || undefined}
                aria-describedby={describedBy}
                title={entry.title}
                data-testid={entry.testId}
                {...entry.data}
                tabIndex={-1}
                // Hover and the keyboard share one active row, but only a
                // pointer that moves takes focus. A row that opens under a
                // still pointer leaves focus where the menu opened, and a field
                // keeps focus while the pointer crosses the rows.
                onMouseMove={(event) => {
                  if (movedPointer(event) && !typing() && document.activeElement !== event.currentTarget) {
                    event.currentTarget.focus();
                  }
                }}
                onClick={() => pick(entry)}
                className={`${ROW} ${tone.base} ${hover} ${describedBy ? "py-1" : ""}`}
              >
                {lead ? (
                  // Beside a description, the icon sits on the label's line.
                  <span className={`${MENU_ICON} ${entry.danger ? "" : "text-subtle"} ${dim} ${describedBy ? "mt-[3px] self-start" : ""}`}>
                    {entry.checked === undefined ? entry.icon : entry.checked ? <Check size={14} aria-hidden className="text-accent" /> : null}
                  </span>
                ) : null}
                {describedBy ? (
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate leading-5 ${dim}`}>{entry.label}</span>
                    {/* The row is named by its label; this line is its description. */}
                    <span id={describedBy} aria-hidden className="block text-[12px] leading-4 text-muted">{entry.description}</span>
                  </span>
                ) : (
                  <span className={`${MENU_LABEL} ${dim}`}>{entry.label}</span>
                )}
              </button>
            );
          })}
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
