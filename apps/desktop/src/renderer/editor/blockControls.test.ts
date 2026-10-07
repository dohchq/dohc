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
import { TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { NodeSelection } from "@tiptap/pm/state";
import { inListView, mockListLayout } from "../ui/listLayout.testSupport";
import { DohcTaskItem, dohcMarkdownExtensions } from "./extensions";
import {
  BlockMenu,
  CLOSED_BLOCK_MENU_STATE,
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
  turnIntoIdAt,
  TURN_INTO_ENTRIES,
} from "./blockControls";

function makeEditor(markdown: string): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      TaskList,
      DohcTaskItem,
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
      DohcTaskItem,
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

describe("BlockMenu on the Menu part's recipe and rule", () => {
  function openMenu(onSelect = vi.fn(), onClose = vi.fn()) {
    const handle = document.createElement("button");
    handle.setAttribute("aria-label", "block actions");
    document.body.append(handle);
    const outside = document.createElement("button");
    document.body.append(outside);
    handle.focus();
    render(
      createElement(BlockMenu, {
        state: { open: true, pos: 0, x: 20, y: 20, maxHeight: 400, placement: "below", trigger: handle },
        onSelect,
        onClose,
      }),
    );
    const menu = screen.getByRole("menu", { name: "block actions" });
    const rows = screen.getAllByRole("menuitem");
    return { handle, outside, menu, rows, onSelect, onClose };
  }
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("keeps focus on its frame and names the active row, which the keys and a moving pointer move", () => {
    const { handle, menu, rows } = openMenu();
    expect(document.activeElement).toBe(menu);
    expect(handle.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("aria-activedescendant")).toBe(rows[0]?.id);
    expect(rows[0]?.hasAttribute("data-active")).toBe(true);

    fireEvent.keyDown(menu, { key: "End" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(rows.at(-1)?.id);
    fireEvent.keyDown(menu, { key: "h" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(rows[1]?.id);

    // A row that opens under a still pointer does not take the active row.
    fireEvent.mouseMove(rows[4]!, { movementX: 0, movementY: 0 });
    expect(rows[1]?.hasAttribute("data-active")).toBe(true);
    fireEvent.mouseMove(rows[4]!, { movementX: 0, movementY: 2 });
    expect(rows[4]?.hasAttribute("data-active")).toBe(true);
    expect(rows[1]?.hasAttribute("data-active")).toBe(false);
  });

  it("returns focus to the handle before the pick runs, so an action that edits can take it", () => {
    let focusedAtPick: Element | null = null;
    const { handle, menu, rows } = openMenu(vi.fn(() => {
      focusedAtPick = document.activeElement;
    }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: " " });
    expect(focusedAtPick).toBe(handle);
    fireEvent.click(rows[2]!);
    expect(focusedAtPick).toBe(handle);
  });

  it("closes on Escape without passing it on, on Tab, and on a press outside, but not on a press on its handle", () => {
    const parentEscape = vi.fn();
    document.addEventListener("keydown", parentEscape);
    const { handle, outside, menu, onClose } = openMenu();
    fireEvent.pointerDown(handle);
    fireEvent.focusOut(menu, { relatedTarget: handle });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parentEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(outside);
    expect(onClose).toHaveBeenCalledTimes(3);
    document.removeEventListener("keydown", parentEscape);
  });

  it("returns focus to the handle when a press on blank space that closed it ends", () => {
    const handle = document.createElement("button");
    document.body.append(handle);
    handle.focus();
    const open = { open: true, pos: 0, x: 20, y: 20, maxHeight: 400, placement: "below", trigger: handle } as const;
    const onClose = vi.fn();
    const { rerender } = render(createElement(BlockMenu, { state: open, onSelect: vi.fn(), onClose }));
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
    // The owner closes it; the browser's press puts focus on the page.
    rerender(createElement(BlockMenu, { state: CLOSED_BLOCK_MENU_STATE, onSelect: vi.fn(), onClose }));
    handle.blur();
    fireEvent.pointerUp(document.body);
    expect(document.activeElement).toBe(handle);
  });

  // The list is taller than its cap. jsdom has no layout: a 320px list over
  // 28px rows, with the Actions label 22px tall before the ninth row.
  it("keeps the active row inside the list's view as the keys move it past either end", () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const index = Number(/-row-(\d+)$/.exec(this.id)?.[1] ?? Number.NaN);
      if (!Number.isNaN(index)) return 26 + index * 28 + (index >= 8 ? 22 : 0);
      if (this.getAttribute("role") === "group") return this.previousElementSibling ? 250 : 4;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const { menu, rows } = openMenu();
    const inView = (row: HTMLElement) =>
      row.offsetTop >= menu.scrollTop && row.offsetTop + row.offsetHeight <= menu.scrollTop + menu.clientHeight;
    const remove = rows.at(-1)!;
    expect(inView(remove)).toBe(false);

    fireEvent.keyDown(menu, { key: "End" });
    expect(inView(remove)).toBe(true);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(inView(rows[0]!)).toBe(true);
    // The first row brings its section label along.
    expect(rows[0]!.parentElement!.offsetTop).toBeGreaterThanOrEqual(menu.scrollTop);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(inView(remove)).toBe(true);
  });

  // The site's demo mounts the editor in a shadow root, where a document
  // lookup by id finds nothing.
  it("keeps the active row in view inside an embedded editor's shadow root", () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      const index = Number(/-row-(\d+)$/.exec(this.id)?.[1] ?? Number.NaN);
      if (!Number.isNaN(index)) return 26 + index * 28 + (index >= 8 ? 22 : 0);
      if (this.getAttribute("role") === "group") return this.previousElementSibling ? 250 : 4;
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(28);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const host = document.createElement("div");
    document.body.append(host);
    const container = document.createElement("div");
    host.attachShadow({ mode: "open" }).append(container);
    render(
      createElement(BlockMenu, {
        state: { open: true, pos: 0, x: 20, y: 20, maxHeight: 400, placement: "below" },
        onSelect: vi.fn(),
        onClose: vi.fn(),
      }),
      { container },
    );
    const menu = container.querySelector<HTMLElement>("[role='menu']")!;
    const remove = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].at(-1)!;
    fireEvent.keyDown(menu, { key: "End" });
    expect(menu.getAttribute("aria-activedescendant")).toBe(remove.id);
    expect(remove.offsetTop).toBeGreaterThanOrEqual(menu.scrollTop);
    expect(remove.offsetTop + remove.offsetHeight).toBeLessThanOrEqual(menu.scrollTop + menu.clientHeight);
  });

  it("returns focus to the handle when the window loses focus", async () => {
    const handle = document.createElement("button");
    document.body.append(handle);
    handle.focus();
    const open = { open: true, pos: 0, x: 20, y: 20, maxHeight: 400, placement: "below", trigger: handle } as const;
    const onClose = vi.fn();
    const { rerender } = render(createElement(BlockMenu, { state: open, onSelect: vi.fn(), onClose }));
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    fireEvent.blur(window);
    expect(onClose).toHaveBeenCalledOnce();
    rerender(createElement(BlockMenu, { state: CLOSED_BLOCK_MENU_STATE, onSelect: vi.fn(), onClose }));
    await waitFor(() => expect(document.activeElement).toBe(handle));
  });

  it("shows Del beside the destructive row without adding it to the row's name", () => {
    const { rows } = openMenu();
    const remove = screen.getByRole("menuitem", { name: "Delete" });
    expect(remove).toBe(rows.at(-1));
    expect(remove.getAttribute("aria-keyshortcuts")).toBe("Delete");
    expect(within(remove).getByText("Del").getAttribute("aria-hidden")).toBe("true");
    expect(remove.className).toContain("text-danger");
  });
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
// reads the active entry via turnIntoIdAt. These tests exercise that
// same command-level path (resolve pos from selection -> turnBlockInto),
// rather than re-testing turnBlockInto's own per-id branches above.
describe("blockControls turn-into dropdown (bubble menu) command path", () => {
  it("keeps option clicks inside a shadow-root dropdown", () => {
    const editor = track(makeEditor("Some text"));
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const view = render(createElement(TurnIntoMenu, { editor, activeId: turnIntoIdAt(editor.state.selection.$from) }), {
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
    expect(turnIntoIdAt(editor.state.selection.$from)).toBe("heading-1");
  });

  it("reports paragraph as the default active entry for plain text", () => {
    const editor = track(makeEditor("Just text"));
    editor.commands.setTextSelection(3);
    expect(turnIntoIdAt(editor.state.selection.$from)).toBe("paragraph");
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
    expect(turnIntoIdAt(editor.state.selection.$from)).toBe("heading-2");
  });

  it("converts heading -> todo list using the position resolved from selection", () => {
    const editor = track(makeEditor("## Section"));
    editor.commands.setTextSelection(4);
    const pos = topLevelBlockPos(editor);
    expect(pos).not.toBeNull();
    turnBlockInto(editor, pos!, "task-list");
    const list = editor.getJSON().content?.[0];
    expect(list?.type).toBe("taskList");
    expect(turnIntoIdAt(editor.state.selection.$from)).toBe("task-list");
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
    render(createElement(TurnIntoMenu, { editor, activeId: turnIntoIdAt(editor.state.selection.$from) }));

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
    render(createElement(TurnIntoMenu, { editor, activeId: turnIntoIdAt(editor.state.selection.$from) }));

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
    const { container } = render(createElement(TurnIntoMenu, { editor, activeId: turnIntoIdAt(editor.state.selection.$from) }));
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

describe("TurnIntoMenu on the Menu part's recipe", () => {
  it("names its active option, moves by the Menu keys, keeps it in view, and keeps the current type's fill", () => {
    const restore = mockListLayout(150);
    const editor = track(makeEditor("Hello world"));
    editor.commands.setTextSelection(3);
    try {
      render(createElement(TurnIntoMenu, { editor, activeId: turnIntoIdAt(editor.state.selection.$from) }));
      fireEvent.click(screen.getByTitle("Turn into"));
      const listbox = screen.getByRole("listbox", { name: "turn into" });
      const options = within(listbox).getAllByRole("option");
      const text = options[0]!;
      expect(document.activeElement).toBe(listbox);
      expect(listbox.getAttribute("aria-activedescendant")).toBe(text.id);
      expect(text.className.split(" ")).toContain("bg-selected");

      fireEvent.keyDown(listbox, { key: "End" });
      const quote = options.at(-1)!;
      expect(listbox.getAttribute("aria-activedescendant")).toBe(quote.id);
      expect(quote.hasAttribute("data-active")).toBe(true);
      expect(inListView(listbox, quote)).toBe(true);
      // The block's own type keeps its fill when the active option leaves it.
      expect(text.className.split(" ")).toContain("bg-selected");
      fireEvent.keyDown(listbox, { key: "h" });
      expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);
      expect(inListView(listbox, options[1]!)).toBe(true);

      fireEvent.mouseMove(options[3]!, { movementX: 0, movementY: 0 });
      expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);

      // Ctrl+N is New file and Ctrl+B the files panel. They reach the shell,
      // which skips a prevented key, and leave the active option alone.
      const shell = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
      window.addEventListener("keydown", shell);
      try {
        for (const letter of ["n", "b"]) {
          expect(fireEvent.keyDown(listbox, { key: letter, ctrlKey: true })).toBe(true);
          expect(fireEvent.keyDown(listbox, { key: letter, metaKey: true })).toBe(true);
        }
      } finally {
        window.removeEventListener("keydown", shell);
      }
      expect(shell).toHaveBeenCalledTimes(4);
      expect(shell.mock.results.every((result) => result.value === false)).toBe(true);
      expect(listbox.getAttribute("aria-activedescendant")).toBe(options[1]!.id);

      fireEvent.keyDown(listbox, { key: " " });
      expect(editor.getJSON().content?.[0]?.attrs?.level).toBe(1);
    } finally {
      restore();
    }
  });
});

describe("blockControls copy as markdown", () => {
  it("serializes a heading block to markdown", () => {
    const editor = track(makeEditor("## Section"));
    const node = editor.state.doc.child(0);
    expect(serializeBlockToMarkdown(node)).toBe("## Section");
  });

  it("serializes a paragraph block to markdown", () => {
    const editor = track(makeEditor("Just text"));
    const node = editor.state.doc.child(0);
    expect(serializeBlockToMarkdown(node)).toBe("Just text");
  });

  it("serializes a bulleted list block to markdown", () => {
    const editor = track(makeEditor("- alpha\n- beta"));
    const node = editor.state.doc.child(0);
    const md = serializeBlockToMarkdown(node);
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

describe("blockControls drag ghost", () => {
  // jsdom has no DataTransfer. The dragstart handler only writes to it, so a
  // recording stub is enough to reach the ghost.
  function dragStart(handle: HTMLElement): void {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
      value: {
        clearData: () => {},
        setData: () => {},
        setDragImage: () => {},
        effectAllowed: "none",
      },
    });
    handle.dispatchEvent(event);
  }

  function parkedGhosts(): HTMLElement[] {
    return Array.from(
      document.body.querySelectorAll<HTMLElement>(".dohc-block-drag-ghost"),
    );
  }

  function twoBlockEditor(): Editor {
    return makeEditorWithControls({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Readable block text" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Second block" }] },
      ],
    });
  }

  function blockHandles(editor: Editor): HTMLElement[] {
    const handles = Array.from(
      editor.view.dom.querySelectorAll<HTMLElement>(".dohc-block-handle"),
    );
    if (handles.length < 2) throw new Error("block handles missing");
    return handles;
  }

  it("hides the parked clone and takes it down with the editor", () => {
    const editor = twoBlockEditor();
    const [handle] = blockHandles(editor);

    dragStart(handle);

    const [ghost] = parkedGhosts();
    expect(ghost?.textContent).toContain("Readable block text");
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");

    // A workspace switch destroys the editor mid-drag, so `dragend` never
    // fires. The clone carries document text into the next workspace's
    // accessibility tree unless the plugin removes it itself.
    editor.destroy();

    expect(parkedGhosts()).toHaveLength(0);
  });

  it("removes the parked clone when the drag ends normally", () => {
    const editor = track(twoBlockEditor());
    const [handle] = blockHandles(editor);

    dragStart(handle);
    expect(parkedGhosts()).toHaveLength(1);

    handle.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(parkedGhosts()).toHaveLength(0);
  });

  it("strands no clone when a second drag starts before the first ends", () => {
    const editor = twoBlockEditor();
    const [first, second] = blockHandles(editor);

    // A dragstart the browser never paired with a dragend — a dropped drag on
    // a non-target, say — leaves its ghost parked. The next dragstart has to
    // clear the slot, or that ghost becomes unreachable by every later
    // dragend and by destroy.
    dragStart(first);
    dragStart(second);
    expect(parkedGhosts()).toHaveLength(1);

    first.dispatchEvent(new Event("dragend", { bubbles: true }));
    second.dispatchEvent(new Event("dragend", { bubbles: true }));
    editor.destroy();

    expect(parkedGhosts()).toHaveLength(0);
  });
});
