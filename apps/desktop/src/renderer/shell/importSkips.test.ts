import { describe, expect, it } from "vitest";
import { importSkipLines, skipSentence } from "./importSkips";

describe("skipSentence", () => {
  it("writes a shared view's size limits as round numbers", () => {
    expect(skipSentence("too-large", "movie.mp4"))
      .toBe("movie.mp4 is over the 5 MB limit for files in a shared view. Make it smaller, then import it.");
    expect(skipSentence("too-large-text", "notes.md"))
      .toBe("notes.md is over the 10 MB limit for text in a shared view. Make it smaller, then import it.");
  });
});

describe("importSkipLines", () => {
  it("shows the end of a long path, and copies it whole", () => {
    const path = `${"deep/".repeat(40)}key.txt`;
    const { lines, details } = importSkipLines(1, [{ path, reason: "link" }]);
    expect(lines).toEqual([`…${path.slice(-79)} is a link. Drop the file it leads to.`]);
    expect(details).toEqual([["Skipped", `${path} is a link. Drop the file it leads to.`, expect.any(Number)]]);
  });
});
