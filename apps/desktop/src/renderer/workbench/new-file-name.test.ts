import { describe, expect, it } from "vitest";
import { withMarkdownDefault } from "./new-file-name";

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

  it("leaves dotfiles literal — a leading dot is not an extension", () => {
    expect(withMarkdownDefault(".env")).toBe(".env");
    expect(withMarkdownDefault("config/.gitignore")).toBe("config/.gitignore");
  });

  it("treats a trailing dot as an extension not typed yet", () => {
    expect(withMarkdownDefault("notes.")).toBe("notes.md");
  });

  it("leaves empty and path-token leaves untouched", () => {
    expect(withMarkdownDefault("")).toBe("");
    expect(withMarkdownDefault("notes/")).toBe("notes/");
    expect(withMarkdownDefault(".")).toBe(".");
    expect(withMarkdownDefault("..")).toBe("..");
  });
});
