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
  it("names up to three paths, then counts the rest", () => {
    expect(namedPaths(["a.md"])).toBe("a.md");
    expect(namedPaths(["a.md", "b.md"])).toBe("a.md and b.md");
    expect(namedPaths(["a.md", "b.md", "c.md"])).toBe("a.md, b.md, and c.md");
    expect(namedPaths(["a.md", "b.md", "c.md", "d.md", "e.md"])).toBe("a.md, b.md, c.md, and 2 more");
  });
});
