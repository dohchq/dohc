// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { dohcMarkdownExtensions } from "./extensions";
import { findEmptyListItemParagraph } from "./codeBlockChrome";
import {
  CLOSED_SLASH_COMMAND_STATE,
  filterSlashCommands,
  findSlashCommandMatch,
  runSlashCommand,
  type SlashCommandState,
} from "./slashCommands";

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

  it("lists the image command by label and by its aliases", () => {
    expect(filterSlashCommands("image").map((item) => item.id)).toContain("image");
    expect(filterSlashCommands("photo").map((item) => item.id)).toEqual(["image"]);
    expect(filterSlashCommands("upload").map((item) => item.id)).toEqual(["image"]);
  });
});

describe("MarkdownEditor slash command: image", () => {
  function makeEditor(markdown: string): Editor {
    return new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        ...dohcMarkdownExtensions,
        TaskList,
        TaskItem,
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
      ],
      content: markdown,
      contentType: "markdown",
    });
  }

  it("deletes the '/image' text and hands off to the picker trigger instead of inserting text", () => {
    const editor = makeEditor("/image");
    const setSlashState = vi.fn();
    const insertImage = vi.fn();
    // "/image" is 6 chars starting at doc pos 1 (inside the paragraph).
    const state: SlashCommandState = {
      open: true,
      from: 1,
      to: 7,
      query: "image",
      selected: 0,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };

    runSlashCommand(editor, "image", state, setSlashState, insertImage);

    expect(setSlashState).toHaveBeenCalledWith(CLOSED_SLASH_COMMAND_STATE);
    expect(editor.getText()).toBe("");
    expect(insertImage).toHaveBeenCalledTimes(1);
    expect(insertImage).toHaveBeenCalledWith(editor.view, 1);
    editor.destroy();
  });

  it("does not touch the picker when insertImage isn't wired up (no-op, not a throw)", () => {
    const editor = makeEditor("/image");
    const setSlashState = vi.fn();
    const state: SlashCommandState = {
      open: true,
      from: 1,
      to: 7,
      query: "image",
      selected: 0,
      x: 0,
      y: 0,
      maxHeight: 0,
      placement: "below",
    };

    expect(() =>
      runSlashCommand(editor, "image", state, setSlashState),
    ).not.toThrow();
    expect(editor.getText()).toBe("");
    editor.destroy();
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
