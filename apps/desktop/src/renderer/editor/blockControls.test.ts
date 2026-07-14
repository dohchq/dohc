// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { dohcMarkdownExtensions } from "./extensions";
import {
  activeTurnIntoId,
  BlockMenu,
  blockDragSlice,
  copyBlockAsMarkdown,
  deleteBlock,
  deleteSelectedTopLevelBlock,
  duplicateBlock,
  makeBlockControlsPlugin,
  selectBlock,
  serializeBlockToMarkdown,
  topLevelBlockPos,
  turnBlockInto,
  TURN_INTO_ENTRIES,
} from "./blockControls";

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

function makeEditorWithControls(content: Record<string, unknown>): Editor {
  const controls = Extension.create({
    name: "testBlockControls",
    addProseMirrorPlugins() {
      return [
        makeBlockControlsPlugin({
          onInsertRef: { current: vi.fn() },
          onOpenMenuRef: { current: vi.fn() },
        }),
      ];
    },
  });
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      TaskList,
      TaskItem,
      TableKit,
      controls,
    ],
    content,
  });
}

/** Top-level block node types, in document order, with their start positions. */
function topLevelBlocks(editor: Editor): { type: string; pos: number }[] {
  const blocks: { type: string; pos: number }[] = [];
  editor.state.doc.forEach((node, offset) => {
    blocks.push({ type: node.type.name, pos: offset });
  });
  return blocks;
}

const editors: Editor[] = [];
function track(editor: Editor): Editor {
  editors.push(editor);
  return editor;
}

afterEach(() => {
  cleanup();
  while (editors.length) editors.pop()?.destroy();
  vi.restoreAllMocks();
});

describe("blockControls menu keyboard deletion", () => {
  it.each(["Backspace", "Delete"])(
    "routes %s to the selected block's delete action",
    (key) => {
      const onSelect = vi.fn();
      render(
        createElement(BlockMenu, {
          state: {
            open: true,
            pos: 0,
            x: 20,
            y: 20,
            maxHeight: 400,
            placement: "below",
          },
          onSelect,
          onClose: vi.fn(),
        }),
      );

      fireEvent.keyDown(screen.getByRole("menu", { name: "block actions" }), {
        key,
      });
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "action", id: "delete" }),
      );
    },
  );
});

describe("blockControls duplicate", () => {
  it("inserts a copy of a paragraph directly after itself", () => {
    const editor = track(makeEditor("Hello"));
    duplicateBlock(editor, 0);
    const blocks = topLevelBlocks(editor);
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(editor.state.doc.child(0).textContent).toBe("Hello");
    expect(editor.state.doc.child(1).textContent).toBe("Hello");
  });

  it("duplicates a heading while preserving its level", () => {
    const editor = track(makeEditor("## Title"));
    duplicateBlock(editor, 0);
    const json = editor.getJSON();
    expect(json.content?.map((n) => n.type)).toEqual(["heading", "heading"]);
    expect(json.content?.[0]?.attrs?.level).toBe(2);
    expect(json.content?.[1]?.attrs?.level).toBe(2);
  });

  it("duplicates a whole bulleted list block", () => {
    const editor = track(makeEditor("- one\n- two"));
    const [list] = topLevelBlocks(editor);
    expect(list.type).toBe("bulletList");
    duplicateBlock(editor, list.pos);
    expect(topLevelBlocks(editor).map((b) => b.type)).toEqual([
      "bulletList",
      "bulletList",
    ]);
  });
});

