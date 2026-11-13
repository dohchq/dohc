// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, type TiptapEditorHTMLElement } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { marked } from "marked";
import { TaskList } from "@tiptap/extension-list";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { prosemirrorJSONToYXmlFragment } from "y-prosemirror";
import { DohcTaskItem } from "@dohc/ydoc-projection/markdown-extensions";
import { desktopMarkdownExtensions } from "./extensions";
import { getDohcProseMirrorSchema, getDohcYDocBodyFragment, markdownToYDoc } from "@dohc/ydoc-projection";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { sendToFocusedEditor } from "./editorMenuCommands";
import { findReplaceKey } from "./findReplace";
import { makeCodeBlockContinuationPlugin } from "./codeBlockChrome";
import { CLOSED_SLASH_COMMAND_STATE, runSlashCommand, type SlashCommandState } from "./slashCommands";

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollIntoView",
);

async function flushAnimationFrames(count = 2): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < count; frame += 1) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
  });
}

/** The Tiptap editor behind a mounted MarkdownEditor surface. */
function editorBehind(surface: HTMLElement): Editor {
  const { editor } = surface as TiptapEditorHTMLElement;
  if (!editor) throw new Error("The editor surface has no Tiptap editor mounted.");
  return editor;
}

function selectionTextOffset(element: HTMLElement): number | null {
  const selection = document.getSelection();
  if (!selection?.anchorNode) return null;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 16)),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  cleanup();
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(
      Element.prototype,
      "scrollIntoView",
      scrollIntoViewDescriptor,
    );
  } else {
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
  vi.unstubAllGlobals();
});

// prosemirror-state's TextSelection construction warning is a module-level,
// once-per-process latch (`warnedAboutTextSelection` in prosemirror-state's
// checkTextSelection) — it logs at most once for the life of this test
// process. These pins are only honest while this describe block is the
// first one in this file to construct a collab editor: if some earlier suite
// already tripped the latch, `console.warn` assertions below would pass
// vacuously (the warning simply never fires again) whether or not the fix
// still works. Keep this describe first in the file.
it("keeps editor tokenizers out of the process-wide Markdown registry", async () => {
  const registrations = () => {
    const extensions = marked.defaults.extensions;
    return {
      inline: extensions?.inline?.length ?? 0,
      block: extensions?.block?.length ?? 0,
      startInline: extensions?.startInline?.length ?? 0,
      startBlock: extensions?.startBlock?.length ?? 0,
    };
  };
  const before = registrations();
  for (let index = 0; index < 3; index++) {
    const view = render(createElement(MarkdownEditor, {
      value: "A ==highlight== and [[note]]\n\n> [!NOTE]\n> callout\n",
      onDirty: vi.fn(), workspaceId: "workspace-1", path: `note-${index}.md`, knownFiles: [],
    }));
    const editor = await screen.findByTestId("markdown-editor");
    expect(editor.querySelector("mark")?.textContent).toBe("highlight");
    expect(editor.textContent).toContain("callout");
    view.unmount();
    expect(registrations()).toEqual(before);
  }
});

