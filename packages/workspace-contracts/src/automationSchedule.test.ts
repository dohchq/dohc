/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UnknownTimeZoneError, dueTimes, nextDue } from "./automationSchedule";
import type { AutomationScheduleTrigger, AutomationWeekday } from "./automations";

const hourly = (at: string, timezone: string): AutomationScheduleTrigger => ({
  kind: "schedule",
  every: "hour",
  at,
  timezone,
});
const daily = (at: string, timezone: string): AutomationScheduleTrigger => ({
  kind: "schedule",
  every: "day",
  at,
  timezone,
});
const weekdays = (at: string, timezone: string): AutomationScheduleTrigger => ({
  kind: "schedule",
  every: "weekday",
  at,
  timezone,
});
const weekly = (days: AutomationWeekday[], at: string, timezone: string): AutomationScheduleTrigger => ({
  kind: "schedule",
  every: "week",
  at,
  days,
  timezone,
});
const monthly = (days: number[], at: string, timezone: string): AutomationScheduleTrigger => ({
  kind: "schedule",
  every: "month",
  at,
  days,
  timezone,
});

function due(trigger: AutomationScheduleTrigger, after: string, until: string, limit = 100): string[] {
  return dueTimes(trigger, Date.parse(after), Date.parse(until), limit).map((instant) =>
    new Date(instant).toISOString(),
  );
}

function next(trigger: AutomationScheduleTrigger, after: string): string | null {
  const instant = nextDue(trigger, Date.parse(after));
  return instant === null ? null : new Date(instant).toISOString();
}

describe("dueTimes in New York", () => {
  const zone = "America/New_York";

  it("runs a time that clocks skip one gap later", () => {
    expect(due(daily("02:30", zone), "2026-03-06T12:00:00Z", "2026-03-09T12:00:00Z")).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
    ]);
  });

  it("runs a repeated time at its first occurrence", () => {
    expect(due(daily("01:30", zone), "2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z")).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("runs an hourly schedule once per elapsed hour when clocks spring forward", () => {
    expect(due(hourly(":30", zone), "2026-03-08T05:00:00Z", "2026-03-08T09:00:00Z")).toEqual([
      "2026-03-08T05:30:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:30:00.000Z",
    ]);
  });

  it("runs an hourly schedule twice in the hour that clocks repeat", () => {
    expect(due(hourly(":30", zone), "2026-11-01T04:00:00Z", "2026-11-01T08:00:00Z")).toEqual([
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:30:00.000Z",
    ]);
  });
});

