import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import type { CalendarProps, DateHeaderProps, EventProps } from "react-big-calendar";
import dragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import type { EventInteractionArgs } from "react-big-calendar/lib/addons/dragAndDrop";
import { addDays } from "date-fns/addDays";
import { addMonths } from "date-fns/addMonths";
import { differenceInCalendarDays } from "date-fns/differenceInCalendarDays";
import { endOfMonth } from "date-fns/endOfMonth";
import { endOfWeek } from "date-fns/endOfWeek";
import { format } from "date-fns/format";
import { getDay } from "date-fns/getDay";
import { isValid } from "date-fns/isValid";
import { parse } from "date-fns/parse";
import { startOfMonth } from "date-fns/startOfMonth";
import { startOfWeek } from "date-fns/startOfWeek";
import { enUS } from "date-fns/locale/en-US";
import type { CollectionRecord, CollectionSchema } from "@dohc/workspace-contracts";
import { deriveColumns } from "../columns";
import { recordLabel } from "../recordLabel";
import { fieldDisplayText } from "../table/cells";
import type { CollectionCellChange } from "../table/TableView";
import { optionColor, optionTone } from "../values";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "./calendar.css";

/** The engine's date field value format (workspace-contracts validation). */
const DATE_VALUE_FORMAT = "yyyy-MM-dd";

export type CalendarViewMode = "month" | "week";

export interface CalendarViewProps {
  schema: CollectionSchema;
  records: CollectionRecord[];
  /**
   * The date field the calendar is keyed to. Records with a valid value
   * render as events on that day; records with an invalid or missing value
   * do not render. Dropping an event on another day writes this field.
   */
  dateField: string;
  /** A view definition's visible field names; the first titles each event. */
  visibleFields?: readonly string[] | null;
  /**
   * Receives the date write when an event lands on another day. The host
   * applies it through its own write path; the package never writes.
   */
  onCellChange?: (change: CollectionCellChange) => void;
  /** Receives the event's record when the event is clicked, not dragged. */
  onOpenRecord?: (record: CollectionRecord) => void;
  /** The record the host shows open, as in a panel beside the calendar. Its entry is marked. */
  openRecordId?: string | null;
  /**
   * Adds a record on a day: its date field holds the day, in the engine's
   * date format. Each day then offers New record, on hover and on keyboard
   * focus. Absent, where no record can be created, no day offers it.
   */
  onNewRecord?: (date: string) => void;
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /** The date whose month opens first. Defaults to today. */
  defaultDate?: Date;
  /** A querying host controls the visible month and loads its full date range. */
  date?: Date;
  onNavigate?: (date: Date) => void;
  /** Optional host-controlled calendar layout mode so reloads preserve Week selection. */
  viewMode?: CalendarViewMode;
  onViewModeChange?: (mode: CalendarViewMode) => void;
  /**
   * For a host that reads only the visible month: the dates of the nearest
   * records before and after it. An empty month offers to go to the closer one.
   */
  nearbyDates?: readonly string[];
}

export interface CalendarRecordEvent {
  record: CollectionRecord;
  title: string;
  start: Date;
  end: Date;
  dotClass?: string;
}

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { "en-US": enUS },
});

const textButtonClass =
  "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors duration-75 hover:bg-hover hover:text-ink";
const iconButtonClass =
  "grid size-6 place-items-center rounded-md text-subtle transition-colors duration-75 hover:bg-hover hover:text-ink";

