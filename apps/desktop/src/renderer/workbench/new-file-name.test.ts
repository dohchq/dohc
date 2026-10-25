import { describe, expect, it } from "vitest";
import { workspaceDestinationError } from "@dohc/workspace-contracts/workspace-paths";
import { nextPagePath, pageFileStem, withMarkdownDefault, withRenameDefault } from "./new-file-name";

describe("pageFileStem", () => {
  it("keeps a title a file can hold as typed", () => {
    expect(pageFileStem("Trip to Lisbon", "win32")).toBe("Trip to Lisbon");
    expect(pageFileStem("Café, día 2", "darwin")).toBe("Café, día 2");
  });

  it("turns characters a file name cannot hold into spaces", () => {
    expect(pageFileStem("Q3: plan/budget?", "linux")).toBe("Q3 plan budget");
    expect(pageFileStem('a\\b*c"d<e>f|g', "win32")).toBe("a b c d e f g");
    expect(pageFileStem("line one\nline two\t", "win32")).toBe("line one line two");
  });

  it("drops leading dots and trailing dots and spaces", () => {
    expect(pageFileStem(".env notes", "linux")).toBe("env notes");
    expect(pageFileStem("  Wait...  ", "win32")).toBe("Wait");
  });

  it("is Untitled when nothing nameable is left", () => {
    expect(pageFileStem("", "win32")).toBe("Untitled");
    expect(pageFileStem("   ", "win32")).toBe("Untitled");
    expect(pageFileStem("???", "darwin")).toBe("Untitled");
    expect(pageFileStem("CON", "win32")).toBe("Untitled");
  });

  it("caps a long title at 120 characters", () => {
    const stem = pageFileStem(`${"é".repeat(119)} tail`, "win32");
    expect(Array.from(stem)).toHaveLength(119);
  });
});

describe("nextPagePath", () => {
  it("takes the plain name in the folder when it is free", () => {
    expect(nextPagePath("", "Untitled", new Set())).toBe("Untitled.md");
    expect(nextPagePath("Trip", "Plan", new Set(["plan.md"]))).toBe("Trip/Plan.md");
  });

  it("numbers the name past every taken one, ignoring case", () => {
    expect(nextPagePath("", "Untitled", new Set(["untitled.md"]))).toBe("Untitled 2.md");
    expect(nextPagePath("Trip", "Plan", new Set(["trip/plan.md", "trip/plan 2.md"]))).toBe("Trip/Plan 3.md");
  });

  it("cuts the name short so a path in a deep folder stays inside the engine's limit", () => {
    const folder = Array.from({ length: 5 }, () => "f".repeat(200)).join("/");
    const stem = pageFileStem("旅".repeat(120), "win32");
    const path = nextPagePath(folder, stem, new Set());
    expect(workspaceDestinationError(path, "win32")).toBeNull();
    expect(path).toBe(`${folder}/${"旅".repeat(5)}.md`);
    const next = nextPagePath(folder, stem, new Set([path.toLowerCase()]));
    expect(workspaceDestinationError(next, "win32")).toBeNull();
    expect(next).toBe(`${folder}/${"旅".repeat(4)} 2.md`);
  });
});

describe("withMarkdownDefault", () => {
  it("appends .md to a plain name", () => {
    expect(withMarkdownDefault("notes")).toBe("notes.md");
  });

  it("appends .md to the leaf of a nested path", () => {
    expect(withMarkdownDefault("plans/2026/roadmap")).toBe(
      "plans/2026/roadmap.md",
    );
  });

  it("respects an explicit extension exactly", () => {
    expect(withMarkdownDefault("notes.txt")).toBe("notes.txt");
    expect(withMarkdownDefault("data.csv")).toBe("data.csv");
    expect(withMarkdownDefault("NOTES.TXT")).toBe("NOTES.TXT");
    expect(withMarkdownDefault("archive.tar.gz")).toBe("archive.tar.gz");
  });

  it("only looks at the leaf, not dots in folder names", () => {
    expect(withMarkdownDefault("docs.v2/notes")).toBe("docs.v2/notes.md");
    expect(withMarkdownDefault("docs.v2/notes.txt")).toBe("docs.v2/notes.txt");
  });

  it("treats backslashes as separators like backend validation does", () => {
    expect(withMarkdownDefault("docs.v2\\plan")).toBe("docs.v2\\plan.md");
    expect(withMarkdownDefault(".notes\\plan")).toBe(".notes\\plan.md");
    expect(withMarkdownDefault("docs\\plan.txt")).toBe("docs\\plan.txt");
  });

  it("leaves dotfiles literal — a leading dot is not an extension", () => {
    expect(withMarkdownDefault(".env")).toBe(".env");
    expect(withMarkdownDefault("config/.gitignore")).toBe("config/.gitignore");
  });

  it("treats a trailing dot as an extension not typed yet", () => {
    expect(withMarkdownDefault("notes.")).toBe("notes.md");
  });

  it("strips trailing separators — the backend drops empty segments", () => {
    expect(withMarkdownDefault("notes/")).toBe("notes.md");
    expect(withMarkdownDefault("notes\\")).toBe("notes.md");
    expect(withMarkdownDefault("plans/2026/")).toBe("plans/2026.md");
    expect(withMarkdownDefault("notes.txt/")).toBe("notes.txt/");
  });

  it("leaves empty and path-token leaves untouched", () => {
    expect(withMarkdownDefault("")).toBe("");
    expect(withMarkdownDefault("/")).toBe("/");
    expect(withMarkdownDefault(".")).toBe(".");
    expect(withMarkdownDefault("..")).toBe("..");
  });
});

describe("withRenameDefault", () => {
  it("gives a typed name without an extension the file's own extension", () => {
    expect(withRenameDefault("notes.md", "notes")).toBe("notes.md");
    expect(withRenameDefault("report.csv", "report")).toBe("report.csv");
    expect(withRenameDefault("report.csv", "summary")).toBe("summary.csv");
    expect(withRenameDefault("report.csv", "summary.")).toBe("summary.csv");
    expect(withRenameDefault("docs/plan.txt", "docs/outline")).toBe("docs/outline.txt");
  });

  it("gives back only the last part of a multi-part extension", () => {
    expect(withRenameDefault("archive.tar.gz", "archive")).toBe("archive.gz");
  });

  it("respects a typed extension or dotfile exactly", () => {
    expect(withRenameDefault("hello.m", "hello.txt")).toBe("hello.txt");
    expect(withRenameDefault("archive.tar.gz", "backup.tar.gz")).toBe("backup.tar.gz");
    expect(withRenameDefault("report.csv", ".env")).toBe(".env");
  });

  it("treats a last-dot tail with whitespace as no extension", () => {
    expect(withRenameDefault("Dr. Smith notes", "Smith")).toBe("Smith");
    expect(withRenameDefault("Mr. Rogers", "Fred")).toBe("Fred");
  });

  it("takes the typed name for a file without an extension", () => {
    expect(withRenameDefault("LICENSE", "LICENSE")).toBe("LICENSE");
    expect(withRenameDefault("LICENSE", "NOTICE")).toBe("NOTICE");
    expect(withRenameDefault("docs/Makefile", "docs/Rakefile")).toBe("docs/Rakefile");
    expect(withRenameDefault(".env", "env")).toBe("env");
    expect(withRenameDefault("LICENSE", "LICENSE.txt")).toBe("LICENSE.txt");
  });
});