describe("MarkdownEditor collaboration selection", () => {

  // The selection seed must be recomputed on every editor rebuild, not just
  // when collab.ydoc's own identity changes. useEditor rebuilds (destroys
  // and reconstructs the tiptap Editor) whenever `extensions` changes
  // identity — which happens when awareness is added, removed, or swapped,
  // since CollaborationCaret is only registered when awareness is present.
  // A seed memoized on [collab?.ydoc] alone would survive that rebuild
  // holding the doc's shape from MOUNT time — reseeding the fresh editor
  // with a stale (here: paragraph-first) path even though the doc's real
  // leading node is now a taskList, recreating the invalid selection.
  it("recomputes the selection seed on a rebuild, not the mount-time doc shape", async () => {
    const selectionWarning =
      /TextSelection endpoint not pointing into a node with inline content/;
    const warn = vi.spyOn(console, "warn");
    const ydoc = markdownToYDoc("First paragraph.");
    const view = render(
      createElement(MarkdownEditor, {
        value: "First paragraph.",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/rebuild.md",
        knownFiles: [],
        collab: { ydoc, status: "connected", peerCount: 0, synced: true },
      }),
    );

    let awareness: Awareness | undefined;
    try {
      await screen.findByTestId("markdown-editor");
      await waitFor(() =>
        expect(screen.getByTestId("markdown-editor").textContent).toContain(
          "First paragraph.",
        ),
      );

      // Rewrite the same Y.Doc's body to a taskList-first shape — an
      // external actor replacing content, not typed through the bound
      // editor (which would apply incrementally and never exercise a fresh
      // mount's seed path at all). The fragment is cleared first:
      // prosemirrorJSONToYXmlFragment reconciles against existing content
      // (the same diff it uses for live typing) rather than hard-replacing
      // it, so writing a taskList over an already-populated paragraph
      // fragment without clearing it first collapses onto the old
      // paragraph's structure instead of truly becoming a taskList.
      const bodyFragment = getDohcYDocBodyFragment(ydoc);
      ydoc.transact(() => {
        bodyFragment.delete(0, bodyFragment.length);
      });
      prosemirrorJSONToYXmlFragment(
        getDohcProseMirrorSchema(),
        {
          type: "doc",
          content: [
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: "parent" }] },
                  ],
                },
              ],
            },
          ],
        },
        bodyFragment,
      );

      // Adding awareness changes `extensions`' identity — one of
      // useEditor's own rebuild deps — which destroys the bound editor and
      // constructs a fresh one, exercising the same y-tiptap
      // _forceRerender path #705 fixed for the initial mount.
      awareness = new Awareness(ydoc);
      view.rerender(
        createElement(MarkdownEditor, {
          value: "First paragraph.",
          onDirty: vi.fn(),
          workspaceId: "workspace-1",
          path: "notes/rebuild.md",
          knownFiles: [],
          collab: { ydoc, awareness, status: "connected", peerCount: 0, synced: true },
        }),
      );

      await waitFor(() =>
        expect(screen.getByTestId("markdown-editor").textContent).toContain("parent"),
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(selectionWarning),
      );
    } finally {
      view.unmount();
      awareness?.destroy();
      ydoc.destroy();
      warn.mockRestore();
    }
  });
});

describe("MarkdownEditor selection toolbar", () => {
  it("shows the block and marks of the current selection, not the first one", async () => {
    render(
      createElement(MarkdownEditor, {
        value: "# Big heading\n\nA paragraph with **bold words** in it.",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/toolbar.md",
        knownFiles: [],
      }),
    );
    const editor = editorBehind(await screen.findByTestId("markdown-editor"));
    await flushAnimationFrames();

    act(() => {
      editor.commands.setTextSelection({ from: 2, to: 5 });
    });
    // The bubble menu attaches once its debounced update sees the selection.
    const menu = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".dohc-bubble-menu");
      expect(element).not.toBeNull();
      return element!;
    });
    const bold = within(menu).getByRole("button", { name: "Bold" });
    expect(within(menu).getByTitle("Turn into").textContent).toContain("Heading 1");
    expect(bold.className).not.toContain("is-active");

    let boldFrom = -1;
    editor.state.doc.descendants((node, pos) => {
      if (boldFrom === -1 && node.isText && node.text === "bold words") boldFrom = pos;
    });
    act(() => {
      editor.commands.setTextSelection({ from: boldFrom, to: boldFrom + 4 });
    });

    expect(within(menu).getByTitle("Turn into").textContent).toContain("Text");
    expect(bold.className).toContain("is-active");
  });
});

describe("MarkdownEditor slash command: math", () => {
  function makeEditor(markdown: string): Editor {
    return new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        ...desktopMarkdownExtensions,
        TaskList,
        DohcTaskItem,
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
      ],
      content: markdown,
      contentType: "markdown",
    });
  }

  it("inserts an empty $$ math block ready for editing", () => {
    const editor = makeEditor("/math");
    const setSlashState = vi.fn();
    // "/math" is 5 chars starting at doc pos 1 (inside the paragraph).
    const state: SlashCommandState = {
      open: true,
      from: 1,
      to: 6,
      query: "math",
      selected: 0,
      x: 0,
      y: 0,
      maxHeight: 0,
      bottom: null,
      placement: "below",
    };

    runSlashCommand(editor, "math", state, setSlashState);

    expect(setSlashState).toHaveBeenCalledWith(CLOSED_SLASH_COMMAND_STATE);
    let mathBlock: { attrs: { tex: unknown } } | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mathBlock") {
        mathBlock = node as unknown as { attrs: { tex: unknown } };
      }
    });
    expect(mathBlock).not.toBeNull();
    expect(mathBlock!.attrs.tex).toBe("");
    // The block is selected (NodeSelection) so its NodeView opens edit-ready.
    const selectedNode = (
      editor.state.selection as unknown as { node?: { type: { name: string } } }
    ).node;
    expect(selectedNode?.type.name).toBe("mathBlock");
    editor.destroy();
  });
});

