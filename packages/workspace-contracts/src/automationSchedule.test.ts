/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dueTimes, nextDue } from "./automationSchedule";
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

  it("refuses a zone this computer does not know and a bound that is not finite", () => {
    expect(() => dueTimes(daily("09:00", "Mars/Olympus"), 0, 1, 1)).toThrow(RangeError);
    expect(() => dueTimes(daily("09:00", "UTC"), 0, Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
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

  it("returns null for a schedule with no days", () => {
    expect(next(weekly([], "09:00", "UTC"), "2026-09-25T00:00:00Z")).toBeNull();
  });
});

it("imports only types, so the renderer can load it without acorn or js-yaml", () => {
  const source = readFileSync(new URL("./automationSchedule.ts", import.meta.url), "utf8");
  expect(source.match(/^import (?!type )/gmu)).toBeNull();
});
