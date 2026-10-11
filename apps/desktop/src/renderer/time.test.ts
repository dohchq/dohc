import { describe, expect, it } from "vitest";
import { formatClock, formatClockDigits } from "./time";

describe("formatClockDigits", () => {
  it("drops AM and PM and stays five characters or fewer at every hour", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(2026, 6, 8, hour, 45).getTime();
      const digits = formatClockDigits(at);
      expect(digits).toMatch(/^\d{1,2}:45$/);
      expect(formatClock(at).startsWith(digits) || formatClock(at).endsWith(digits)).toBe(true);
    }
  });
});