describe("MarkdownEditor code block continuation", () => {
  function makeEditor(markdown: string, editable = true): Editor {
    return new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        ...desktopMarkdownExtensions,
        TaskList,
        DohcTaskItem,
        Markdown.configure({ indentation: { style: "space", size: 2 } }),
      ],
      content: markdown,
      contentType: "markdown",
      editable,
    });
  }

  function pressAtEndOfCode(
    editor: Editor,
    init: KeyboardEventInit,
  ): boolean {
    const plugin = makeCodeBlockContinuationPlugin();
    // End of the "code" text inside the leading code block: pos 1 + 4.
    editor.commands.setTextSelection(5);
    const handled = plugin.props.handleKeyDown?.call(
      plugin,
      editor.view,
      new KeyboardEvent("keydown", init),
    );
    return handled === true;
  }

  it("ArrowDown at end of a code block with content after falls through to native navigation", () => {
    const editor = makeEditor("```\ncode\n```\n\nSome text");
    const before = editor.getJSON();

    expect(pressAtEndOfCode(editor, { key: "ArrowDown" })).toBe(false);
    // The doc must not be mutated by a pure navigation keypress.
    expect(editor.getJSON()).toEqual(before);
    editor.destroy();
  });

  it("ArrowDown at end of a terminal code block exits into a new paragraph", () => {
    const editor = makeEditor("```\ncode\n```");
    expect(editor.state.doc.childCount).toBe(1);

    expect(pressAtEndOfCode(editor, { key: "ArrowDown" })).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).content.size).toBe(0);
    editor.destroy();
  });

});

// The live editor registers its own extension list, and the collaboration
// binding converts the Y.Doc through that schema. A `paragraph+` task item
// makes the indented list schema-invalid, so binding drops the whole task list
// and the document opens empty.
describe.each(["local", "collaboration"])("MarkdownEditor nested list interactions (%s)", (mode) => {
  let ydoc: Y.Doc | undefined;
  afterEach(() => { cleanup(); ydoc?.destroy(); ydoc = undefined; });

  async function mount(markdown: string) {
    ydoc = mode === "collaboration" ? markdownToYDoc(markdown) : undefined;
    render(createElement(MarkdownEditor, {
      value: markdown, onDirty: vi.fn(), workspaceId: "workspace-1",
      path: "nested.md", knownFiles: [],
      collab: ydoc ? { ydoc, status: "connected", peerCount: 0, synced: true } : undefined,
    }));
    const surface = await screen.findByTestId("markdown-editor");
    const editor = editorBehind(surface);
    return { surface, editor };
  }

  function caret(editor: Editor, text: string, offset = 0) {
    let position = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent === text) position = pos + 1 + offset;
    });
    expect(position).toBeGreaterThan(0);
    act(() => { editor.commands.setTextSelection(position); editor.view.focus(); });
  }

  function reversible(surface: HTMLElement, editor: Editor, action: () => void, check: () => void) {
    // Isolate the action from fixture edits in either history implementation.
    fireEvent.focus(surface);
    editor.view.dispatch(closeHistory(editor.state.tr));
    const before = editor.getJSON();
    act(action);
    check();
    const after = editor.getJSON();
    expect(after).not.toEqual(before);
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true });
    expect(editor.getJSON()).toEqual(before);
    fireEvent.keyDown(surface, { key: "y", ctrlKey: true });
    expect(editor.getJSON()).toEqual(after);
  }

  it.each(["task"])("indents and outdents %s items with Tab and Shift-Tab", async (kind) => {
    const marker = kind === "task" ? "- [ ]" : kind === "ordered" ? "1." : "-";
    const { surface, editor } = await mount(`${marker} parent\n${marker} child`);
    caret(editor, "child");
    reversible(surface, editor, () => { fireEvent.keyDown(surface, { key: "Tab" }); }, () => {
      expect(surface.querySelector("li li")?.textContent).toContain("child");
    });
    caret(editor, "child");
    reversible(surface, editor, () => { fireEvent.keyDown(surface, { key: "Tab", shiftKey: true }); }, () => {
      expect(surface.querySelector("li li")).toBeNull();
    });
  });

  it("toggles a child checkbox without changing its parent", async () => {
    const { surface, editor } = await mount("- [ ] parent\n  - [ ] child");
    reversible(surface, editor, () => { fireEvent.click(surface.querySelectorAll("input[type=checkbox]")[1]!); }, () => {
      expect(surface.querySelector("li li")?.getAttribute("data-checked")).toBe("true");
      expect(surface.querySelector("li")?.getAttribute("data-checked")).toBe("false");
    });
  });

  it.each([
    ["bullet", "task-list"],
    ["ordered", "bulleted-list"],
    ["task", "numbered-list"],
  ] as const)("turns a %s child into %s and keeps its descendants", async (from, kind) => {
    const child = from === "task" ? "- [x] child" : from === "ordered" ? "1. child" : "- child";
    const { surface, editor } = await mount(`- parent\n  ${child}\n${" ".repeat(from === "ordered" ? 5 : 4)}- grandchild`);
    caret(editor, "child", 2);
    reversible(surface, editor, () => {
      runSlashCommand(editor, kind, {
        open: true, query: "", selected: 0, x: 0, y: 0,
        bottom: null, maxHeight: 300, placement: "below",
        from: editor.state.selection.from, to: editor.state.selection.from,
      }, vi.fn());
    }, () => {
      const node = surface.querySelector("li > " + (kind === "numbered-list" ? "ol" : kind === "task-list" ? 'ul[data-type="taskList"]' : 'ul'));
      expect(node?.textContent).toContain("child");
      expect(node?.querySelector("li li")?.textContent).toContain("grandchild");
      expect(editor.state.selection.$from.parent.textContent).toBe("child");
      expect(editor.state.selection.$from.parentOffset).toBe(2);
      expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    });
  });

  it.each(["markdown", "html"])("pastes a nested list from %s", async (format) => {
    const { surface, editor } = await mount("");
    act(() => { editor.view.focus(); });
    reversible(surface, editor, () => {
      const markdown = "- parent\n  - child\n    - grandchild";
      fireEvent.paste(surface, { clipboardData: {
        files: [], types: [format === "html" ? "text/html" : "text/plain"],
        getData: (type: string) => type === "text/html" && format === "html"
          ? "<ul><li><p>parent</p><ul><li><p>child</p><ul><li><p>grandchild</p></li></ul></li></ul></li></ul>"
          : type === "text/plain" ? markdown : "",
      } });
    }, () => {
      expect(surface.querySelector("li li li")?.textContent).toBe("grandchild");
    });
  });
});

