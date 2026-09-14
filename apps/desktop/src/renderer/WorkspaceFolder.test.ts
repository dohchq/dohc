import { describe, expect, it } from "vitest";
import { openedAgo } from "./WorkspaceFolder";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const MINUTE = 60_000;

describe("openedAgo", () => {
  it("says never for a workspace this desktop has not opened", () => {
    expect(openedAgo(undefined, NOW)).toBe("Never opened here");
  });

  it("steps from minutes to hours to days to a date", () => {
    expect(openedAgo(NOW - 20_000, NOW)).toBe("Opened just now");
    expect(openedAgo(NOW - MINUTE, NOW)).toBe("Opened 1 minute ago");
    expect(openedAgo(NOW - 5 * MINUTE, NOW)).toBe("Opened 5 minutes ago");
    expect(openedAgo(NOW - 3 * 60 * MINUTE, NOW)).toBe("Opened 3 hours ago");
    expect(openedAgo(NOW - 30 * 60 * MINUTE, NOW)).toBe("Opened yesterday");
    expect(openedAgo(NOW - 4 * 24 * 60 * MINUTE, NOW)).toBe("Opened 4 days ago");
    expect(openedAgo(NOW - 30 * 24 * 60 * MINUTE, NOW)).toMatch(/^Opened [A-Z][a-z]{2} \d+$/);
  });
});
