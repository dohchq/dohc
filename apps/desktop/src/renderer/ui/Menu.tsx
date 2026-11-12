import { Check, MoreHorizontal } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { IconButton } from "./controls";
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
  /** The key that runs the row's action outside the menu, shown after its label. `keys` is its aria-keyshortcuts. */
  shortcut?: { label: string; keys: string | undefined };
  /** A second line under the label, such as why a disabled row cannot run. It stays at full strength. */
  description?: string;
  title?: string;
  testId?: string;
  data?: Readonly<Record<`data-${string}`, string>>;
};

/** A line between two groups of rows. */
export const MENU_SEPARATOR = "separator";
/** A label over the rows that follow it, up to the next label. The rows are its group. */
export type MenuSectionLabel = { section: string };
export type MenuEntry = MenuItem | typeof MENU_SEPARATOR | MenuSectionLabel;
const isSectionLabel = (entry: MenuEntry): entry is MenuSectionLabel => entry !== MENU_SEPARATOR && "section" in entry;

/** What the menu needs on its trigger. Spread it onto the owner's button. */
export type MenuTriggerProps = {
  ref: RefObject<HTMLButtonElement | null>;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
};

const MENU_WIDTH_PX = 144;
// Between the trigger and the list.
export const MENU_GAP_PX = 4;
// Between the list and the window's edge, as toasts and the editor's menus keep.
export const MENU_EDGE_PX = 12;

type Place = { left: number; maxHeight: number; top?: number; bottom?: number; above: boolean };

// The Menu part's recipe. A menu whose DOM another owner builds, such as the
// editor's block and table menus, draws itself from these too, so every
// menu has one frame, one row, one ladder and one set of keys.

/** The list's frame. The owner adds its position and width. */
export const MENU_FRAME = "dohc-popover overflow-y-auto rounded-lg border border-line bg-panel p-1";
/**
 * One row. The list-row ladder: hover 7%, and 14% for the current or checked
 * row whatever has focus. A disabled row dims its icon and label, not the
 * row, so its fill and any second line keep their strength.
 */
export const MENU_ROW =
  "flex min-h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75";
export const MENU_ROW_TONE = { rest: "text-muted", current: "bg-selected text-ink font-medium", danger: "text-danger" };
/**
 * The active option of a list whose focus stays on its frame, with
 * aria-activedescendant naming the option: the selected fill, whether the
 * keyboard or the pointer moved it, since it is where Enter acts. Nothing
 * else in the list is filled, so the fill alone marks it. A rest row also
 * takes `data-active:text-ink`; a destructive row keeps its color.
 */
export const MENU_ACTIVE_OPTION = "data-active:bg-selected";
/**
 * The active option of a list that also fills its current row, such as Turn
 * into. While the keyboard moves, it adds the row's accent line, which tells
 * the two apart.
 */
export const MENU_ACTIVE_OPTION_BESIDE_CURRENT =
  `${MENU_ACTIVE_OPTION} keyboard:data-active:outline-1 keyboard:data-active:-outline-offset-1 keyboard:data-active:outline-accent`;
/** The leading icon column; a destructive row keeps its own color here. */
export const MENU_ICON = "grid size-3.5 shrink-0 place-items-center";
export const MENU_LABEL = "min-w-0 flex-1 truncate";
/** A row's label when a detail follows it on the same line, such as a path or a hint. */
export const MENU_TITLE = "max-w-[65%] shrink-0 truncate";
/** The detail after a row's title, in the rest of the row. */
export const MENU_DETAIL = "min-w-0 flex-1 truncate text-[12px] text-muted";
/** The line a list shows when nothing matches. */
export const MENU_EMPTY = "px-2 py-1.5 text-[12px] text-muted";

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
  const offset = `${side === "below" || side === "right" ? "-" : ""}${MENU_GAP_PX}px`;
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

// The Menu part's own rows take DOM focus, so focus is the active row. A
// menu opened with the pointer marks none: focus waits on the row it opened
// on for the keys, and the hover fill follows the pointer, as in a native
// menu. A menu opened from the keyboard, or the first key that moves, marks
// the focused row as MENU_ACTIVE_OPTION draws it: the fill alone, or the fill
// and the row's line in a menu that also fills a current or checked row. The
// mark then follows focus wherever the pointer moves it.
const MARKED = "focus:bg-selected";
const ROW_FOCUS = { besideCurrent: "dohc-focus-row", alone: "focus-visible:outline-none" };
// Hover paints only after the pointer moves, so a menu opened from the
// keyboard under a still pointer shows one active row.
const ROW_TONE = {
  rest: { base: MENU_ROW_TONE.rest, marked: "focus:text-ink", hover: "hover:bg-hover hover:text-ink" },
  current: { base: MENU_ROW_TONE.current, marked: "", hover: "" },
  danger: { base: MENU_ROW_TONE.danger, marked: "", hover: "hover:bg-hover" },
};

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
 * owner that answers inside the menu (a copied label, a refusal) passes
 * `closeOnPick={false}` and closes when it is done.
 *
 * A context menu passes `at` instead of a trigger: the list opens at that
 * point, below it or over it as the room allows, and focus goes back to what
 * had it when the list opened, such as the row that was right-clicked.
 */