// The block gutter selects a whole table, which Backspace and Delete then
// remove. Without the editor's table node selection, Tiptap turns the gutter's
// selection into a selection of the table's cells.
describe("MarkdownEditor table gutter", () => {
  it.each(["Backspace"])("selects a whole table from its gutter and deletes it with %s", async (key) => {
    render(
      createElement(MarkdownEditor, {
        value: "Before\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/table.md",
        knownFiles: [],
      }),
    );
    const surface = await screen.findByTestId("markdown-editor");
    const editor = editorBehind(surface);
    const handle = surface.querySelectorAll<HTMLElement>(".dohc-block-handle")[1];
    expect(handle).toBeDefined();

    fireEvent.click(handle!);
    const { selection } = editor.state;
    expect(selection).toBeInstanceOf(NodeSelection);
    expect((selection as NodeSelection).node.type.name).toBe("table");

    fireEvent.keyDown(surface, { key });
    const blocks: string[] = [];
    editor.state.doc.forEach((block) => blocks.push(block.type.name));
    expect(blocks).toEqual(["paragraph", "paragraph"]);
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
  });
});

describe("MarkdownEditor history", () => {

  it("shares one ordered undo history across duplicate collaboration views", async () => {
    const ydoc = markdownToYDoc("seed");
    const user = userEvent.setup();
    const collab = {
      ydoc,
      status: "connected" as const,
      peerCount: 0,
      synced: true,
    };
    const editorProps = {
      value: "seed",
      onDirty: vi.fn(),
      workspaceId: "workspace-1",
      path: "notes/duplicate.md",
      knownFiles: [],
      collab,
    };
    const paneARef = createRef<MarkdownEditorHandle>();
    const paneBRef = createRef<MarkdownEditorHandle>();
    const paneAElement = () =>
      createElement(MarkdownEditor, {
        ...editorProps,
        key: "pane-a",
        ref: paneARef,
      });
    const paneBElement = () =>
      createElement(MarkdownEditor, {
        ...editorProps,
        key: "pane-b",
        ref: paneBRef,
      });
    const view = render(createElement("div", null, paneAElement()));

    try {
      const paneA = await screen.findByTestId("markdown-editor");
      expect(paneA).toBeTruthy();
      await waitFor(() => {
        expect(paneA!.textContent).toBe("seed");
      });

      await waitFor(() => {
        paneARef.current?.focus("end");
        expect(document.activeElement).toBe(paneA);
      });
      await user.keyboard("A");
      await waitFor(() => {
        expect(paneA!.textContent).toBe("seedA");
      });

      view.rerender(
        createElement("div", null, paneAElement(), paneBElement()),
      );
      await waitFor(() => {
        expect(screen.getAllByTestId("markdown-editor")).toHaveLength(2);
      });
      const [, paneB] = screen.getAllByTestId("markdown-editor");
      expect(paneB).toBeTruthy();
      await waitFor(() => {
        expect(paneB!.textContent).toBe("seedA");
      });

      await waitFor(() => {
        paneBRef.current?.focus("end");
        expect(document.activeElement).toBe(paneB);
      });
      await user.keyboard("B");
      await waitFor(() => {
        expect(paneA!.textContent).toBe("seedAB");
        expect(paneB!.textContent).toBe("seedAB");
      });

      fireEvent.keyDown(paneA!, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await waitFor(() => {
        expect(paneA!.textContent).toBe("seedA");
        expect(paneB!.textContent).toBe("seedA");
      });

      fireEvent.keyDown(paneB!, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await waitFor(() => {
        expect(paneA!.textContent).toBe("seed");
        expect(paneB!.textContent).toBe("seed");
      });

      fireEvent.keyDown(paneA!, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(paneA!.textContent).toBe("seed");
      expect(paneB!.textContent).toBe("seed");

      view.rerender(createElement("div", null, paneBElement()));
      await waitFor(() => {
        expect(screen.getAllByTestId("markdown-editor")).toHaveLength(1);
      });
      await waitFor(() => {
        paneBRef.current?.focus("end");
        expect(document.activeElement).toBe(paneB);
      });
      await user.keyboard("C");
      await waitFor(() => {
        expect(paneB!.textContent).toBe("seedC");
      });
      fireEvent.keyDown(paneB!, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await waitFor(() => {
        expect(paneB!.textContent).toBe("seed");
      });
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

});

describe("MarkdownEditor remote carets", () => {

  it("renders a remote peer's caret once their synced cursor lands in awareness", async () => {
    // Two mirror Y.Docs bridged both ways, the same shape as
    // engineYDocProvider's main<->renderer echo-guarded relay: every local
    // update on one side is applied to the other under a distinct origin so
    // it never echoes back.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    docA.clientID = 111;
    docB.clientID = 222;
    const bridge = (from: Y.Doc, to: Y.Doc): void => {
      from.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin === "bridge") return;
        Y.applyUpdate(to, update, "bridge");
      });
    };
    bridge(docA, docB);
    bridge(docB, docA);

    const awarenessA = new Awareness(docA);
    const awarenessB = new Awareness(docB);

    const user = userEvent.setup();
    const viewA = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/collab-caret.md",
        knownFiles: [],
        collab: {
          ydoc: docA,
          status: "connected",
          peerCount: 1,
          synced: true,
          awareness: awarenessA,
        },
      }),
    );
    const viewB = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/collab-caret.md",
        knownFiles: [],
        collab: {
          ydoc: docB,
          status: "connected",
          peerCount: 1,
          synced: true,
          awareness: awarenessB,
        },
      }),
    );

    try {
      const editorA = await within(viewA.container).findByTestId("markdown-editor");
      const editorB = await within(viewB.container).findByTestId("markdown-editor");

      // B types, syncing content into A over the bridge (and, in the same
      // pass, publishing B's own cursor position into awarenessB — the
      // yCursorPlugin view listener that CollaborationCaret wires up).
      editorB.focus();
      await user.keyboard("hi from b");
      await waitFor(() => expect(editorA.textContent).toBe("hi from b"));
      await waitFor(() => expect(awarenessB.getLocalState()?.cursor).toBeDefined());

      // A never sees B directly (no live presence transport in this test) —
      // simulate the ephemeral relay hop docPresence.ts does: apply B's
      // encoded awareness state into A's awareness under B's real clientID.
      applyAwarenessUpdate(
        awarenessA,
        encodeAwarenessUpdate(awarenessB, [awarenessB.clientID]),
        "test-relay",
      );

      await waitFor(() => {
        const caret = viewA.container.querySelector(".collaboration-carets__caret");
        expect(caret).not.toBeNull();
      });
      const label = viewA.container.querySelector(".collaboration-carets__label");
      expect(label?.textContent).toMatch(/^Editor \d+$/);
    } finally {
      viewA.unmount();
      viewB.unmount();
      awarenessA.destroy();
      awarenessB.destroy();
      docA.destroy();
      docB.destroy();
    }
  });
});

