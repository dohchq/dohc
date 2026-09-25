// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskList } from "@tiptap/extension-list";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DohcTaskItem, dohcMarkdownExtensions } from "./extensions";
import { NO_SELECTION_FORMAT, selectionFormat } from "./selectionFormat";

const extensions = [
  StarterKit.configure({ trailingNode: false }),
  ...dohcMarkdownExtensions,
  TaskList,
  DohcTaskItem,
  Markdown.configure({ indentation: { style: "space", size: 2 } }),
];

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  vi.restoreAllMocks();
});

function makeEditor(markdown: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions,
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

// The document position where `text` starts.
function positionOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1 || !node.isText) return;
    const at = node.text?.indexOf(text) ?? -1;
    if (at !== -1) found = pos + at;
  });
  if (found === -1) throw new Error(`no text ${text}`);
  return found;
}

const MARKS = ["bold", "italic", "underline", "strike", "code", "highlight", "link"] as const;

describe("selectionFormat", () => {
  it("returns one constant without a text selection", () => {
    const editor = makeEditor("# Heading\n\nText with **bold**.");
    editor.commands.setTextSelection(positionOf(editor, "bold") + 1);
    expect(selectionFormat(editor.state)).toBe(NO_SELECTION_FORMAT);
  });

  it("reports the marks TipTap reports, for each kind of selection", () => {
    const editor = makeEditor(
      [
        "Plain **bold words** and *slanted* text with `code` and ==marked== bits.",
        "",
        "A [linked page](https://example.com) and **bold `code` together**.",
        "",
        "```",
        "a code block",
        "```",
        "",
        "Last **paragraph**.",
      ].join("\n"),
    );
    // [text the selection starts at, selection length]
    const selections: Array<[string, number]> = [
      ["bold words", 10],
      ["bold words", 4],
      ["Plain", 12],
      ["slanted", 7],
      ["code", 4],
      ["marked", 6],
      ["linked page", 11],
      ["bold ", 17],
      ["bits.", 20],
      ["a code block", 18],
      ["paragraph", 9],
    ];
    const seen = new Set<string>();
    for (const [text, length] of selections) {
      const from = positionOf(editor, text);
      editor.commands.setTextSelection({ from, to: from + length });
      const format = selectionFormat(editor.state);
      for (const mark of MARKS) {
        expect(format[mark], `${mark} over "${text}" +${length}`).toBe(editor.isActive(mark));
        if (format[mark]) seen.add(mark);
      }
    }
    // Each mark the document uses was active for some selection.
    expect([...seen].sort()).toEqual(["bold", "code", "highlight", "italic", "link"]);
  });

  it("names the block the selection starts in", () => {
    const editor = makeEditor(
      ["## Section", "", "- item one", "", "> quoted", "", "> - quoted item", "", "- [ ] task"].join("\n"),
    );
    const expected: Array<[string, string]> = [
      ["Section", "heading-2"],
      ["item one", "bulleted-list"],
      ["quoted", "quote"],
      ["quoted item", "bulleted-list"],
      ["task", "task-list"],
    ];
    for (const [text, block] of expected) {
      const from = positionOf(editor, text);
      editor.commands.setTextSelection({ from, to: from + 3 });
      expect(selectionFormat(editor.state).block, text).toBe(block);
    }
  });

  // The toolbar evaluates this on every transaction. At 50,000 paragraphs a
  // walk from the document's start took milliseconds per mark.
  it("visits only the selected blocks of a large document", () => {
    const schema = getSchema(extensions);
    const paragraphs = Array.from({ length: 50_000 }, (_, index) =>
      schema.node("paragraph", null, [schema.text(`Paragraph ${index}`)]),
    );
    const last = schema.node("paragraph", null, [
      schema.text("The "),
      schema.text("end", [schema.marks.bold!.create()]),
    ]);
    const doc = schema.node("doc", null, [...paragraphs, last]);
    const end = doc.content.size - 1;
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, end - 3, end),
    });
    const walk = vi.spyOn(doc, "nodesBetween");
    const child = vi.spyOn(doc, "child");

    const format = selectionFormat(state);

    expect(format.bold).toBe(true);
    expect(format.block).toBe("paragraph");
    expect(walk).not.toHaveBeenCalled();
    expect(child).toHaveBeenCalledTimes(1);
  });
});