function CalendarEventPill({ event }: EventProps<CalendarRecordEvent>) {
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 py-0.5 text-[12px] text-ink transition-colors duration-75 hover:bg-hover">
      {event.dotClass ? (
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${event.dotClass}`} />
      ) : null}
      <span className="truncate">{event.title}</span>
    </span>
  );
}

/** The day a record's date value names, or null when it names none. */
function day(value: string): Date | null {
  const parsed = parse(value, DATE_VALUE_FORMAT, new Date());
  return isValid(parsed) ? parsed : null;
}

/** The record day closest to the month grid around `month`, the later one on a tie, or null when the grid shows one. */
function nearestDay(month: Date, days: readonly Date[]): Date | null {
  const first = startOfWeek(startOfMonth(month)),
    last = endOfWeek(endOfMonth(month));
  let nearest: Date | null = null,
    distance = Infinity;
  for (const candidate of days) {
    if (candidate >= first && candidate <= last) return null;
    const away =
      candidate < first
        ? differenceInCalendarDays(first, candidate)
        : differenceInCalendarDays(candidate, last);
    if (away < distance || (away === distance && nearest !== null && candidate > nearest)) {
      nearest = candidate;
      distance = away;
    }
  }
  return nearest;
}

// The add-on is CommonJS. Vite 7 hands over its default export; Vite 8, which
// builds the website's demo, follows Node and hands over the whole module.
const withDragAndDrop: typeof dragAndDrop =
  "default" in dragAndDrop ? (dragAndDrop as { default: typeof dragAndDrop }).default : dragAndDrop;

const DnDCalendar = withDragAndDrop<CalendarRecordEvent, object>(
  Calendar as ComponentType<CalendarProps<CalendarRecordEvent, object>>,
);

export function CalendarView({
  schema,
  records,
  dateField,
  visibleFields,
  onCellChange,
  onOpenRecord,
  openRecordId,
  onNewRecord,
  personLabel,
  defaultDate,
  date,
  onNavigate,
  viewMode,
  onViewModeChange,
  nearbyDates,
}: CalendarViewProps) {
  // The day's number, and before it the control that adds a record on that day. One component for the
  // calendar's life, so a host that builds its handler again draws no day again.
  const addRecord = useRef(onNewRecord);
  addRecord.current = onNewRecord;
  const offersNew = onNewRecord !== undefined;
  const components = useMemo(
    () => ({
      event: CalendarEventPill,
      month: {
        dateHeader: ({ date: day, label }: DateHeaderProps) =>
          offersNew ? (
            <span className="flex items-center justify-between gap-1">
              <button
                type="button"
                aria-label={`New record on ${format(day, "MMMM d, yyyy")}`}
                title="New record"
                className="dohc-calendar-new grid size-5 shrink-0 place-items-center rounded text-subtle transition-opacity duration-75 hover:bg-hover hover:text-ink"
                onClick={() => addRecord.current?.(format(day, DATE_VALUE_FORMAT))}
              >
                <Plus size={12} strokeWidth={1.9} aria-hidden />
              </button>
              <span className="dohc-calendar-day-num">{label}</span>
            </span>
          ) : (
            <span className="dohc-calendar-day-num">{label}</span>
          ),
      },
    }),
    [offersNew],
  );
  const [ownView, setOwnView] = useState<CalendarViewMode>("month");
  const view = viewMode ?? ownView;
  const setView = useCallback(
    (next: CalendarViewMode) => {
      if (viewMode === undefined) setOwnView(next);
      onViewModeChange?.(next);
    },
    [viewMode, onViewModeChange],
  );
  const [undatedOpen, setUndatedOpen] = useState(false);
  const undatedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!undatedOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!undatedRef.current?.contains(event.target as Node)) setUndatedOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setUndatedOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [undatedOpen]);
  const [ownDate, setOwnDate] = useState(() => defaultDate ?? new Date());
  const shown = date ?? ownDate;
  const navigate = useCallback(
    (next: Date) => {
      if (date === undefined) setOwnDate(next);
      onNavigate?.(next);
    },
    [date, onNavigate],
  );
  const fields = useMemo(() => deriveColumns(schema, visibleFields), [schema, visibleFields]);
  const titleField = fields[0] ?? null;
  const selectField = useMemo(
    () => schema.fields.find((field) => field.type === "select") ?? null,
    [schema],
  );

  const { events, undated } = useMemo(() => {
    const dated: CalendarRecordEvent[] = [];
    const missing: Array<{ record: CollectionRecord; title: string }> = [];
    for (const record of records) {
      const title = titleField
        ? fieldDisplayText(
            titleField,
            record.values.find((entry) => entry.field === titleField.name),
            personLabel,
          )
        : record.id;
      const indexed = record.values.find((entry) => entry.field === dateField);
      const start =
        indexed && indexed.validation.status === "valid" && typeof indexed.value === "string"
          ? day(indexed.value)
          : null;
      if (!start) {
        missing.push({ record, title: title || recordLabel(record) });
        continue;
      }
      let dotClass: string | undefined;
      if (selectField) {
        const selectIndexed = record.values.find((entry) => entry.field === selectField.name);
        if (
          selectIndexed &&
          selectIndexed.validation.status !== "flagged" &&
          typeof selectIndexed.value === "string" &&
          selectIndexed.value !== ""
        ) {
          dotClass = optionTone(optionColor(selectField, selectIndexed.value)).dot;
        }
      }
      dated.push({ record, title, start, end: start, dotClass });
    }
    return { events: dated, undated: missing };
  }, [records, dateField, titleField, selectField, personLabel]);

  const handleEventDrop = useCallback(
    (args: EventInteractionArgs<CalendarRecordEvent>) => {
      if (!onCellChange) return;
      const day = args.start instanceof Date ? args.start : new Date(args.start);
      if (!isValid(day)) return;
      const value = format(day, DATE_VALUE_FORMAT);
      const { record } = args.event;
      const current = record.values.find((entry) => entry.field === dateField)?.value;
      if (value === current) return;
      onCellChange({ recordId: record.id, recordPath: record.path, field: dateField, value });
    },
    [dateField, onCellChange],
  );

  const nearest = useMemo(
    () =>
      nearestDay(shown, [
        ...events.map((event) => event.start),
        ...(nearbyDates ?? []).flatMap((value) => day(value) ?? []),
      ]),
    [shown, events, nearbyDates],
  );

  if (records.length === 0 && !onNavigate && !onNewRecord) {
    return <div className="px-5 py-6 text-sm text-muted">No records in this Collection yet.</div>;
  }

  const stepPeriod = (delta: number) =>
    navigate(view === "week" ? addDays(shown, delta * 7) : addMonths(shown, delta));
  const prevLabel = view === "week" ? "Previous week" : "Previous month";
  const nextLabel = view === "week" ? "Next week" : "Next month";

  return (
    <div className="dohc-collection-calendar flex h-full flex-col gap-2 px-5 pb-4 pt-3">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" className={textButtonClass} onClick={() => navigate(new Date())}>
          Today
        </button>
        <button
          type="button"
          aria-label={prevLabel}
          title={prevLabel}
          className={iconButtonClass}
          onClick={() => stepPeriod(-1)}
        >
          <ChevronLeft size={16} strokeWidth={1.9} aria-hidden />
        </button>
        <button
          type="button"
          aria-label={nextLabel}
          title={nextLabel}
          className={iconButtonClass}
          onClick={() => stepPeriod(1)}
        >
          <ChevronRight size={16} strokeWidth={1.9} aria-hidden />
        </button>
        <span className="text-sm font-medium text-ink">{format(shown, "MMMM yyyy")}</span>
        {nearest ? (
          <button type="button" className={textButtonClass} onClick={() => navigate(nearest)}>
            {`Go to ${format(nearest, "MMMM yyyy")}`}
          </button>
        ) : null}
        <span className="flex-1" />
        {undated.length > 0 ? (
          <div ref={undatedRef} className="relative">
            <button
              type="button"
              aria-expanded={undatedOpen}
              aria-haspopup="dialog"
              className={textButtonClass}
              onClick={() => setUndatedOpen((open) => !open)}
            >
              {`No date · ${undated.length}`}
            </button>
            {undatedOpen ? (
              <div
                role="dialog"
                aria-label="Records without a date"
                className="dohc-popover dohc-pop-in absolute right-0 top-9 z-30 flex max-h-64 w-60 flex-col overflow-y-auto rounded-xl border border-line bg-panel p-1"
              >
                {undated.map(({ record, title }) => (
                  <button
                    key={record.id}
                    type="button"
                    disabled={!onOpenRecord}
                    onClick={() => {
                      setUndatedOpen(false);
                      onOpenRecord?.(record);
                    }}
                    className="flex h-8 w-full items-center rounded-md px-2 text-left text-[13px] text-ink transition-colors duration-75 enabled:hover:bg-hover disabled:text-muted"
                  >
                    <span className="truncate">{title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          role="radiogroup"
          aria-label="Calendar view"
          className="flex rounded-lg border border-line bg-panel-2 p-0.5"
        >
          {(["month", "week"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={view === mode}
              onClick={() => setView(mode)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors duration-75 ${
                view === mode ? "bg-bg text-ink shadow-sm" : "text-muted hover:text-ink"
              }`}
            >
              {mode === "month" ? "Month" : "Week"}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <DnDCalendar
          localizer={localizer}
          events={events}
          date={shown}
          view={view}
          onView={(next) => {
            if (next === "month" || next === "week") setView(next);
          }}
          onNavigate={navigate}
          toolbar={false}
          defaultView="month"
          views={["month", "week"]}
          resizable={false}
          components={components}
          draggableAccessor={() => !!onCellChange}
          onEventDrop={handleEventDrop}
          onSelectEvent={onOpenRecord ? (event) => onOpenRecord(event.record) : undefined}
          eventPropGetter={(event) =>
            event.record.id === openRecordId
              ? { className: "ring-2 ring-accent ring-offset-1 ring-offset-bg" }
              : {}
          }
        />
      </div>
    </div>
  );
}
