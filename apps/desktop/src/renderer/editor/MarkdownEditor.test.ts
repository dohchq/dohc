import { describe, expect, it } from "vitest";
import { filterSlashCommands, findSlashCommandMatch } from "./MarkdownEditor";

describe("MarkdownEditor slash commands", () => {
  it("detects a trailing slash command query inside plain text", () => {
    expect(findSlashCommandMatch("/hea")).toEqual({ slashOffset: 0, query: "hea" });
    expect(findSlashCommandMatch("make a /table")).toEqual({
      slashOffset: 7,
      query: "table",
    });
  });

  it("ignores slashes that are not the active command at the cursor", () => {
    expect(findSlashCommandMatch("https://dohc.local")).toBeNull();
    expect(findSlashCommandMatch("/not a command")).toBeNull();
  });

  it("filters by labels and aliases", () => {
    expect(filterSlashCommands("h2").map((item) => item.id)).toEqual([
      "heading-2",
    ]);
    expect(filterSlashCommands("grid").map((item) => item.id)).toEqual([
      "table",
    ]);
  });
});
