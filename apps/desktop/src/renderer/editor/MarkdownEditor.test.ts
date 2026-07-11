// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findEmptyListItemParagraph } from "./codeBlockChrome";
import { filterSlashCommands, findSlashCommandMatch } from "./slashCommands";

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
    expect(filterSlashCommands("todo").map((item) => item.id)).toEqual([
      "task-list",
    ]);
  });
});

describe("MarkdownEditor empty list item focus", () => {
  it("recognizes an empty ordered-list item as a valid cursor target", () => {
    const ol = document.createElement("ol");
    ol.innerHTML = `
      <li><p>Test</p></li>
      <li><p>Test</p></li>
      <li><p><br class="ProseMirror-trailingBreak"></p></li>
    `;
    const emptyParagraph = ol.querySelector("li:last-child > p");

    expect(findEmptyListItemParagraph(ol.querySelector("li:last-child"))).toBe(
      emptyParagraph,
    );
    expect(
      findEmptyListItemParagraph(
        ol.querySelector("li:last-child br.ProseMirror-trailingBreak"),
      ),
    ).toBe(emptyParagraph);
  });

  it("leaves populated list items to the browser/ProseMirror default", () => {
    const ol = document.createElement("ol");
    ol.innerHTML = "<li><p>Test</p></li>";

    expect(findEmptyListItemParagraph(ol.querySelector("li"))).toBeNull();
  });
});
