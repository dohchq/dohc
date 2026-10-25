import { useCallback, useMemo, useState } from "react";
import type { ComponentType } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import type { CalendarProps } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import type { EventInteractionArgs } from "react-big-calendar/lib/addons/dragAndDrop";
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
import { fieldDisplayText } from "../table/cells";
import type { CollectionCellChange } from "../table/TableView";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "react-big-calendar/lib/addons/dragAndDrop/styles.css";
import "./calendar.css";

/** The engine's date field value format (workspace-contracts validation). */
const DATE_VALUE_FORMAT = "yyyy-MM-dd";

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
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /** The date whose month opens first. Defaults to today. */
  defaultDate?: Date;
  /** A querying host controls the visible month and loads its full date range. */
  date?: Date;
  onNavigate?: (date: Date) => void;
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
}

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek,
  getDay,
  locales: { "en-US": enUS },
});

const textButtonClass =
  "rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-hover hover:text-ink";
const iconButtonClass =
  "grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink";

function Chevron({ next }: { next: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={next ? "m9 18 6-6-6-6" : "m15 18-6-6 6-6"} />
    </svg>
  );
}

/** The day a record's date value names, or null when it names none. */
function day(value: string): Date | null {
  const parsed = parse(value, DATE_VALUE_FORMAT, new Date());
  return isValid(parsed) ? parsed : null;
}

/** The record day closest to the month grid around `month`, the later one on a tie, or null when the grid shows one. */
function nearestDay(month: Date, days: readonly Date[]): Date | null {
  const first = startOfWeek(startOfMonth(month)), last = endOfWeek(endOfMonth(month));
  let nearest: Date | null = null, distance = Infinity;
  for (const candidate of days) {
    if (candidate >= first && candidate <= last) return null;
    const away = candidate < first ? differenceInCalendarDays(first, candidate) : differenceInCalendarDays(candidate, last);
    if (away < distance || (away === distance && nearest !== null && candidate > nearest)) { nearest = candidate; distance = away; }
  }
  return nearest;
}

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
  personLabel,
  defaultDate,
  date,
  onNavigate,
  nearbyDates,
}: CalendarViewProps) {
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

  const events = useMemo(() => {
    const result: CalendarRecordEvent[] = [];
    for (const record of records) {
      const indexed = record.values.find((entry) => entry.field === dateField);
      if (!indexed || indexed.validation.status !== "valid") continue;
      if (typeof indexed.value !== "string") continue;
      const start = day(indexed.value);
      if (!start) continue;
      const title = titleField
        ? fieldDisplayText(
            titleField,
            record.values.find((entry) => entry.field === titleField.name),
            personLabel,
          )
        : record.id;
      result.push({ record, title, start, end: start });
    }
    return result;
  }, [records, dateField, titleField, personLabel]);

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
    () => nearestDay(shown, [...events.map((event) => event.start), ...(nearbyDates ?? []).flatMap((value) => day(value) ?? [])]),
    [shown, events, nearbyDates],
  );

  if (records.length === 0 && !onNavigate) {
    return <div className="px-3 py-4 text-sm text-muted">No records in this collection yet.</div>;
  }

  return (
    <div className="dohc-collection-calendar flex h-full flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <button type="button" className={textButtonClass} onClick={() => navigate(new Date())}>
          Today
        </button>
        <button type="button" aria-label="Previous month" title="Previous month" className={iconButtonClass} onClick={() => navigate(addMonths(shown, -1))}>
          <Chevron next={false} />
        </button>
        <button type="button" aria-label="Next month" title="Next month" className={iconButtonClass} onClick={() => navigate(addMonths(shown, 1))}>
          <Chevron next />
        </button>
        <span className="text-sm font-medium text-ink">{format(shown, "MMMM yyyy")}</span>
        {nearest ? (
          <button type="button" className={textButtonClass} onClick={() => navigate(nearest)}>
            {`Go to ${format(nearest, "MMMM yyyy")}`}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        <DnDCalendar
          localizer={localizer}
          events={events}
          date={shown}
          onNavigate={navigate}
          toolbar={false}
          defaultView="month"
          views={["month"]}
          resizable={false}
          draggableAccessor={() => !!onCellChange}
          onEventDrop={handleEventDrop}
          onSelectEvent={
            onOpenRecord ? (event) => onOpenRecord(event.record) : undefined
          }
        />
      </div>
    </div>
  );
}
