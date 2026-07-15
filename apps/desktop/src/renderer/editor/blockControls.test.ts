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
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { NodeSelection } from "@tiptap/pm/state";
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
  resolveTurnIntoDropdown,
  serializeBlockToMarkdown,
  topLevelBlockPos,
  TurnIntoMenu,
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

  const deletableBlocks = [
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
  ] as const;

  it.each(
    (["Backspace", "Delete"] as const).flatMap((key) =>
      deletableBlocks.map(([label, target]) => [label, key, target] as const),
    ),
  )("deletes a selected %s with %s", (_label, key, target) => {
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

    const event = new KeyboardEvent("keydown", { key, bubbles: true });
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

  it("does not delete a parent block for a nested node selection", () => {
    const editor = track(
      makeEditorWithControls({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "image",
                attrs: { src: "asset.png", alt: "asset", title: null },
              },
            ],
          },
        ],
      }),
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 1)),
    );

    expect(deleteSelectedTopLevelBlock(editor.view)).toBe(false);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).child(0).type.name).toBe("image");
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

    editor.view.dom.dispatchEvent(
      new MouseEvent("mouseleave", { bubbles: true }),
    );
    expect(controls.every((control) => !control.classList.contains("is-visible"))).toBe(
      true,
    );
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
  it("keeps option clicks inside a shadow-root dropdown", () => {
    const editor = track(makeEditor("Some text"));
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const view = render(createElement(TurnIntoMenu, { editor }), {
      container: shadow as unknown as HTMLElement,
    });

    fireEvent.click(view.getByTitle("Turn into"));
    const heading = view.getByRole("option", { name: /Heading 1/ });
    heading.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true }),
    );
    heading.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(editor.getJSON().content?.[0]?.type).toBe("heading");
    expect(editor.getJSON().content?.[0]?.attrs?.level).toBe(1);
    host.remove();
  });

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
