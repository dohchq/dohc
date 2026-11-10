import { describe, expect, it } from "vitest";
import { isPastDate, optionColor, shortDate } from "./values";

describe("shortDate", () => {
  const today = new Date(2026, 10, 10);
  it("drops the year inside this year and keeps it outside", () => {
    expect(shortDate("2026-11-08", today)).toBe("Nov 8");
    expect(shortDate("2025-01-31", today)).toBe("Jan 31, 2025");
  });
  it("shows anything else as stored", () => {
    expect(shortDate("2026-13-01", today)).toBe("2026-13-01");
    expect(shortDate("soon", today)).toBe("soon");
  });
});

describe("isPastDate", () => {
  const today = new Date(2026, 10, 10, 23, 30);
  it("compares calendar days in local time", () => {
    expect(isPastDate("2026-11-09", today)).toBe(true);
    expect(isPastDate("2026-11-10", today)).toBe(false);
    expect(isPastDate("not a date", today)).toBe(false);
  });
});

describe("optionColor", () => {
  it("uses the chosen color, and an own key only", () => {
    const field = { name: "s", type: "select" as const, options: ["a", "constructor"], colors: { a: "rose" as const } };
    expect(optionColor(field, "a")).toBe("rose");
    expect(optionColor(field, "constructor")).not.toBe(undefined);
    expect(typeof optionColor(field, "constructor")).toBe("string");
  });
});
