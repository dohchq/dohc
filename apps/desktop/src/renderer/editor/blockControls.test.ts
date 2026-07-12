// @vitest-environment jsdom
import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { dohcMarkdownExtensions } from "./extensions";
import {
  activeTurnIntoId,
  blockDragSlice,
  copyBlockAsMarkdown,
  deleteBlock,
  duplicateBlock,
  resolveTurnIntoDropdown,
  serializeBlockToMarkdown,
  topLevelBlockPos,
  turnBlockInto,
  TURN_INTO_ENTRIES,
  TurnIntoMenu,
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
  cleanup();
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

describe("resolveTurnIntoDropdown", () => {
  it("opens below the trigger when the viewport has room", () => {
    expect(
      resolveTurnIntoDropdown(
        { left: 100, top: 100, bottom: 126 },
        { width: 1024, height: 768 },
      ),
    ).toEqual({ placement: "below", maxHeight: 320 });
  });

  it("flips above with a fitted max height near the viewport bottom", () => {
    expect(
      resolveTurnIntoDropdown(
        { left: 100, top: 300, bottom: 326 },
        { width: 1024, height: 400 },
      ),
    ).toEqual({ placement: "above", maxHeight: 282 });
  });
});

// Mount-level coverage for the dropdown itself: every option must be
// rendered readable (bullet 8a was the bubble menu's overflow clipping the
// dropdown to the toolbar's height), and the placement/max-height resolved
// at open time must land on the listbox element for the CSS to consume.
describe("TurnIntoMenu dropdown rendering", () => {
  it("opens a listbox with every turn-into option and the resolved placement/max height", () => {
    const editor = track(makeEditor("Hello world"));
    editor.commands.setTextSelection(3);
    render(createElement(TurnIntoMenu, { editor }));

    fireEvent.click(screen.getByTitle("Turn into"));
    const listbox = screen.getByRole("listbox", { name: "turn into" });
    // jsdom rects are all-zero -> plenty of room below at the default
    // viewport, so the dropdown gets its full height, uncapped by the bar.
    expect(listbox.getAttribute("data-placement")).toBe("below");
    expect(listbox.style.maxHeight).toBe("320px");
    for (const entry of TURN_INTO_ENTRIES) {
      expect(within(listbox).getByText(entry.label)).toBeTruthy();
    }
  });

  it("converts the selection's block when an option is clicked", () => {
    const editor = track(makeEditor("Some text"));
    editor.commands.setTextSelection(3);
    render(createElement(TurnIntoMenu, { editor }));

    fireEvent.click(screen.getByTitle("Turn into"));
    const listbox = screen.getByRole("listbox", { name: "turn into" });
    fireEvent.click(within(listbox).getByText("Heading 1"));

    expect(screen.queryByRole("listbox")).toBeNull();
    const first = editor.getJSON().content?.[0];
    expect(first?.type).toBe("heading");
    expect(first?.attrs?.level).toBe(1);
  });

  it("closes on Escape", async () => {
    const editor = track(makeEditor("Hello"));
    editor.commands.setTextSelection(3);
    const { container } = render(createElement(TurnIntoMenu, { editor }));
    container.append(editor.view.dom);
    // jsdom has no Range geometry for TipTap's post-focus scrolling.
    editor.view.setProps({ handleScrollToSelection: () => true });

    fireEvent.click(screen.getByTitle("Turn into"));
    const listbox = screen.getByRole("listbox", { name: "turn into" });
    expect(editor.view.hasFocus()).toBe(false);
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    await waitFor(() => expect(editor.view.hasFocus()).toBe(true));
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