describe("blockControls delete", () => {
  it("removes the targeted top-level block", () => {
    const editor = track(makeEditor("First\n\nSecond"));
    const blocks = topLevelBlocks(editor);
    expect(blocks).toHaveLength(2);
    deleteBlock(editor, blocks[1].pos);
    const remaining = topLevelBlocks(editor);
    expect(remaining).toHaveLength(1);
    expect(editor.state.doc.child(0).textContent).toBe("First");
  });

  it.each([
    ["code block", { type: "codeBlock", content: [{ type: "text", text: "code" }] }],
    ["divider", { type: "horizontalRule" }],
    [
      "table",
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "cell" }] }],
              },
            ],
          },
        ],
      },
    ],
    ["math block", { type: "mathBlock", attrs: { tex: "1+1=2" } }],
  ])("deletes a selected %s with Backspace", (_label, target) => {
    const editor = track(
      makeEditorWithControls({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Before" }] },
          target,
          { type: "paragraph", content: [{ type: "text", text: "After" }] },
        ],
      }),
    );
    const [, selected] = topLevelBlocks(editor);
    selectBlock(editor, selected.pos);

    const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true });
    editor.view.dom.dispatchEvent(event);

    expect(topLevelBlocks(editor).map((block) => block.type)).toEqual([
      "paragraph",
      "paragraph",
    ]);
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
  });

  it("does not delete a block for an ordinary text selection", () => {
    const editor = track(
      makeEditorWithControls({
        type: "doc",
        content: [
          { type: "codeBlock", content: [{ type: "text", text: "code" }] },
        ],
      }),
    );
    editor.commands.setTextSelection(2);
    expect(deleteSelectedTopLevelBlock(editor.view)).toBe(false);
    expect(editor.state.doc.child(0).type.name).toBe("codeBlock");
  });
});

describe("blockControls gutter coverage", () => {
  it("renders one top-level gutter for every structural block", () => {
    const editor = track(
      makeEditorWithControls({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Text" }] },
          { type: "codeBlock", content: [{ type: "text", text: "code" }] },
          { type: "horizontalRule" },
          {
            type: "table",
            content: [
              {
                type: "tableRow",
                content: [
                  { type: "tableCell", content: [{ type: "paragraph" }] },
                ],
              },
            ],
          },
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: false },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "Task" }] },
                ],
              },
            ],
          },
          { type: "callout", attrs: { calloutType: "note", title: "", fold: "" }, content: [{ type: "paragraph" }] },
          { type: "mathBlock", attrs: { tex: "x" } },
          { type: "queryBlock", attrs: { info: "" }, content: [{ type: "text", text: "query" }] },
        ],
      }),
    );

    const controls = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(".dohc-block-affordance"),
    );
    expect(controls).toHaveLength(editor.state.doc.childCount);
    expect(controls.map((control) => control.dataset.dohcBlockIndex)).toEqual(
      Array.from({ length: editor.state.doc.childCount }, (_, index) => String(index)),
    );
    expect(controls.every((control) => control.parentElement === editor.view.dom)).toBe(true);

    const code = editor.view.dom.querySelector<HTMLElement>(
      '[data-dohc-block-index="1"].dohc-block-node',
    );
    code?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(controls[1]?.classList.contains("is-visible")).toBe(true);
    expect(controls[0]?.classList.contains("is-visible")).toBe(false);
  });
});

describe("blockControls turn into", () => {
  it("turns a paragraph into a heading 1", () => {
    const editor = track(makeEditor("Note"));
    turnBlockInto(editor, 0, "heading-1");
    const first = editor.getJSON().content?.[0];
    expect(first?.type).toBe("heading");
    expect(first?.attrs?.level).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe("Note");
  });

  it("turns a heading back into a paragraph", () => {
    const editor = track(makeEditor("# Heading"));
    turnBlockInto(editor, 0, "paragraph");
    expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    expect(editor.state.doc.child(0).textContent).toBe("Heading");
  });

  it("turns a paragraph into a bulleted list (list item)", () => {
    const editor = track(makeEditor("Item"));
    turnBlockInto(editor, 0, "bulleted-list");
    const list = editor.getJSON().content?.[0];
    expect(list?.type).toBe("bulletList");
    expect(list?.content?.[0]?.type).toBe("listItem");
    expect(editor.state.doc.textContent).toBe("Item");
  });

  it("turns a paragraph into a todo list", () => {
    const editor = track(makeEditor("Task"));
    turnBlockInto(editor, 0, "task-list");
    const list = editor.getJSON().content?.[0];
    expect(list?.type).toBe("taskList");
    expect(list?.content?.[0]?.type).toBe("taskItem");
  });
});

