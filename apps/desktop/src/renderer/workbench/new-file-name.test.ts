import { describe, expect, it } from "vitest";
import { withMarkdownDefault, withRenameDefault } from "./new-file-name";

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

  it("takes the typed name for a file without an extension", () => {
    expect(withRenameDefault("LICENSE", "LICENSE")).toBe("LICENSE");
    expect(withRenameDefault("LICENSE", "NOTICE")).toBe("NOTICE");
    expect(withRenameDefault("docs/Makefile", "docs/Rakefile")).toBe("docs/Rakefile");
    expect(withRenameDefault(".env", "env")).toBe("env");
    expect(withRenameDefault("LICENSE", "LICENSE.txt")).toBe("LICENSE.txt");
  });
});
