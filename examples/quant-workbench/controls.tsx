import { useEffect, useRef } from "react";
import { CalendarDays, ChevronDown, CircleHelp } from "dohc/icons";
import { Callout } from "dohc/ui";
import { usePopover } from "./hooks";
import { formatDay, formatShortDay } from "./report/format";
import type { Range } from "./types";

const SHORTCUT_ROWS: Array<[string, string]> = [
  ["1 2 3 4", "30D, 90D, 1Y, All"],
  ["D W M", "Day, week, month buckets"],
  ["Z", "Back to the preset range"],
  ["[ ]", "Move the lag one day"],
  ["N", "Research notes"],
  ["I", "Import CSV"],
  ["?", "This list"],
  ["← →", "Move through the chart"],
  ["⇧ ← →", "Move 10 buckets"],
  ["Home End", "First or last bucket"],
  ["Esc", "Close"],
];

function rangeText({ start, end }: Range) {
  if (!start || !end) return "Choose dates";
  const head = start.slice(0, 4) === end.slice(0, 4) ? formatShortDay(start) : formatDay(start);
  return `${head} to ${formatDay(end)}`;
}

export function RangePicker({
  range,
  custom,
  onChange,
}: {
  range: Range;
  custom: boolean;
  onChange: (range: Range) => void;
}) {
  const { open, setOpen, box, onKeyDown } = usePopover<HTMLDivElement>();
  return (
    <div
      className="range-picker"
      ref={box}
      data-custom={custom ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="sb-toggle range-button"
        aria-expanded={open}
        aria-label={`Date range: ${rangeText(range)}`}
        onClick={() => setOpen(!open)}
      >
        <CalendarDays size={13} aria-hidden="true" />
        <span className="num">{rangeText(range)}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <div className="range-pop" role="group" aria-label="Custom date range">
          <label>
            <span>Start</span>
            <input
              type="date"
              aria-label="Start date"
              value={range.start}
              max={range.end}
              onChange={(event) =>
                event.target.value && onChange({ ...range, start: event.target.value })
              }
            />
          </label>
          <label>
            <span>End</span>
            <input
              type="date"
              aria-label="End date"
              value={range.end}
              min={range.start}
              onChange={(event) =>
                event.target.value && onChange({ ...range, end: event.target.value })
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function Shortcuts({
  enabled,
  setEnabled,
  error,
  open,
  setOpen,
}: {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  error: Error | null | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const popover = usePopover<HTMLDivElement>([open, setOpen]);
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    const previous = active instanceof HTMLElement || active instanceof SVGElement ? active : null;
    toggle.current?.focus();
    return () => {
      const current = document.activeElement;
      if (current === document.body || popover.box.current?.contains(current)) previous?.focus();
    };
  }, [open, popover.box]);
  return (
    <div className="shortcuts" ref={popover.box} onKeyDown={popover.onKeyDown}>
      <button
        type="button"
        className="icon-only"
        aria-expanded={popover.open}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts (?)"
        aria-keyshortcuts="Shift+/"
        onClick={() => popover.setOpen(!popover.open)}
      >
        <CircleHelp size={15} aria-hidden="true" />
      </button>
      {popover.open && (
        <div className="shortcut-pop" role="group" aria-label="Keyboard shortcuts">
          <label className="shortcut-switch">
            <input
              ref={toggle}
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Single-key shortcuts
          </label>
          {error && (
            <Callout tone="danger" title="Could not save this setting">
              {error.message}
            </Callout>
          )}
          <dl data-off={enabled ? undefined : ""}>
            {SHORTCUT_ROWS.map(([key, action]) => (
              <div key={key}>
                <dt>
                  <kbd>{key}</kbd>
                </dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
