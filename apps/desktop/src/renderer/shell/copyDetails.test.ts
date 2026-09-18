import { describe, expect, it } from "vitest";
import { ERROR_DETAIL_MAX_CHARS, errorDetails } from "./copyDetails";

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
