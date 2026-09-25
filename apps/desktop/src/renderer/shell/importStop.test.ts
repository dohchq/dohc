import { describe, expect, it } from "vitest";
import { importStopSentence, namedPaths } from "./importStop";

describe("importStopSentence", () => {
  it("says why an import stopped in plain words, never the error code", () => {
    expect(importStopSentence({ file: "two.md", code: "EACCES" })).toBe(
      "dohc isn't allowed to read two.md or write to this folder.",
    );
    expect(importStopSentence({ file: "two.md", code: "EPERM" })).toBe(
      "dohc isn't allowed to read two.md or write to this folder.",
    );
    expect(importStopSentence({ file: "two.md", code: "ENOSPC" })).toBe("The disk is full.");
    expect(importStopSentence({ file: "two.md", code: "ENOENT" })).toBe(
      "dohc could not find two.md or this folder anymore.",
    );
    expect(importStopSentence({ file: "two.md", code: "EIO", detail: "EIO: i/o error" })).toBe(
      "dohc could not copy two.md.",
    );
    expect(importStopSentence({ file: "two.md" })).toBe("dohc could not copy two.md.");
  });

  it("keeps a refusal dohc wrote itself as written", () => {
    const reason = "dohc did not import a symbolic link. The file it points to is missing.";
    expect(importStopSentence({ file: "link.md", reason })).toBe(reason);
  });
});

describe("namedPaths", () => {
  it("names at most two files by name, then counts the rest", () => {
    expect(namedPaths(["a.md"])).toBe("a.md");
    expect(namedPaths(["a.md", "b.md"])).toBe("a.md and b.md");
    expect(namedPaths(["notes/a.md", "b.md", "c.md"])).toBe("a.md and 2 more");
    expect(namedPaths(["notes/a.md", "notes/b.md"])).toBe("a.md and b.md");
    // One name, at most 60 characters, whatever the file name's length.
    expect(namedPaths([`${"x".repeat(200)}.md`])).toBe(`${"x".repeat(59)}…`);
  });
});
