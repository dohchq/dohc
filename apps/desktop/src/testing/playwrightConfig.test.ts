import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

// Playwright's default writes a missing baseline into the checkout. A changed
// checkout no longer matches the prepared desktop, so every later desktop test
// in the same run failed for that one missing screenshot.
describe("the desktop Playwright config", () => {
  it("writes no baseline unless a run asks for it with --update-snapshots", () => {
    expect(config.updateSnapshots).toBe("none");
  });
});