export function Menu(props: {
  /** The list's accessible name, and the default trigger's. */
  label: string;
  items: readonly MenuEntry[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that opens the list; the ••• icon button named `label` by default. */
  trigger?: (trigger: MenuTriggerProps) => ReactNode;
  /** Where a context menu opens, in window coordinates. No trigger is drawn. */
  at?: { x: number; y: number };
  /** A menu the keyboard opened away from its trigger, such as a context menu, marks the row it opens on at once. A trigger's own keys mark it themselves. */
  fromKeyboard?: boolean;
  /** The default trigger's test id. */
  testId?: string;
  /** The default trigger stays in its place but cannot open the list. */
  disabled?: boolean;
  menuTestId?: string;
  width?: number;
  /** The list lines up with the trigger's right edge, or with its left at "start". */
  align?: "start" | "end";
  /** The list opens under or over this box instead of the trigger, still lined up with the trigger. */
  anchor?: RefObject<HTMLElement | null>;
  closeOnPick?: boolean;
  /** The list opens over the page, for a trigger inside a box that clips it, such as a chat row. */
  topLayer?: boolean;
  /** Rendered under the rows, inside the list. */
  children?: ReactNode;
}) {
  const { open, onOpenChange } = props;
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const rowElements = useRef<Array<HTMLElement | null>>([]);
  const width = props.width ?? MENU_WIDTH_PX;
  const [place, setPlace] = useState<Place | null>(null);
  const [pointerMoved, setPointerMoved] = useState(false);
  // Whether focus shows as the active row. Cleared when the list closes.
  const [marked, setMarked] = useState(false);
  useDismiss({ open, container, trigger, onClose: () => onOpenChange(false) });

  const rows = props.items.filter((entry): entry is MenuItem => entry !== MENU_SEPARATOR && !isSectionLabel(entry));
  const count = rows.length;
  // The row focus starts on: the checked one, where Enter keeps things as they are.
  const checkedRow = rows.findIndex((row) => row.checked === true);
  const openRow = useRef(0);
  openRow.current = Math.max(0, checkedRow);
  const descriptionId = useId();
  // One leading column for every row when any row needs it, so labels line up.
  const lead = rows.some((row) => row.icon !== undefined || row.checked !== undefined);
  const rowFocus = rows.some((row) => row.current || row.checked) ? ROW_FOCUS.besideCurrent : ROW_FOCUS.alone;

  // Measured before the first paint, at its full height, so the side with
  // room is known before anything shows. A context menu's point is a trigger
  // with no size: the list starts at it, with no gap.
  const at = props.at;
  const fromKeyboard = props.fromKeyboard === true;
  useLayoutEffect(() => {
    if (!open) return;
    if (fromKeyboard) setMarked(true);
    if (props.topLayer) list.current?.showPopover?.();
    const box = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y } : trigger.current?.getBoundingClientRect();
    // A context menu places at its point; a trigger's list opens under or over its anchor when it has one.
    const edge = at ? box : props.anchor?.current?.getBoundingClientRect() ?? box;
    const gap = at ? 0 : MENU_GAP_PX;
    const height = list.current?.offsetHeight ?? 0;
    if (box && edge) {
      // A context menu's list starts at its point, as a trigger's does at "start".
      const left = at || props.align === "start"
        ? Math.max(MENU_EDGE_PX, Math.min(box.left, window.innerWidth - MENU_EDGE_PX - width))
        : Math.max(MENU_EDGE_PX, Math.min(box.right, window.innerWidth - MENU_EDGE_PX) - width);
      const below = window.innerHeight - edge.bottom - gap - MENU_EDGE_PX;
      const above = edge.top - gap - MENU_EDGE_PX;
      setPlace(
        height > below && above > below
          ? { left, bottom: window.innerHeight - edge.top + gap, maxHeight: above, above: true }
          : { left, top: edge.bottom + gap, maxHeight: below, above: false },
      );
    }
    rowElements.current[openRow.current]?.focus({ preventScroll: true });
    return () => {
      setPlace(null);
      setPointerMoved(false);
      setMarked(false);
    };
  }, [open, width, at?.x, at?.y, fromKeyboard, props.align, props.anchor, props.topLayer]);

  // Placed, a list shorter than its rows shows its top, so it scrolls to the
  // row focus opened on.
  useLayoutEffect(() => {
    const row = rowElements.current[openRow.current];
    if (place && list.current && row === document.activeElement) revealMenuRow(list.current, row);
  }, [place]);

  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.disabled) return;
    if (props.closeOnPick !== false) close();
    item.onSelect();
  };
  const current = () => rowElements.current.findIndex((row) => row === focusedElementIn(row));
  const onKeyDown = (event: KeyboardEvent) => {
    // A key runs only a row a person can see marked. Until one is, Enter and
    // Space mark the row the menu opened on: the checked one, or else the
    // first. Space clicks on keyup, which the prevented keydown also stops.
    if (!marked && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      setMarked(true);
      rowElements.current[openRow.current]?.focus();
      return;
    }
    const arrow = event.key === "ArrowDown" || event.key === "ArrowUp";
    const letter = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    // The first key in a list with no marked row moves from outside it, so Down
    // marks the first row and Up the last. A list that opened on its checked
    // row moves from there.
    const from = marked || checkedRow >= 0 ? current() : event.key === "ArrowUp" ? count : -1;
    const next = arrow || letter || event.key === "Home" || event.key === "End"
      ? moveInMenu(event, from, rows.map((row, index) =>
        typeof row.label === "string" ? row.label : rowElements.current[index]?.textContent ?? ""))
      : null;
    if (next !== null) {
      if (!letter) event.preventDefault();
      setMarked(true);
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
    // Enter and Space click with no pointer press, so detail is 0.
    onClick: (event) => {
      setMarked(event.detail === 0);
      onOpenChange(!open);
    },
    onKeyDown: (event) => {
      if (event.key === "ArrowDown" && !open) {
        event.preventDefault();
        setMarked(true);
        onOpenChange(true);
      }
    },
  };

  // Rows under a label are its group; rows before the first label stand alone.
  const sections: Array<{ label: string | null; entries: Array<{ entry: MenuItem | typeof MENU_SEPARATOR; entryIndex: number }> }> = [];
  props.items.forEach((entry, entryIndex) => {
    if (isSectionLabel(entry)) sections.push({ label: entry.section, entries: [] });
    else {
      if (sections.length === 0) sections.push({ label: null, entries: [] });
      sections.at(-1)!.entries.push({ entry, entryIndex });
    }
  });
  let rowIndex = 0;
  return (
    // No box of its own: the trigger lays out where the owner puts it.
    <div ref={container} className="contents">
      {at ? null : props.trigger ? (
        props.trigger(triggerProps)
      ) : (
        <IconButton {...triggerProps} disabled={props.disabled} data-testid={props.testId} aria-label={props.label} title={props.label} className="shrink-0">
          <MoreHorizontal size={14} aria-hidden />
        </IconButton>
      )}
      {open ? (
        <div
          ref={list}
          popover={props.topLayer ? "manual" : undefined}
          role="menu"
          aria-label={props.label}
          data-testid={props.menuTestId}
          onKeyDown={onKeyDown}
          // A press on the padding or on what the owner adds under the rows
          // must not send focus to the page, where the keys stop working. A
          // field the owner adds still takes the press that puts its caret.
          onMouseDown={(event) => {
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
          }}
          onMouseMove={(event) => {
            if (!pointerMoved && movedPointer(event)) setPointerMoved(true);
          }}
          style={{
            width,
            ...(props.topLayer ? { margin: 0, inset: "auto" } : {}),
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
          {sections.map((section, sectionIndex) => {
            const sectionRows = section.entries.map(({ entry, entryIndex }) => {
            if (entry === MENU_SEPARATOR) {
              return <div key={`separator-${entryIndex}`} role="separator" className={MENU_SEPARATOR_LINE} />;
            }
            const index = rowIndex++;
            const setElement = (element: HTMLElement | null) => {
              rowElements.current[index] = element;
            };
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
                aria-keyshortcuts={entry.shortcut?.keys}
                aria-describedby={describedBy}
                title={entry.title}
                data-testid={entry.testId}
                {...entry.data}
                tabIndex={-1}
                // Hover and the keyboard share one active row, but only a
                // pointer that moves takes focus. A row that opens under a
                // still pointer leaves focus where the menu opened.
                onMouseMove={(event) => {
                  if (movedPointer(event) && document.activeElement !== event.currentTarget) {
                    event.currentTarget.focus();
                  }
                }}
                onClick={() => pick(entry)}
                className={`${MENU_ROW} ${rowFocus} ${tone.base} ${marked ? `${MARKED} ${tone.marked}` : "outline-none"} ${hover} ${describedBy ? "py-1" : ""}`}
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
                {entry.shortcut ? <kbd aria-hidden className={`${MENU_SHORTCUT} ${dim}`}>{entry.shortcut.label}</kbd> : null}
              </button>
            );
            });
            if (section.label === null) return sectionRows;
            const labelId = `${descriptionId}-section-${sectionIndex}`;
            return (
              <div key={labelId} role="group" aria-labelledby={labelId} className={sectionIndex > 0 ? "mt-1" : undefined}>
                <div id={labelId} className={MENU_SECTION}>{section.label}</div>
                {sectionRows}
              </div>
            );
          })}
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
