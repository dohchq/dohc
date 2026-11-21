import { describe, expect, it } from "vitest";
import { ERROR_DETAIL_MAX_CHARS, errorDetails, shellNoticeFields } from "./copyDetails";

describe("shellNoticeFields", () => {
  it("names the message and title, then paths and details", () => {
    expect(
      errorDetails(
        shellNoticeFields({
          message: "dohc could not save notes/plan.md.",
          title: "Save failed",
          paths: ["notes/plan.md"],
          details: [["Cause", "EACCES"]],
        }),
      ),
    ).toBe(
      "Error: dohc could not save notes/plan.md.\nTitle: Save failed\nPath: notes/plan.md\nCause: EACCES",
    );
  });

  it("leads a notice with change rows with its facts, and leaves out the words its row shows", () => {
    expect(
      errorDetails(
        shellNoticeFields({
          tone: "warning",
          title: "Access to team was widened outside dohc",
          message: "Until you choose, dohc doesn't record or share changes in team.",
          rows: ["Members: View → Edit"],
          details: [
            ["Recorded rule", "members: view"],
            ["Until you choose", "Members keep their earlier access."],
          ],
        }),
      ),
    ).toBe(
      "Recorded rule: members: view\nUntil you choose: Members keep their earlier access.\nChange: Members: View → Edit",
    );
  });
});

describe("errorDetails", () => {
  it("writes one line per fact and leaves out facts without a value", () => {
    expect(
      errorDetails([
        ["Code", "migration-failed"],
        ["Engine", null],
        ["dohc", undefined],
        ["Platform", "win32"],
      ]),
    ).toBe("Code: migration-failed\nPlatform: win32");
  });

  it("keeps a multi-line message on one line and bounds its length", () => {
    const stack = "Boom\n    at first (file.ts:1:1)\n    at second (file.ts:2:2)";
    expect(errorDetails([["Error", stack]])).toBe(
      "Error: Boom at first (file.ts:1:1) at second (file.ts:2:2)",
    );
    const long = "x".repeat(ERROR_DETAIL_MAX_CHARS * 2);
    const line = errorDetails([["Error", long]]);
    expect(line.length).toBe("Error: ".length + ERROR_DETAIL_MAX_CHARS);
    expect(line.endsWith("…")).toBe(true);
  });
});
