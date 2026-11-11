import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Plus, X } from "lucide-react";
import { addDays } from "date-fns/addDays";
import { addMonths } from "date-fns/addMonths";
import { eachDayOfInterval } from "date-fns/eachDayOfInterval";
import { endOfMonth } from "date-fns/endOfMonth";
import { endOfWeek } from "date-fns/endOfWeek";
import { format } from "date-fns/format";
import { isSameDay } from "date-fns/isSameDay";
import { isSameMonth } from "date-fns/isSameMonth";
import { isValid } from "date-fns/isValid";
import { parse } from "date-fns/parse";
import { startOfMonth } from "date-fns/startOfMonth";
import { startOfWeek } from "date-fns/startOfWeek";
import type { CollectionValue, FieldDefinition, OptionColor } from "@dohc/workspace-contracts";
import { OptionColorPicker } from "../colorPicker";
import {
  sameSelection,
  useAcknowledgedSelection,
  type CarriedSelection,
} from "../useAcknowledgedSelection";
import { OptionPill, optionColor, PersonChip } from "../values";

// The pickers a cell opens in place of a browser control: options, tags, a
// date, and people. Each is a popover on its cell, drawn in the table's
// editor overlay.

// During IME composition, Enter and Escape work the candidate list. Some
// browsers mark those keys only with keyCode 229.
export function composing(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** Where the selection goes when a key closes an editor: one row down, or one cell on or back. */
export type CellMove = "down" | "next" | "previous";

/**
 * Closes an editor. A key that saves says where the selection goes. "away"
 * is a press outside the editor: the selection stays, and focus belongs to
 * what was pressed.
 */
export type CellClose = (to?: CellMove | "away") => void;

type OptionField = Extract<FieldDefinition, { type: "select" | "multi-select" }>;

/** A person the host lets a person field name. */
export interface TablePerson {
  id: string;
  name: string;
}

const PICKER_WIDTH = 240;
const DATE_PICKER_WIDTH = 250;

/** How wide a field's picker is, or null for a field edited in its cell. */
export function pickerWidth(field: FieldDefinition, hasPeople: boolean): number | null {
  if (field.type === "date") return DATE_PICKER_WIDTH;
  if (field.type === "select" || field.type === "multi-select") return PICKER_WIDTH;
  return field.type === "person" && hasPeople ? PICKER_WIDTH : null;
}

/** A paused table keeps its picker open, with what it holds, and saves nothing. */
function paused(element: Element): boolean {
  return element.closest("fieldset:disabled") !== null;
}

/**
 * The frame every picker shares. A press outside saves what the picker
 * holds and closes it. Tab does the same and moves the selection sideways,
 * as in a text cell. Escape closes it and saves nothing.
 */
function PickerFrame({ save, close, children }: {
  /** Saves picks the picker still holds. A picker that saves each pick has none. */
  save?: () => void;
  close: CellClose;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const leave = useRef<(to: CellMove | "away") => void>(() => {});
  leave.current = (to) => {
    save?.();
    close(to);
  };
  useEffect(() => {
    const press = (event: PointerEvent) => {
      const element = frame.current;
      if (!element || element.contains(event.target as Node) || paused(element)) return;
      leave.current("away");
    };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, []);
  return (
    <div
      ref={frame}
      className="flex flex-col gap-1 p-1"
      // The table's fieldset disables only form controls. A paused picker's
      // rows and calendar take no press and no key either.
      onClickCapture={(event) => {
        if (paused(event.currentTarget)) event.stopPropagation();
      }}
      onKeyDownCapture={(event) => {
        if (paused(event.currentTarget)) event.stopPropagation();
      }}
      // A press inside leaves focus where the keys work: in the search box,
      // or on the calendar.
      onMouseDown={(event) => {
        if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (composing(event)) return;
        if (event.key === "Escape") close();
        else if (event.key === "Tab") {
          event.preventDefault();
          leave.current(event.shiftKey ? "previous" : "next");
        }
      }}
    >
      {children}
    </div>
  );
}

interface PickRow {
  key: string;
  content: ReactNode;
  /** The row is the cell's value, or one of its values. */
  checked?: boolean;
  pick: () => void;
  /** The option's color, where the host lets people change it. */
  color?: { option: string; value: OptionColor; change: (color: OptionColor) => void };
}

const ROW_ICON = { size: 14, strokeWidth: 1.9, "aria-hidden": true, className: "shrink-0" } as const;

/**
 * A search box over a list of rows. Focus stays in the box: the arrow keys
 * move a highlight through the rows, the pointer moves it too, and Enter
 * picks the highlighted row.
 */
function SearchList({ searchLabel, listLabel, multi = false, query, onQuery, rows, startAt = 0, chips, onBackspaceEmpty, empty, footer }: {
  searchLabel: string;
  listLabel: string;
  multi?: boolean;
  query: string;
  onQuery: (query: string) => void;
  rows: PickRow[];
  /** The row highlighted when the picker opens. */
  startAt?: number;
  /** The picks so far, drawn in the search box before the typed text. */
  chips?: ReactNode[];
  onBackspaceEmpty?: () => void;
  /** What the list says when it has no rows. */
  empty: string;
  footer?: ReactNode;
}) {
  const [active, setActive] = useState(startAt);
  // A new search starts at its first match.
  const [searched, setSearched] = useState(query);
  if (searched !== query) {
    setSearched(query);
    setActive(0);
  }
  // The option whose colors are open, and whether a key opened them.
  const [coloring, setColoring] = useState<{ key: string; byKey: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  const at = Math.min(active, rows.length - 1);
  const move = (step: number) => {
    if (rows.length === 0) return;
    const next = (Math.max(at, 0) + step + rows.length) % rows.length;
    setActive(next);
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
  };
  const closeColors = () => {
    setColoring(null);
    input.current?.focus();
  };
  const search = (
    <input
      ref={input}
      autoFocus
      type="text"
      role="combobox"
      aria-label={searchLabel}
      aria-expanded="true"
      aria-controls={listId}
      aria-autocomplete="list"
      aria-activedescendant={at >= 0 ? optionId(at) : undefined}
      placeholder={chips?.length ? undefined : searchLabel}
      value={query}
      onChange={(event) => {
        setColoring(null);
        onQuery(event.currentTarget.value);
      }}
      // The character that opened the picker is already typed.
      onFocus={(event) => {
        const end = event.currentTarget.value.length;
        event.currentTarget.setSelectionRange(end, end);
      }}
      onKeyDown={(event) => {
        if (composing(event)) return;
        const { key } = event;
        const row = rows[at];
        if (key === "ArrowDown" || key === "ArrowUp") {
          event.preventDefault();
          move(key === "ArrowDown" ? 1 : -1);
        } else if (key === "Enter") {
          event.preventDefault();
          row?.pick();
        } else if (key === "Backspace" && query === "" && onBackspaceEmpty) {
          event.preventDefault();
          onBackspaceEmpty();
        } else if (key === "Escape" && coloring) {
          // Open colors take the first Escape. The next one closes the picker.
          event.stopPropagation();
          setColoring(null);
        } else if (key === "ArrowRight" && row?.color && event.currentTarget.selectionStart === query.length) {
          // As in a menu, the right arrow opens what the row's button opens.
          event.preventDefault();
          setColoring({ key: row.key, byKey: true });
        }
      }}
      className={
        chips
          // The band's border shows focus, as a text field's does.
          ? "h-5 min-w-12 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
          : "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
      }
    />
  );
  return (
    <>
      {chips ? (
        <div
          className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-bg px-1.5 py-1 focus-within:border-ink"
          onClick={() => input.current?.focus()}
        >
          {chips}
          {search}
        </div>
      ) : search}
      <div
        id={listId}
        role="listbox"
        aria-label={listLabel}
        aria-multiselectable={multi || undefined}
        className="flex max-h-64 flex-col overflow-y-auto"
      >
        {rows.map((row, index) => (
          <div key={row.key} role="presentation">
            <div
              role="presentation"
              data-active={index === at ? "" : undefined}
              className="flex h-8 items-center rounded-md text-muted transition-colors duration-75 data-active:bg-selected data-active:text-ink"
              onPointerMove={() => {
                if (index !== at) setActive(index);
              }}
            >
              <div
                id={optionId(index)}
                role="option"
                aria-selected={row.checked === true}
                className="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 px-2 text-[13px]"
                onClick={row.pick}
              >
                {row.content}
                {row.checked ? <Check {...ROW_ICON} className="ml-auto shrink-0 text-ink" /> : null}
              </div>
              {row.color ? (
                <button
                  type="button"
                  // The right arrow opens the colors from the search box.
                  tabIndex={-1}
                  aria-label={`${row.color.option} options`}
                  title={`${row.color.option} options`}
                  aria-expanded={coloring?.key === row.key}
                  onClick={() => setColoring(coloring?.key === row.key ? null : { key: row.key, byKey: false })}
                  className="mr-1 grid size-6 shrink-0 place-items-center rounded-md text-subtle opacity-0 transition-opacity duration-75 hover:bg-hover hover:text-ink aria-expanded:opacity-100 in-data-[active]:opacity-100"
                >
                  <MoreHorizontal {...ROW_ICON} />
                </button>
              ) : null}
            </div>
            {row.color && coloring?.key === row.key ? (
              <div
                className="flex h-8 items-center px-2"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  // Escape closes the colors and leaves the picker open.
                  event.stopPropagation();
                  closeColors();
                }}
              >
                <OptionColorPicker
                  label={`Color for ${row.color.option}`}
                  value={row.color.value}
                  autoFocus={coloring.byKey}
                  onChange={(color) => {
                    closeColors();
                    if (color !== row.color?.value) row.color?.change(color);
                  }}
                />
              </div>
            ) : null}
          </div>
        ))}
        {rows.length === 0 ? <p className="m-0 px-2 py-1 text-[12px] text-muted">{empty}</p> : null}
        {footer}
      </div>
    </>
  );
}

function matches(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

function optionRow(
  field: OptionField,
  option: string,
  checked: boolean,
  pick: () => void,
  onColor: ((option: string, color: OptionColor) => void) | undefined,
): PickRow {
  const color = optionColor(field, option);
  return {
    key: `option:${option}`,
    content: <OptionPill label={option} color={color} dot={field.type === "select"} />,
    checked,
    pick,
    ...(onColor ? { color: { option, value: color, change: (next: OptionColor) => onColor(option, next) } } : {}),
  };
}

function createContent(field: OptionField, name: string): ReactNode {
  return (
    <>
      <Plus {...ROW_ICON} />
      {/* The space keeps the row's name two words for a screen reader. */}
      {"Create "}
      <OptionPill label={name} color={optionColor(field, name)} dot={field.type === "select"} />
    </>
  );
}

function noOptions(name: string, canCreate: boolean): string {
  if (name !== "") return `No options match "${name}".`;
  return canCreate ? "No options yet. Type a name to create one." : "This field has no options yet.";
}

interface OptionPickerProps {
  field: OptionField;
  /** The field's name as people read it. */
  label: string;
  /** The character that opened the picker. It starts the search. */
  typed?: string;
  close: CellClose;
  /** Changes an option's color. Absent, the options offer no colors. */
  onColor?: (option: string, color: OptionColor) => void;
}

/** One option for a select field. A pick saves and closes. */
export function OptionPicker({ field, label, current, typed, emit, close, onCreateOption, onColor }: OptionPickerProps & {
  current: string | null;
  emit: (value: CollectionValue) => number;
  onCreateOption?: (option: string, nextValue: CollectionValue) => void;
}) {
  const [query, setQuery] = useState(typed ?? "");
  const name = query.trim();
  const pick = (next: string | null) => {
    if (next !== current) emit(next);
    close();
  };
  const rows = field.options
    .filter((option) => matches(option, name.toLowerCase()))
    .map((option) => optionRow(field, option, option === current, () => pick(option), onColor));
  if (onCreateOption && name !== "" && !field.options.includes(name)) {
    rows.push({
      key: "create",
      content: createContent(field, name),
      pick: () => {
        onCreateOption(name, name);
        close();
      },
    });
  }
  // A search shows only what it matches, so Enter never clears by surprise.
  if (current !== null && name === "") {
    rows.push({ key: "clear", content: <><X {...ROW_ICON} />Clear</>, pick: () => pick(null) });
  }
  return (
    <PickerFrame close={close}>
      <SearchList
        searchLabel="Search options"
        listLabel={`${label} options`}
        query={query}
        onQuery={setQuery}
        rows={rows}
        // Enter on a picker just opened keeps the value it has.
        startAt={current === null || typed !== undefined ? 0 : Math.max(0, field.options.indexOf(current))}
        empty={noOptions(name, onCreateOption !== undefined)}
      />
    </PickerFrame>
  );
}

const NO_PICKS: { added: string[]; removed: string[]; created: string | null } = { added: [], removed: [], created: null };

/**
 * Any number of options for a multi-select field. Picks change only what
 * the picker shows. It saves once, when it closes, and Escape drops the
 * picks. The picks replay over the value the table shows, so a change from
 * elsewhere that arrives while the picker is open is kept.
 */
export function TagsPicker({
  field,
  label,
  value,
  ids,
  typed,
  acknowledgedWriteId,
  subscribeToDiscardedWrites,
  carried,
  emit,
  close,
  onCreateOption,
  onColor,
}: OptionPickerProps & {
  value: CollectionValue;
  ids: string[];
  acknowledgedWriteId: number;
  subscribeToDiscardedWrites?: (listener: (writeId: number) => void) => () => void;
  carried?: CarriedSelection;
  emit: (value: CollectionValue, previousValues?: readonly CollectionValue[]) => number;
  /** Returns the save's edit id when the host has one, so a second edit starts from this one. */
  onCreateOption?: (option: string, nextValue: CollectionValue, previousValues?: readonly CollectionValue[]) => number | void;
}) {
  const { selected, select } = useAcknowledgedSelection({ value, ids, acknowledgedWriteId, subscribeToDiscardedWrites, emit, carried });
  const [query, setQuery] = useState(typed ?? "");
  const [draft, setDraft] = useState(NO_PICKS);
  // Chips keep the order they were picked in: the saved ones, then the new.
  const kept = selected.filter((option) => !draft.removed.includes(option));
  const picks = [...kept, ...draft.added.filter((option) => !kept.includes(option))];
  // One edit can add one option: the host adds it, then writes the value.
  const created = draft.created !== null && picks.includes(draft.created) && !field.options.includes(draft.created)
    ? draft.created
    : null;
  const options = created === null ? field.options : [...field.options, created];
  const name = query.trim();
  const toggle = (option: string) => {
    setQuery("");
    setDraft(picks.includes(option)
      ? {
          ...draft,
          added: draft.added.filter((entry) => entry !== option),
          removed: selected.includes(option) && !draft.removed.includes(option) ? [...draft.removed, option] : draft.removed,
        }
      : { ...draft, added: [...draft.added, option] });
  };
  const save = () => {
    if (sameSelection(picks, selected)) return;
    select(
      picks,
      created === null || !onCreateOption ? undefined : (next, previousValues) => onCreateOption(created, next, previousValues),
    );
    setDraft(NO_PICKS);
  };
  const rows = options
    .filter((option) => matches(option, name.toLowerCase()))
    // An option that is not saved yet has no color to change.
    .map((option) => optionRow(field, option, picks.includes(option), () => toggle(option), option === created ? undefined : onColor));
  const creates = onCreateOption !== undefined && name !== "" && !options.includes(name);
  if (creates && created === null) {
    rows.push({
      key: "create",
      content: createContent(field, name),
      pick: () => {
        setQuery("");
        setDraft({ ...draft, added: [...draft.added, name], created: name });
      },
    });
  }
  return (
    <PickerFrame save={save} close={close}>
      <SearchList
        multi
        searchLabel="Search options"
        listLabel={`${label} options`}
        query={query}
        onQuery={setQuery}
        rows={rows}
        chips={picks.map((option) => (
          <OptionPill key={option} label={option} color={optionColor(field, option)} onRemove={() => toggle(option)} />
        ))}
        onBackspaceEmpty={() => {
          const last = picks.at(-1);
          if (last !== undefined) toggle(last);
        }}
        empty={noOptions(name, onCreateOption !== undefined)}
        footer={creates && created !== null ? (
          <div role="option" aria-selected={false} aria-disabled="true" className="flex flex-col gap-1 px-2 py-1">
            <span className="flex items-center gap-2 text-[13px] text-subtle">{createContent(field, name)}</span>
            <span className="text-[12px] text-muted">Click away to save "{created}" first.</span>
          </div>
        ) : null}
      />
    </PickerFrame>
  );
}

/**
 * One person for a person field, from the people the host lists. An id the
 * list does not have still shows as the current value.
 */
export function PeoplePicker({ people, label, current, typed, emit, close }: {
  people: readonly TablePerson[];
  label: string;
  current: string | null;
  typed?: string;
  emit: (value: CollectionValue) => number;
  close: CellClose;
}) {
  const [query, setQuery] = useState(typed ?? "");
  const name = query.trim();
  const pick = (next: string | null) => {
    if (next !== current) emit(next);
    close();
  };
  const listed = current === null || people.some((person) => person.id === current)
    ? people
    : [{ id: current, name: current }, ...people];
  const rows: PickRow[] = listed
    .filter((person) => matches(person.name, name.toLowerCase()))
    .map((person) => ({
      key: `person:${person.id}`,
      content: <PersonChip id={person.id} label={person.name} />,
      checked: person.id === current,
      pick: () => pick(person.id),
    }));
  if (current !== null && name === "") {
    rows.push({ key: "clear", content: <><X {...ROW_ICON} />No one</>, pick: () => pick(null) });
  }
  return (
    <PickerFrame close={close}>
      <SearchList
        searchLabel="Search people"
        listLabel={`People for ${label}`}
        query={query}
        onQuery={setQuery}
        rows={rows}
        startAt={typed !== undefined ? 0 : Math.max(0, listed.findIndex((person) => person.id === current))}
        empty={name === "" ? "No people to choose from yet." : `No people match "${name}".`}
      />
    </PickerFrame>
  );
}

const DATE_VALUE_FORMAT = "yyyy-MM-dd";
const DAY_ROW = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink";
const MONTH_BUTTON = "grid size-6 place-items-center rounded-md text-muted transition-colors duration-75 hover:bg-hover hover:text-ink";

/**
 * A month of days for a date field. A pick saves and closes. Focus stays on
 * the month: the arrow keys move a day or a week, Page Up and Page Down
 * change the month, and Enter picks the highlighted day.
 */
export function DatePicker({ label, current, emit, close }: {
  label: string;
  /** The stored value. Anything that is not a date opens on today. */
  current: string | null;
  emit: (value: CollectionValue) => number;
  close: CellClose;
}) {
  const [today] = useState(() => new Date());
  const parsed = current === null ? null : parse(current, DATE_VALUE_FORMAT, today);
  const stored = parsed !== null && isValid(parsed) ? parsed : null;
  const [cursor, setCursor] = useState(stored ?? today);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => grid.current?.focus({ preventScroll: true }), []);
  const gridId = useId();
  const dayId = (day: Date) => `${gridId}-${format(day, DATE_VALUE_FORMAT)}`;
  const pick = (next: string | null) => {
    if (next !== current) emit(next);
    close();
  };
  // The week starts where the calendar view's does.
  const days = eachDayOfInterval({ start: startOfWeek(startOfMonth(cursor)), end: endOfWeek(endOfMonth(cursor)) });
  const weeks = Array.from({ length: days.length / 7 }, (_, week) => days.slice(week * 7, week * 7 + 7));
  return (
    <PickerFrame close={close}>
      <div className="flex items-center gap-1 px-2 pt-1">
        <span className="text-[13px] font-semibold text-ink">{format(cursor, "MMMM yyyy")}</span>
        <span className="flex-1" />
        <button type="button" tabIndex={-1} aria-label="Previous month" title="Previous month" className={MONTH_BUTTON} onClick={() => setCursor(addMonths(cursor, -1))}>
          <ChevronLeft {...ROW_ICON} />
        </button>
        <button type="button" tabIndex={-1} aria-label="Next month" title="Next month" className={MONTH_BUTTON} onClick={() => setCursor(addMonths(cursor, 1))}>
          <ChevronRight {...ROW_ICON} />
        </button>
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={label}
        aria-activedescendant={dayId(cursor)}
        tabIndex={0}
        // The highlighted day's fill shows where the keys act.
        className="flex flex-col px-1 outline-none"
        onKeyDown={(event) => {
          const { key } = event;
          const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : key === "ArrowUp" ? -7 : key === "ArrowDown" ? 7 : 0;
          const months = key === "PageUp" ? -1 : key === "PageDown" ? 1 : 0;
          if (step !== 0) setCursor(addDays(cursor, step));
          else if (months !== 0) setCursor(addMonths(cursor, months));
          else if (key === "Enter") pick(format(cursor, DATE_VALUE_FORMAT));
          else return;
          event.preventDefault();
        }}
      >
        <div role="row" className="grid grid-cols-7">
          {weeks[0]?.map((day) => (
            <span key={day.getDay()} role="columnheader" aria-label={format(day, "EEEE")} className="grid h-6 place-items-center text-[11px] text-subtle">
              {format(day, "EEEEE")}
            </span>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={dayId(week[0]!)} role="row" className="grid grid-cols-7">
            {week.map((day) => {
              const isStored = stored !== null && isSameDay(day, stored);
              return (
                <button
                  key={day.getDay()}
                  type="button"
                  role="gridcell"
                  id={dayId(day)}
                  tabIndex={-1}
                  aria-label={format(day, "MMMM d, yyyy")}
                  aria-selected={isStored}
                  aria-current={isSameDay(day, today) ? "date" : undefined}
                  data-active={isSameDay(day, cursor) ? "" : undefined}
                  onClick={() => pick(format(day, DATE_VALUE_FORMAT))}
                  className={`grid h-7 place-items-center rounded-md text-[12px] tabular-nums transition-colors duration-75 aria-[current=date]:ring-1 aria-[current=date]:ring-inset aria-[current=date]:ring-subtle ${
                    isStored
                      ? "bg-accent font-semibold text-bg"
                      : `hover:bg-hover data-active:bg-selected ${isSameMonth(day, cursor) ? "text-ink" : "text-subtle"}`
                  }`}
                >
                  {day.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-col">
        <button type="button" tabIndex={-1} className={DAY_ROW} onClick={() => pick(format(today, DATE_VALUE_FORMAT))}>
          Today
        </button>
        {current !== null ? (
          <button type="button" tabIndex={-1} className={DAY_ROW} onClick={() => pick(null)}>
            Clear
          </button>
        ) : null}
      </div>
    </PickerFrame>
  );
}
