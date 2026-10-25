import { describe, expect, it } from "vitest";
import { workspaceDestinationError, workspaceNameError } from "./workspacePaths";

describe("Windows file and folder names", () => {
  it.each([
    ["?", "a question mark (?)"], ["*", "an asterisk (*)"], ['"', 'a double quote (")'],
    ["<", "a less-than sign (<)"], [">", "a greater-than sign (>)"],
    ["|", "a vertical bar (|)"], [":", "a colon (:)"],
    ["/", "a slash (/)"], ["\\", "a backslash (\\)"],
  ])("names the forbidden character %s", (character, label) => {
    expect(workspaceNameError(`a${character}b.md`, "win32"))
      .toBe(`A name cannot contain ${label}. Remove it.`);
  });

  it.each(["CON", "NUL", "PRN", "AUX", "CONIN$", "CONOUT$", "CLOCK$",
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`), "COM¹", "COM²", "LPT³"])("refuses device %s with or without an extension", name => {
    for (const spelling of [name, `${name.toLowerCase()}.md`, `${name} .txt`]) {
      const base = spelling.split(".")[0]!.trimEnd();
      expect(workspaceNameError(spelling, "win32")).toBe(`Windows keeps "${base}" for itself. Choose another name.`);
    }
  });

  it.each(["tail.", "tail ", "tail.md.", "tail.md "])("refuses the ending of %s", name => {
    expect(workspaceNameError(name, "win32"))
      .toBe("Windows removes dots and spaces at the end of a name. Remove the ending dot or space.");
  });

  it.each(["a\0b", "a\nb", "a\u001fb", "a\u007fb"])("refuses control characters in %j", name => {
    expect(workspaceNameError(name, "win32")).toBe("A name cannot contain control characters. Remove them.");
  });

  it("counts Windows component length in UTF-16 units", () => {
    expect(workspaceNameError("a".repeat(255), "win32")).toBeNull();
    expect(workspaceNameError("a".repeat(256), "win32")).toContain("Use a shorter name.");
    expect(workspaceNameError("😀".repeat(128), "win32")).toContain("too long for Windows");
  });

  it.each([".env", "旅の計画.md", "😀.md", "Notes.MD", "console.md", "COM0.md", "LPT10.md"])("allows %s", name => {
    expect(workspaceNameError(name, "win32")).toBeNull();
  });

  it.each(["darwin", "linux"])("leaves %s name policy unchanged", platform => {
    for (const name of ['a?b*"<>|:.md', "CON", "NUL.md", "tail.", "tail ", "a".repeat(256)]) {
      expect(workspaceNameError(name, platform)).toBeNull();
    }
  });
});

describe("destination paths", () => {
  it("keeps folder separators and checks every component", () => {
    expect(workspaceDestinationError("notes/旅.md", "win32")).toBeNull();
    expect(workspaceDestinationError("notes\\旅.md", "win32")).toBeNull();
    expect(workspaceDestinationError("./notes//旅.md", "win32")).toBeNull();
    expect(workspaceDestinationError("a?/b.md", "win32")).toContain("question mark");
    expect(workspaceDestinationError("NUL/b.md", "win32")).toBe('Windows keeps "NUL" for itself. Choose another name.');
  });

  it("refuses paths over the engine's UTF-8 byte limit", () => {
    const prefix = `${"a".repeat(200)}/`.repeat(5);
    expect(workspaceDestinationError(`${prefix}${"a".repeat(19)}`, "win32")).toBeNull();
    expect(workspaceDestinationError(`${prefix}${"a".repeat(20)}`, "win32")).toContain("too long for dohc");
    expect(workspaceDestinationError(`${prefix}${"旅".repeat(7)}`, "win32")).toContain("too long for dohc");
    expect(workspaceDestinationError(`${prefix}${"a".repeat(20)}`, "darwin")).toBeNull();
    expect(workspaceDestinationError(`${prefix}${"a".repeat(20)}`, "linux")).toBeNull();
  });
});
