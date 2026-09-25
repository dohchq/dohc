import { describe, expect, it } from "vitest";
import { errorDetails } from "./copyDetails";
import { fitImportMessage, importedPathDetails, importStopSentence, namedPaths } from "./importStop";
import { SHELL_ERROR_MAX_CHARS } from "./useShellError";

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

  it("words a dangling link with the steps in order, and shortens a long link name", () => {
    expect(importStopSentence({ file: "link.md", refusal: "dangling-link" })).toBe(
      "dohc did not import link.md, a symbolic link to a missing file. Restore that file, then import it instead.",
    );
    expect(importStopSentence({ file: `${"l".repeat(200)}.md`, refusal: "dangling-link" })).toBe(
      `dohc did not import ${"l".repeat(59)}…, a symbolic link to a missing file. Restore that file, then import it instead.`,
    );
  });
});

describe("fitImportMessage", () => {
  it("shortens the middle so the instruction at the end stays whole", () => {
    const tail = " Import only the files that are still missing.";
    expect(fitImportMessage("Imported a.md.", " short.", tail)).toBe(`Imported a.md. short.${tail}`);
    const fitted = fitImportMessage("Imported a.md.", ` ${"x".repeat(600)}`, tail);
    expect(fitted.length).toBe(SHELL_ERROR_MAX_CHARS);
    expect(fitted.endsWith(`…${tail}`)).toBe(true);
    expect(fitted.startsWith("Imported a.md. xxx")).toBe(true);
  });
});

describe("importedPathDetails", () => {
  it("keeps each landed path whole, up to 100 lines, then counts the rest", () => {
    const deep = `${"folder/".repeat(100)}report.md`;
    const details = importedPathDetails([deep]);
    expect(errorDetails(details)).toBe(`Imported: ${deep}`);

    const many = importedPathDetails(Array.from({ length: 103 }, (_, index) => `f${index}.md`));
    expect(many).toHaveLength(101);
    expect(errorDetails(many).split("\n").at(-1)).toBe("Imported: 3 more");
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