// The live editor's getMarkdown() is what FileInspector.tsx's WYSIWYG save
// and engine-draft export, and blockControls.tsx's "copy block as markdown"
// all read from (they all serialize through the projection's
// serializeRichdocBody). A three-backtick fence around content that holds a
// ``` line would close early and truncate on re-import, so the serializer
// widens the fence.
describe("MarkdownEditor markdown export: code fence widening", () => {
  it("reports Replace all while the find input owns focus", async () => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const user = userEvent.setup();
    const onDirty = vi.fn();
    render(
      createElement(MarkdownEditor, {
        value: "alpha alpha",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    await flushAnimationFrames();
    editor.focus();
    await user.keyboard("{Control>}h{/Control}");
    const find = await screen.findByPlaceholderText("Find");
    const replacement = screen.getByPlaceholderText("Replace");
    await user.type(find, "alpha");
    await user.type(replacement, "beta");
    onDirty.mockClear();

    await user.click(screen.getByRole("button", { name: "Replace all" }));

    expect(editor.textContent).toContain("beta beta");
    expect(document.activeElement).not.toBe(editor);
    expect(
      onDirty.mock.calls.some(([materialize]) =>
        (materialize as () => string)().includes("beta beta"),
      ),
    ).toBe(true);
  });

  it("replaces local Markdown without remounting or reporting a user edit", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    render(
      createElement(MarkdownEditor, {
        ref,
        value: "# Before\n",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    act(() => ref.current?.focus("start"));
    await waitFor(() => expect(document.activeElement).toBe(editor));
    const offsetBefore = selectionTextOffset(editor);
    expect(offsetBefore).not.toBeNull();

    act(() => ref.current?.replaceMarkdown("# After\n\nPeer edit"));

    expect(screen.getByTestId("markdown-editor")).toBe(editor);
    expect(document.activeElement).toBe(editor);
    expect(selectionTextOffset(editor)).toBe(offsetBefore);
    expect(editor.textContent).toContain("After");
    expect(editor.textContent).toContain("Peer edit");
    expect(onDirty).not.toHaveBeenCalled();

    fireEvent.keyDown(editor, { key: "z", ctrlKey: true });
    await act(async () => Promise.resolve());
    expect(editor.textContent).toContain("After");
    expect(editor.textContent).not.toContain("Before");
    expect(onDirty).not.toHaveBeenCalled();
  });

  it("refreshes the outline after a local Markdown replacement suppresses update", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    render(
      createElement(MarkdownEditor, {
        ref,
        value: "# Before\n\n## Old section\n",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    await screen.findByRole("button", { name: "Old section" });

    act(() =>
      ref.current?.replaceMarkdown("# After\n\n## New section\n\n### Details"),
    );

    await screen.findByRole("button", { name: "New section" });
    expect(screen.getByRole("button", { name: "Details" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Old section" })).toBeNull();
    expect(onDirty).not.toHaveBeenCalled();
  });

  it("keeps a cursor in an unchanged island after a large peer rewrite", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    const stable = " stable ";
    render(
      createElement(MarkdownEditor, {
        ref,
        value: `${"a".repeat(96)}${stable}${"b".repeat(96)}`,
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    const text = editor.querySelector("p")?.firstChild;
    if (!(text instanceof Text)) throw new Error("expected paragraph text");
    editor.focus();
    const range = document.createRange();
    range.setStart(text, 99);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(selectionTextOffset(editor)).toBe(99));

    act(() =>
      ref.current?.replaceMarkdown(
        `${"x".repeat(100)}${stable}${"y".repeat(100)}`,
      ),
    );

    expect(selectionTextOffset(editor)).toBe(103);
    expect(onDirty).not.toHaveBeenCalled();
  });

});

describe("MarkdownEditor read-only links", () => {
  it("keeps workspace links focusable and opens them without enabling edits or default navigation", async () => {
    const user = userEvent.setup();
    const onDirty = vi.fn();
    const onOpenWorkspaceLink = vi.fn();
    const view = render(
      createElement(MarkdownEditor, {
        value: "[Launch plan](../plans/launch.md#a%2520b) [Top](#)",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/status.md",
        knownFiles: [],
        onOpenWorkspaceLink,
        readOnly: true,
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      expect(editor.getAttribute("contenteditable")).toBe("false");
      const anchor = editor.querySelector("a[href]") as HTMLAnchorElement | null;
      expect(anchor).not.toBeNull();
      if (!anchor) throw new Error("expected rendered Markdown link");

      anchor.focus();
      expect(document.activeElement).toBe(anchor);

      let clickDefaultPrevented = false;
      const observeClick = (event: MouseEvent) => {
        clickDefaultPrevented = event.defaultPrevented;
      };
      window.addEventListener("click", observeClick);
      await user.click(anchor);
      window.removeEventListener("click", observeClick);
      expect(clickDefaultPrevented).toBe(true);
      expect(onOpenWorkspaceLink).toHaveBeenCalledWith({
        path: "../plans/launch.md",
        rawFragment: "a%2520b",
      });

      onOpenWorkspaceLink.mockClear();
      const middleClick = new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      });
      expect(anchor.dispatchEvent(middleClick)).toBe(false);
      expect(middleClick.defaultPrevented).toBe(true);
      expect(onOpenWorkspaceLink).toHaveBeenCalledWith({
        path: "../plans/launch.md",
        rawFragment: "a%2520b",
      });
      expect(onOpenWorkspaceLink).toHaveBeenCalledOnce();

      onOpenWorkspaceLink.mockClear();
      await user.dblClick(anchor);
      expect(onOpenWorkspaceLink).toHaveBeenCalledOnce();

      onOpenWorkspaceLink.mockClear();
      await user.tripleClick(anchor);
      expect(onOpenWorkspaceLink).toHaveBeenCalledOnce();

      onOpenWorkspaceLink.mockClear();
      const enter = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      expect(anchor.dispatchEvent(enter)).toBe(false);
      expect(enter.defaultPrevented).toBe(true);
      const repeatedEnter = new KeyboardEvent("keydown", {
        key: "Enter",
        repeat: true,
        bubbles: true,
        cancelable: true,
      });
      expect(anchor.dispatchEvent(repeatedEnter)).toBe(false);
      expect(repeatedEnter.defaultPrevented).toBe(true);
      expect(onOpenWorkspaceLink).toHaveBeenCalledWith({
        path: "../plans/launch.md",
        rawFragment: "a%2520b",
      });
      expect(onOpenWorkspaceLink).toHaveBeenCalledOnce();

      onOpenWorkspaceLink.mockClear();
      const topAnchor = [...editor.querySelectorAll("a[href]")].find(
        (candidate) => candidate.textContent === "Top",
      );
      expect(topAnchor).toBeDefined();
      if (!topAnchor) throw new Error("expected empty-fragment Markdown link");
      await user.click(topAnchor);
      expect(onOpenWorkspaceLink).toHaveBeenCalledWith({
        path: "",
        rawFragment: "",
      });
      expect(onOpenWorkspaceLink).toHaveBeenCalledOnce();
      expect(onDirty).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });
});

// A tiptap editor reports the user's edits through `onUpdate`. This component
// used to ignore every one of them until an animation frame set a
// `dirtyTrackingReady` ref, which made "did the app hear the edit?" a question
// about timing: an edit that arrived before the frame was applied to
// ProseMirror's document and never reported, so the editor showed the text
// while the app said "Saved" and scheduled no save at all.
//
// Holding the frame open is what makes that window permanent instead of a
// 16ms race. These tests fail deterministically if the gate returns, and they
// are the reason it cannot: nothing about a frame decides whether a keystroke
// counts.
describe("MarkdownEditor dirty tracking", () => {
  function holdAnimationFrames(): void {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  }

  const BODY = "# Plan\n\nBase paragraph.\n";

  function editorProps(onDirty: () => void) {
    return {
      value: BODY,
      onDirty,
      workspaceId: "workspace-1",
      path: "notes/plan.md",
      knownFiles: [],
    };
  }

  // The rebuild case, and the more dangerous one: the user is already in the
  // document when the engine session ends and the view falls back to the local
  // editor. `collab` drops, the extensions change, and tiptap builds a new
  // editor underneath a user who never stopped typing.
  it("reports an edit that lands after the editor is rebuilt mid-session", async () => {
    holdAnimationFrames();
    const onDirty = vi.fn();
    const user = userEvent.setup();
    const ydoc = markdownToYDoc(BODY);
    const view = render(
      createElement(MarkdownEditor, {
        ...editorProps(onDirty),
        collab: { ydoc, status: "connected" as const, peerCount: 0, synced: true },
      }),
    );

    try {
      await screen.findByTestId("markdown-editor");
      view.rerender(
        createElement(MarkdownEditor, { ...editorProps(onDirty), collab: null }),
      );

      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() =>
        expect(editor.textContent).toContain("Base paragraph."),
      );
      await user.click(editor);
      await user.type(editor, "Z");

      await waitFor(() => expect(onDirty).toHaveBeenCalled());
      expect(editor.textContent).toContain("Z");
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });
});

describe("MarkdownEditor focus", () => {
  function mount(value: string) {
    const ref = createRef<MarkdownEditorHandle>();
    const view = render(
      createElement(MarkdownEditor, {
        ref,
        value,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/new.md",
        knownFiles: [],
      }),
    );
    return { ref, view };
  }

  // jsdom's focus() collapses the document selection to (editor, 0) after the
  // focus event. When Tab focuses this editor in Chromium, the Selection API
  // usually reports no range, so this clears the selection and dispatches the
  // focus event again.
  function focusByKeyboard(editor: HTMLElement) {
    editor.focus();
    document.getSelection()?.removeAllRanges();
    fireEvent.focus(editor);
  }

  it("reads a caret the browser moved before Enter runs", async () => {
    const { view } = mount("# Heading\n\nBody text");
    try {
      const editor = await screen.findByTestId("markdown-editor");
      focusByKeyboard(editor);
      const text = editor.querySelector("p")?.firstChild;
      if (!(text instanceof Text)) throw new Error("expected paragraph text");
      // A click moved the caret, and selectionchange has not arrived yet.
      document.getSelection()?.collapse(text, text.length);

      fireEvent.keyDown(editor, { key: "Enter", keyCode: 13 });

      expect(editor.querySelector("h1")?.textContent).toBe("Heading");
      expect(Array.from(editor.querySelectorAll("p"), (p) => p.textContent)).toEqual([
        "Body text",
        "",
      ]);
    } finally {
      view.unmount();
    }
  });

});

it("hands Edit > Find to the editor that has focus, including its find bar", async () => {
  vi.stubGlobal("dohcDesktop", { platform: "darwin" });
  // The find bar scrolls its active match into view.
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  const left = createRef<MarkdownEditorHandle>();
  const right = createRef<MarkdownEditorHandle>();
  const props = { value: "the cat, the mat, the hat", onDirty: vi.fn(), workspaceId: "ws", knownFiles: [] };
  render(createElement("div", null,
    createElement(MarkdownEditor, { ...props, key: "left", ref: left, path: "left.md" }),
    createElement(MarkdownEditor, { ...props, key: "right", ref: right, path: "right.md" })));
  const [leftSurface, rightSurface] = await waitFor(() => {
    const surfaces = screen.getAllByTestId("markdown-editor");
    expect(surfaces).toHaveLength(2);
    return surfaces;
  });
  const find = (surface: HTMLElement) => findReplaceKey.getState(editorBehind(surface!).state);

  // With focus outside every editor, the command does nothing.
  act(() => sendToFocusedEditor("editor-find"));
  expect(screen.queryByRole("search", { name: "find and replace" })).toBeNull();

  act(() => right.current?.focus("start"));
  await waitFor(() => expect(document.activeElement).toBe(rightSurface));
  act(() => sendToFocusedEditor("editor-find"));
  const input = await screen.findByPlaceholderText("Find");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(find(rightSurface!)?.open).toBe(true);
  expect(find(leftSurface!)?.open).toBe(false);

  // From the find bar, as with ⌘G there.
  fireEvent.change(input, { target: { value: "the" } });
  act(() => sendToFocusedEditor("find-again-next"));
  expect(find(rightSurface!)?.activeIndex).toBe(1);
  act(() => sendToFocusedEditor("find-again-previous"));
  act(() => sendToFocusedEditor("find-again-previous"));
  expect(find(rightSurface!)?.activeIndex).toBe(2);
  act(() => sendToFocusedEditor("editor-replace"));
  expect(find(rightSurface!)?.replaceOpen).toBe(true);
  expect(find(leftSurface!)?.open).toBe(false);
});