describe("dueTimes in London", () => {
  const zone = "Europe/London";

  it("moves a skipped Sunday time forward and runs a repeated one at the first", () => {
    const sunday = weekly(["sun"], "01:30", zone);
    expect(next(sunday, "2026-03-28T00:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
    expect(next(sunday, "2026-10-24T00:00:00Z")).toBe("2026-10-25T00:30:00.000Z");
  });

  it("runs a weekday schedule Monday to Friday", () => {
    expect(due(weekdays("09:00", zone), "2026-09-25T00:00:00Z", "2026-09-29T23:00:00Z")).toEqual([
      "2026-09-25T08:00:00.000Z",
      "2026-09-28T08:00:00.000Z",
      "2026-09-29T08:00:00.000Z",
    ]);
  });
});

describe("dueTimes on Lord Howe Island, where clocks change by 30 minutes", () => {
  const zone = "Australia/Lord_Howe";

  it("moves a skipped time forward by the 30-minute gap", () => {
    expect(next(daily("02:15", zone), "2026-10-03T12:00:00Z")).toBe("2026-10-03T15:45:00.000Z");
  });

  it("runs a repeated time at its first occurrence", () => {
    expect(next(daily("01:45", zone), "2026-04-04T12:00:00Z")).toBe("2026-04-04T14:45:00.000Z");
  });

  it("gives every local hour its run when clocks spring forward", () => {
    expect(due(hourly(":15", zone), "2026-10-03T14:00:00Z", "2026-10-03T17:00:00Z")).toEqual([
      "2026-10-03T14:45:00.000Z",
      "2026-10-03T15:45:00.000Z",
      "2026-10-03T16:15:00.000Z",
    ]);
  });

  it("runs the repeated half hour twice when clocks go back", () => {
    expect(due(hourly(":45", zone), "2026-04-04T13:00:00Z", "2026-04-04T16:30:00Z")).toEqual([
      "2026-04-04T13:45:00.000Z",
      "2026-04-04T14:45:00.000Z",
      "2026-04-04T15:15:00.000Z",
      "2026-04-04T16:15:00.000Z",
    ]);
  });
});

describe("dueTimes in Kolkata, 5 hours 30 minutes ahead of UTC", () => {
  it("accepts an alias in any letter case", () => {
    expect(next(daily("09:00", "asia/calcutta"), "2026-09-25T00:00:00Z")).toBe(
      "2026-09-25T03:30:00.000Z",
    );
  });

  it("runs an hourly schedule at the local minute", () => {
    expect(due(hourly(":00", "Asia/Kolkata"), "2026-09-25T00:00:00Z", "2026-09-25T02:00:00Z")).toEqual([
      "2026-09-25T00:30:00.000Z",
      "2026-09-25T01:30:00.000Z",
    ]);
  });
});

describe("dueTimes in Apia, which skipped 30 December 2011", () => {
  const zone = "Pacific/Apia";

  it("runs the skipped day's time once, with the next day's", () => {
    expect(due(daily("09:00", zone), "2011-12-28T12:00:00Z", "2012-01-01T00:00:00Z")).toEqual([
      "2011-12-28T19:00:00.000Z",
      "2011-12-29T19:00:00.000Z",
      "2011-12-30T19:00:00.000Z",
      "2011-12-31T19:00:00.000Z",
    ]);
  });

  it("runs the skipped Friday one gap later, on Saturday's clock", () => {
    expect(due(weekdays("09:00", zone), "2011-12-29T00:00:00Z", "2012-01-02T00:00:00Z")).toEqual([
      "2011-12-29T19:00:00.000Z",
      "2011-12-30T19:00:00.000Z",
      "2012-01-01T19:00:00.000Z",
    ]);
  });

  it("runs an hourly schedule once per elapsed hour across the skipped day", () => {
    expect(due(hourly(":00", zone), "2011-12-30T08:00:00Z", "2011-12-30T12:00:00Z")).toEqual([
      "2011-12-30T09:00:00.000Z",
      "2011-12-30T10:00:00.000Z",
      "2011-12-30T11:00:00.000Z",
      "2011-12-30T12:00:00.000Z",
    ]);
  });
});

describe("dueTimes in Troll, where clocks change by 2 hours", () => {
  const zone = "Antarctica/Troll";

  it("moves a skipped time forward by the 2-hour gap", () => {
    expect(next(daily("01:30", zone), "2026-03-28T12:00:00Z")).toBe("2026-03-29T01:30:00.000Z");
  });

  it("runs an hourly schedule once per elapsed hour across both clock changes", () => {
    expect(due(hourly(":00", zone), "2026-03-28T23:30:00Z", "2026-03-29T03:30:00Z")).toEqual([
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T02:00:00.000Z",
      "2026-03-29T03:00:00.000Z",
    ]);
    expect(due(hourly(":00", zone), "2026-10-24T21:30:00Z", "2026-10-25T03:30:00Z")).toEqual([
      "2026-10-24T22:00:00.000Z",
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
    ]);
  });
});

describe("dueTimes in Chatham, 12 hours 45 minutes ahead of UTC", () => {
  const zone = "Pacific/Chatham";

  it("moves a skipped time forward and runs a repeated one at the first", () => {
    expect(next(daily("03:00", zone), "2026-09-26T00:00:00Z")).toBe("2026-09-26T14:15:00.000Z");
    expect(next(daily("03:00", zone), "2026-04-04T00:00:00Z")).toBe("2026-04-04T13:15:00.000Z");
  });
});

describe("dueTimes in São Paulo, where clocks went back to the previous day", () => {
  it("runs the repeated late evening once, at the first occurrence", () => {
    expect(due(daily("23:30", "America/Sao_Paulo"), "2019-02-15T12:00:00Z", "2019-02-18T12:00:00Z")).toEqual([
      "2019-02-16T01:30:00.000Z",
      "2019-02-17T01:30:00.000Z",
      "2019-02-18T02:30:00.000Z",
    ]);
  });
});

describe("dueTimes in Casablanca, whose clocks go back for Ramadan", () => {
  const zone = "Africa/Casablanca";

  it("runs a repeated time at the first and a skipped one a gap later", () => {
    expect(next(daily("02:30", zone), "2026-02-14T12:00:00Z")).toBe("2026-02-15T01:30:00.000Z");
    expect(next(daily("02:30", zone), "2026-03-21T12:00:00Z")).toBe("2026-03-22T02:30:00.000Z");
  });
});

describe("monthly days past the end of a month", () => {
  it("runs the 29th on 28 February outside a leap year and on 29 February in one", () => {
    expect(due(monthly([29], "09:00", "UTC"), "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z")).toEqual([
      "2026-01-29T09:00:00.000Z",
      "2026-02-28T09:00:00.000Z",
      "2026-03-29T09:00:00.000Z",
    ]);
    expect(next(monthly([29], "09:00", "UTC"), "2028-02-01T00:00:00Z")).toBe("2028-02-29T09:00:00.000Z");
  });

  it("runs once when several days fall on a month's last day", () => {
    expect(
      due(monthly([29, 30, 31], "09:00", "UTC"), "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
    ).toEqual(["2026-02-28T09:00:00.000Z"]);
    expect(due(monthly([31], "09:00", "UTC"), "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z")).toEqual([
      "2026-04-30T09:00:00.000Z",
    ]);
  });

  it("follows the clock-change rules on a month day", () => {
    const newYork = "America/New_York";
    expect(next(monthly([8], "02:30", newYork), "2026-03-01T00:00:00Z")).toBe("2026-03-08T07:30:00.000Z");
    expect(next(monthly([1], "01:30", newYork), "2026-10-15T00:00:00Z")).toBe("2026-11-01T05:30:00.000Z");
  });
});

describe("dueTimes bounds", () => {
  it("excludes afterMs, includes untilMs, and stops at the limit", () => {
    const nine = daily("09:00", "UTC");
    expect(due(nine, "2026-09-25T09:00:00Z", "2026-09-26T09:00:00Z")).toEqual([
      "2026-09-26T09:00:00.000Z",
    ]);
    expect(due(hourly(":00", "UTC"), "2026-09-25T00:00:00Z", "2026-09-30T00:00:00Z", 3)).toEqual([
      "2026-09-25T01:00:00.000Z",
      "2026-09-25T02:00:00.000Z",
      "2026-09-25T03:00:00.000Z",
    ]);
    expect(due(nine, "2026-09-26T00:00:00Z", "2026-09-25T00:00:00Z")).toEqual([]);
  });

  it("stops at the limit inside a clock change's batch of runs", () => {
    expect(due(hourly(":30", "America/Sao_Paulo"), "2019-02-17T00:00:00Z", "2019-02-17T06:00:00Z", 3)).toEqual([
      "2019-02-17T00:30:00.000Z",
      "2019-02-17T01:30:00.000Z",
      "2019-02-17T02:30:00.000Z",
    ]);
  });

  it("refuses bounds outside the years 1970 to 9999", () => {
    const monday = weekly(["mon"], "09:00", "UTC");
    for (const [after, until] of [
      [1e300, 1.1e300],
      [-1, 0],
      [0, Date.UTC(10_000, 0, 1)],
      [0, Number.POSITIVE_INFINITY],
      [Number.NaN, 0],
    ]) {
      expect(() => dueTimes(monday, after!, until!, 1)).toThrow(RangeError);
    }
    expect(next(daily("09:00", "UTC"), "1970-01-01T00:00:00Z")).toBe("1970-01-01T09:00:00.000Z");
    expect(next(daily("09:00", "UTC"), "9999-12-31T10:00:00Z")).toBeNull();
  });

  it("reports an unknown zone apart from a malformed schedule", () => {
    expect(() => dueTimes(daily("09:00", "Mars/Olympus"), 0, 1, 1)).toThrow(UnknownTimeZoneError);
    const malformed = () => dueTimes(hourly("00:30", "UTC"), 0, 1, 1);
    expect(malformed).toThrow(RangeError);
    expect(malformed).not.toThrow(UnknownTimeZoneError);
  });
});

describe("nextDue", () => {
  it("finds the next run for every schedule shape", () => {
    const after = "2026-09-25T10:00:00Z"; // A Friday.
    expect(next(hourly(":15", "UTC"), after)).toBe("2026-09-25T10:15:00.000Z");
    expect(next(daily("09:00", "UTC"), after)).toBe("2026-09-26T09:00:00.000Z");
    expect(next(weekdays("09:00", "UTC"), after)).toBe("2026-09-28T09:00:00.000Z");
    expect(next(weekly(["wed", "sun"], "18:00", "UTC"), after)).toBe("2026-09-27T18:00:00.000Z");
    expect(next(monthly([1], "00:00", "UTC"), "2026-01-01T00:00:00Z")).toBe("2026-02-01T00:00:00.000Z");
  });

  it("returns nothing for a schedule with no days, without walking the window", () => {
    expect(next(weekly([], "09:00", "UTC"), "2026-09-25T00:00:00Z")).toBeNull();
    expect(dueTimes(monthly([], "09:00", "UTC"), 0, Date.UTC(10_000, 0, 1) - 1, 1)).toEqual([]);
  });
});

it("imports only types, so the renderer can load it without acorn or js-yaml", () => {
  const source = readFileSync(new URL("./automationSchedule.ts", import.meta.url), "utf8");
  expect(source.match(/^import (?!type )/gmu)).toBeNull();
});
