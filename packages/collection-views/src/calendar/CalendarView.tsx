import { useCallback, useMemo } from "react";
import type { ComponentType } from "react";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
import type { CalendarProps } from "react-big-calendar";
import withDragAndDrop from "react-big-calendar/lib/addons/dragAndDrop";
import type { EventInteractionArgs } from "react-big-calendar/lib/addons/dragAndDrop";
import { format, getDay, isValid, parse, startOfWeek } from "date-fns";
import { enUS } from "date-fns/locale";
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
  /** Maps a person field's user id to a display name. Falls back to the id. */
  personLabel?: (userId: string) => string | null;
  /** The date whose month opens first. Defaults to today. */
  defaultDate?: Date;
  className?: string;
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

const DnDCalendar = withDragAndDrop<CalendarRecordEvent, object>(
  Calendar as ComponentType<CalendarProps<CalendarRecordEvent, object>>,
);

export function CalendarView({
  schema,
  records,
  dateField,
  visibleFields,
  onCellChange,
  personLabel,
  defaultDate,
  className,
}: CalendarViewProps) {
  const fields = useMemo(() => deriveColumns(schema, visibleFields), [schema, visibleFields]);
  const titleField = fields[0] ?? null;

  const events = useMemo(() => {
    const result: CalendarRecordEvent[] = [];
    for (const record of records) {
      const indexed = record.values.find((entry) => entry.field === dateField);
      if (!indexed || indexed.validation.status !== "valid") continue;
      if (typeof indexed.value !== "string") continue;
      const start = parse(indexed.value, DATE_VALUE_FORMAT, new Date());
      if (!isValid(start)) continue;
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

  if (records.length === 0) {
    return <div className="px-3 py-4 text-sm text-muted">No records in this collection yet.</div>;
  }

  return (
    <div className={`dohc-collection-calendar h-full ${className ?? ""}`}>
      <DnDCalendar
        localizer={localizer}
        events={events}
        defaultDate={defaultDate}
        defaultView="month"
        views={["month"]}
        resizable={false}
        onEventDrop={handleEventDrop}
      />
    </div>
  );
}
