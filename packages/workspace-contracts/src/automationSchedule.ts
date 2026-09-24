import type { AutomationScheduleTrigger, AutomationWeekday } from "./automations";

// When a schedule is due. The scheduler, the relay, and the ⚡ panel share
// this module, so it imports only types: the renderer can load it without
// acorn or js-yaml.
//
// A schedule names wall-clock times in its time zone, and a clock change can
// skip a wall-clock time or repeat it. A daily, weekday, weekly, or monthly
// time follows Temporal's "compatible" rule:
//
// - A time that clocks skip runs one gap later. When New York springs
//   forward, 02:30 runs at 03:30.
// - A time that occurs twice runs at the first occurrence.
// - Two times that land on one instant run once. Samoa skipped
//   30 December 2011, so that day's run is the run on the 31st.
//
// An hourly schedule follows elapsed hours. It runs in every local hour at
// its minute, so a repeated hour runs twice. A skipped time runs one gap
// later, and when that is also the next hour's run, it runs once. So when
// New York springs forward, no run is lost and none is added.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// UTC offsets stay within 16 hours of zero, including historical local mean
// times, and no clock change skips more than a day: Samoa skipped
// 30 December 2011. So a wall-clock time runs within these bounds of the
// same digits read as UTC.
const MAX_OFFSET_MS = 16 * HOUR_MS;
const LATEST_RUN_MS = MAX_OFFSET_MS + DAY_MS;
// The longest wait between two runs: a monthly schedule on the 1st waits 31
// days, and a clock change can add one more.
const LONGEST_WAIT_MS = 33 * DAY_MS;
// A zone's clock changes are more than two days apart. Both the offset cache
// and the search for a wall-clock time's instants rely on it.
const CLOCK_CHANGE_SPACING_MS = 2 * DAY_MS;

const WEEKDAYS: readonly AutomationWeekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type OffsetAt = (instant: number) => number;

const offsetClocks = new Map<string, OffsetAt>();

// The zone's UTC offset at an instant. Intl throws a RangeError for a zone
// this computer's ICU does not know. Formatting costs microseconds, so the
// clock remembers one span of instants that share an offset.
function zoneOffset(timeZone: string): OffsetAt {
  const cached = offsetClocks.get(timeZone);
  if (cached !== undefined) return cached;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const read = (instant: number): number => {
    const fields = new Map<string, number>();
    for (const part of format.formatToParts(instant)) fields.set(part.type, Number(part.value));
    const field = (type: string) => fields.get(type) ?? 0;
    const second = Math.floor(instant / 1_000) * 1_000;
    const local = Date.UTC(
      field("year"),
      field("month") - 1,
      field("day"),
      field("hour"),
      field("minute"),
      field("second"),
    );
    return local - second;
  };
  let span: { from: number; to: number; offset: number } | null = null;
  const offsetAt: OffsetAt = (instant) => {
    if (span !== null && instant >= span.from && instant <= span.to) return span.offset;
    const offset = read(instant);
    span =
      span !== null &&
      span.offset === offset &&
      instant >= span.from - CLOCK_CHANGE_SPACING_MS &&
      instant <= span.to + CLOCK_CHANGE_SPACING_MS
        ? { from: Math.min(span.from, instant), to: Math.max(span.to, instant), offset }
        : { from: instant, to: instant, offset };
    return offset;
  };
  offsetClocks.set(timeZone, offsetAt);
  return offsetAt;
}

// The instants a wall-clock time names, earliest first. `local` is the
// time's digits read as UTC. At most one clock change falls within a day of
// it, so the offsets a day either side are the only ones it can have. A
// skipped time names the instant one gap later.
function instantsAt(offsetAt: OffsetAt, local: number): number[] {
  const before = offsetAt(local - DAY_MS);
  const after = offsetAt(local + DAY_MS);
  const found = [...new Set([local - before, local - after])]
    .filter((instant) => offsetAt(instant) === local - instant)
    .sort((left, right) => left - right);
  return found.length > 0 ? found : [local - before];
}

function runsOn(trigger: AutomationScheduleTrigger, date: Date): boolean {
  switch (trigger.every) {
    case "hour":
    case "day":
      return true;
    case "weekday":
      return date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
    case "week":
      return trigger.days.includes(WEEKDAYS[date.getUTCDay()]!);
    case "month": {
      const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
      return trigger.days.some((day) => Math.min(day, lastDay) === date.getUTCDate());
    }
  }
}

// The wall-clock times a schedule names on one local date, as digits read
// as UTC. `day` counts days from 1970-01-01.
function wallTimes(trigger: AutomationScheduleTrigger, day: number): number[] {
  const start = day * DAY_MS;
  if (!runsOn(trigger, new Date(start))) return [];
  if (trigger.every === "hour") {
    const minute = Number(trigger.at.slice(1));
    return Array.from({ length: 24 }, (_, hour) => start + hour * HOUR_MS + minute * MINUTE_MS);
  }
  const [hour = 0, minute = 0] = trigger.at.split(":").map(Number);
  return [start + hour * HOUR_MS + minute * MINUTE_MS];
}

/**
 * The instants a schedule is due after `afterMs` and at or before `untilMs`,
 * earliest first, at most `limit` of them. Throws a RangeError when this
 * computer does not know the schedule's time zone.
 */
export function dueTimes(
  trigger: AutomationScheduleTrigger,
  afterMs: number,
  untilMs: number,
  limit: number,
): number[] {
  if (!Number.isFinite(afterMs) || !Number.isFinite(untilMs)) {
    throw new RangeError("A schedule's search bounds must be finite.");
  }
  const offsetAt = zoneOffset(trigger.timezone);
  const everyOccurrence = trigger.every === "hour";
  const due: number[] = [];
  let pending: number[] = [];
  for (let day = Math.floor((afterMs - LATEST_RUN_MS) / DAY_MS); due.length < limit; day += 1) {
    // Every time on this date or a later one runs at or after `earliest`,
    // so pending instants before it are final.
    const earliest = day * DAY_MS - MAX_OFFSET_MS;
    pending.sort((left, right) => left - right);
    const final = pending.filter((instant) => instant < earliest);
    pending = pending.filter((instant) => instant >= earliest);
    for (const instant of final) {
      if (due.length < limit && instant !== due.at(-1)) due.push(instant);
    }
    if (earliest > untilMs) break;
    for (const local of wallTimes(trigger, day)) {
      if (local + LATEST_RUN_MS <= afterMs || local - MAX_OFFSET_MS > untilMs) continue;
      const instants = instantsAt(offsetAt, local);
      for (const instant of everyOccurrence ? instants : instants.slice(0, 1)) {
        if (instant > afterMs && instant <= untilMs) pending.push(instant);
      }
    }
  }
  return due;
}

/**
 * The first instant a schedule is due after `afterMs`, or null for a
 * schedule with no days. Throws a RangeError when this computer does not
 * know the schedule's time zone.
 */
export function nextDue(trigger: AutomationScheduleTrigger, afterMs: number): number | null {
  return dueTimes(trigger, afterMs, afterMs + LONGEST_WAIT_MS, 1)[0] ?? null;
}
