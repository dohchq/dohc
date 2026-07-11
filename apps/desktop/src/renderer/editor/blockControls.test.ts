// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { dohcMarkdownExtensions } from "./extensions";
import {
  blockDragSlice,
  copyBlockAsMarkdown,
  deleteBlock,
  duplicateBlock,
  serializeBlockToMarkdown,
  turnBlockInto,
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
  while (editors.length) editors.pop()?.destroy();
  vi.restoreAllMocks();
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