// The bubble menu's turn-into dropdown (blockControls.tsx's TurnIntoMenu)
// doesn't get handed a block position the way the block context menu does —
// it derives one from the current text selection via topLevelBlockPos, and
// reads the active entry via activeTurnIntoId. These tests exercise that
// same command-level path (resolve pos from selection -> turnBlockInto),
// rather than re-testing turnBlockInto's own per-id branches above.
describe("blockControls turn-into dropdown (bubble menu) command path", () => {
  it("resolves the top-level block position from a selection nested in its text", () => {
    const editor = track(makeEditor("Hello world"));
    editor.commands.setTextSelection(5);
    expect(topLevelBlockPos(editor)).toBe(0);
  });

  it("resolves the top-level block position from the second block in the doc", () => {
    const editor = track(makeEditor("First\n\nSecond"));
    const [, second] = topLevelBlocks(editor);
    editor.commands.setTextSelection(second.pos + 2);
    expect(topLevelBlockPos(editor)).toBe(second.pos);
  });

  it("reports the active turn-into entry for the block the selection sits in", () => {
    const editor = track(makeEditor("# Heading"));
    editor.commands.setTextSelection(3);
    expect(activeTurnIntoId(editor)).toBe("heading-1");
  });

  it("reports paragraph as the default active entry for plain text", () => {
    const editor = track(makeEditor("Just text"));
    editor.commands.setTextSelection(3);
    expect(activeTurnIntoId(editor)).toBe("paragraph");
  });

  it("converts paragraph -> heading using the position resolved from selection", () => {
    const editor = track(makeEditor("Some text"));
    editor.commands.setTextSelection(5);
    const pos = topLevelBlockPos(editor);
    expect(pos).not.toBeNull();
    turnBlockInto(editor, pos!, "heading-2");
    const first = editor.getJSON().content?.[0];
    expect(first?.type).toBe("heading");
    expect(first?.attrs?.level).toBe(2);
    expect(activeTurnIntoId(editor)).toBe("heading-2");
  });

  it("converts heading -> todo list using the position resolved from selection", () => {
    const editor = track(makeEditor("## Section"));
    editor.commands.setTextSelection(4);
    const pos = topLevelBlockPos(editor);
    expect(pos).not.toBeNull();
    turnBlockInto(editor, pos!, "task-list");
    const list = editor.getJSON().content?.[0];
    expect(list?.type).toBe("taskList");
    expect(activeTurnIntoId(editor)).toBe("task-list");
  });

  it("keeps TURN_INTO_ENTRIES' labels/order identical to the block menu's turn-into section", () => {
    expect(TURN_INTO_ENTRIES.map((entry) => entry.label)).toEqual([
      "Text",
      "Heading 1",
      "Heading 2",
      "Heading 3",
      "Bulleted list",
      "Numbered list",
      "Todo list",
      "Quote",
    ]);
  });
});

describe("blockControls copy as markdown", () => {
  it("serializes a heading block to markdown", () => {
    const editor = track(makeEditor("## Section"));
    const node = editor.state.doc.child(0);
    expect(serializeBlockToMarkdown(editor, node)).toBe("## Section");
  });

  it("serializes a paragraph block to markdown", () => {
    const editor = track(makeEditor("Just text"));
    const node = editor.state.doc.child(0);
    expect(serializeBlockToMarkdown(editor, node)).toBe("Just text");
  });

  it("serializes a bulleted list block to markdown", () => {
    const editor = track(makeEditor("- alpha\n- beta"));
    const node = editor.state.doc.child(0);
    const md = serializeBlockToMarkdown(editor, node);
    expect(md).toMatch(/^[-*]\s+alpha$/m);
    expect(md).toMatch(/^[-*]\s+beta$/m);
  });

  it("writes the block markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const editor = track(makeEditor("# Copy me"));
    await copyBlockAsMarkdown(editor, 0);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("# Copy me");
  });
});

describe("blockControls drag payload", () => {
  it("builds a slice whose single child is the dragged block", () => {
    const editor = track(makeEditor("First\n\n## Second"));
    const blocks = topLevelBlocks(editor);
    const slice = blockDragSlice(editor.view, blocks[1].pos);
    expect(slice).not.toBeNull();
    expect(slice?.openStart).toBe(0);
    expect(slice?.openEnd).toBe(0);
    expect(slice?.content.childCount).toBe(1);
    const dragged = slice?.content.firstChild;
    expect(dragged?.type.name).toBe("heading");
    expect(dragged?.textContent).toBe("Second");
    // Matches the actual document node, mirroring ProseMirror's own
    // NodeSelection.content() drag payload.
    expect(dragged?.eq(editor.state.doc.child(1))).toBe(true);
  });
});
