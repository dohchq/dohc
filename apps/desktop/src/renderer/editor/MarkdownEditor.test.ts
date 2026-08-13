// @vitest-environment jsdom
import { createElement, createRef, type SetStateAction } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension, getSchema, type JSONContent } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
// Bare TaskItem is imported here ONLY as the contrast case for the schema-
// fidelity pin below (#711) — every registered test-local editor schema in
// this file uses DohcTaskItem.
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import { DohcTaskItem, dohcMarkdownExtensions } from "./extensions";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "./import-export";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import {
  findEmptyListItemParagraph,
  makeCodeBlockChromePlugin,
  makeCodeBlockContinuationPlugin,
} from "./codeBlockChrome";
import {
  CLOSED_SLASH_COMMAND_STATE,
  filterSlashCommands,
  findSlashCommandMatch,
  makeSlashCommandPlugin,
  runSlashCommand,
  slashCommandStatesEqual,
  type SlashCommandState,
} from "./slashCommands";

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
  vi.unstubAllGlobals();
});

// prosemirror-state's TextSelection construction warning is a module-level,
// once-per-process latch (`warnedAboutTextSelection` in prosemirror-state's
// checkTextSelection) — it logs at most once for the life of this test
// process. These pins are only honest while this describe block is the
// FIRST one in this file to construct a collab editor: if some earlier suite
// already tripped the latch, `console.warn` assertions below would pass
// vacuously (the warning simply never fires again) whether or not the fix
// still works. Keep this describe first in the file.
describe("MarkdownEditor collaboration selection", () => {
  it("binds a leading task list without constructing an invalid text selection", async () => {
    const selectionWarning =
      /TextSelection endpoint not pointing into a node with inline content/;
    const warn = vi.spyOn(console, "warn");
    const markdown = "- [ ] parent";
    const ydoc = markdownToYDoc(markdown);
    const view = render(
      createElement(MarkdownEditor, {
        value: markdown,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/checklist.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(editor.textContent).toContain("parent"));
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(selectionWarning),
      );
    } finally {
      view.unmount();
      ydoc.destroy();
      warn.mockRestore();
    }
  });

  // The selection-seed helper (getDohcYDocSelectionSeed) reduces the Y.Doc's
  // body to its first-node path — but an empty or frontmatter-only body has
  // NO first node (yDocBodyToJSON returns `{ type: 'doc' }`, content
  // undefined). An unguarded seed there hands tiptap a schema-invalid `doc`
  // node with zero children: schema.nodeFromJSON builds it without
  // validating (tiptap only validates when enableContentCheck is set), so
  // the editor mounts with no paragraph at all — no placeholder, empty DOM —
  // and still logs the #705 warning, since nothing in that document resolves
  // to inline content either. Both shapes are first-class in product: a
  // brand-new note (empty body) and a properties-only page (frontmatter,
  // no body) both bind through this exact path.
  it("binds an empty Y.Doc body without losing the placeholder paragraph or warning", async () => {
    const selectionWarning =
      /TextSelection endpoint not pointing into a node with inline content/;
    const warn = vi.spyOn(console, "warn");
    const markdown = "";
    const ydoc = markdownToYDoc(markdown);
    const view = render(
      createElement(MarkdownEditor, {
        value: markdown,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/empty.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(editor.querySelector("p")).not.toBeNull());
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(selectionWarning),
      );
    } finally {
      view.unmount();
      ydoc.destroy();
      warn.mockRestore();
    }
  });

  it("binds a frontmatter-only Y.Doc body without losing the placeholder paragraph or warning", async () => {
    const selectionWarning =
      /TextSelection endpoint not pointing into a node with inline content/;
    const warn = vi.spyOn(console, "warn");
    const markdown = "---\ntitle: Plan\n---\n";
    const ydoc = markdownToYDoc(markdown);
    const view = render(
      createElement(MarkdownEditor, {
        value: markdown,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/properties-only.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(editor.querySelector("p")).not.toBeNull());
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(selectionWarning),
      );
    } finally {
      view.unmount();
      ydoc.destroy();
      warn.mockRestore();
    }
  });

  // A raw `new Y.Doc()` — no frontmatter, no meta, no body fragment content
  // at all — is the exact shape "undoes and redoes a local edit in
  // collaboration mode" below binds before typing into it. It hits the same
  // empty-body path as the two pins above; called out on its own because an
  // unguarded seed logs the RELATED `(doc)` warning variant here specifically
  // (confirmed 0/5 clean on the unguarded seed, 5/5 clean once guarded).
  it("binds a bare new Y.Doc() without losing the placeholder paragraph or warning", async () => {
    const selectionWarning =
      /TextSelection endpoint not pointing into a node with inline content/;
    const warn = vi.spyOn(console, "warn");
    const ydoc = new Y.Doc();
    const view = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/bare.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(editor.querySelector("p")).not.toBeNull());
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringMatching(selectionWarning),
      );
    } finally {
      view.unmount();
      ydoc.destroy();
      warn.mockRestore();
    }
  });

  // The selection seed must be recomputed on every editor REBUILD, not just
  // when collab.ydoc's own identity changes. useEditor rebuilds (destroys
  // and reconstructs the tiptap Editor) whenever `extensions` changes
  // identity — which happens when awareness is added, removed, or swapped,
  // since CollaborationCaret is only registered when awareness is present.
  // A seed memoized on [collab?.ydoc] alone would survive that rebuild
  // holding the doc's shape from MOUNT time — reseeding the fresh editor
  // with a stale (here: paragraph-first) path even though the doc's real
  // leading node is now a taskList, recreating #705's invalid selection.
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

      // Rewrite the SAME Y.Doc's body to a taskList-first shape — an
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

// #711: the bare-TaskItem swap isn't registration-only — a bare TaskItem's
// `paragraph+` content model rejects the nested list a real task item can
// hold. Driven through the REAL Y.Doc round trip (the same
// prosemirrorJSONToYXmlFragment / yXmlFragmentToProseMirrorRootNode pair
// production uses), a document that nests a list under a task item survives
// with DohcTaskItem and is dropped ENTIRELY (the whole doc reduces to
// `{ type: "doc" }`, content undefined) with bare TaskItem — the earlier
// fakes weren't just modeling a narrower schema, they'd have silently eaten
// this exact document if a test had ever driven one through them.
describe("MarkdownEditor task-item schema fidelity", () => {
  const NESTED_TASK_LIST: JSONContent = {
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
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "child one" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  function roundTrip(taskItemExtension: typeof TaskItem | typeof DohcTaskItem): JSONContent {
    const schema = getSchema([
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      TaskList,
      taskItemExtension,
    ]);
    const ydoc = new Y.Doc();
    prosemirrorJSONToYXmlFragment(schema, NESTED_TASK_LIST, ydoc.getXmlFragment("body"));
    const json = yXmlFragmentToProseMirrorRootNode(
      ydoc.getXmlFragment("body"),
      schema,
    ).toJSON() as JSONContent;
    ydoc.destroy();
    return json;
  }

  it("drops a nested list under a task item with the bare TaskItem schema", () => {
    expect(roundTrip(TaskItem)).toEqual({ type: "doc" });
  });

  it("preserves a nested list under a task item with the real DohcTaskItem schema", () => {
    const json = roundTrip(DohcTaskItem);
    expect(json.content?.[0]?.type).toBe("taskList");
    const taskItem = json.content?.[0]?.content?.[0];
    expect(taskItem?.type).toBe("taskItem");
    expect(taskItem?.content?.map((n) => n.type)).toEqual([
      "paragraph",
      "bulletList",
    ]);
  });
});

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

  it("does not republish identical menu state on unrelated editor updates", () => {
    let current: SlashCommandState = CLOSED_SLASH_COMMAND_STATE;
    const stateRef = { current };
    const setState = vi.fn((update: SetStateAction<SlashCommandState>) => {
      current = typeof update === "function" ? update(current) : update;
      stateRef.current = current;
    });
    const runCommandRef = { current: vi.fn() };
    const slashExtension = Extension.create({
      name: "testSlashCommands",
      addProseMirrorPlugins() {
        return [makeSlashCommandPlugin({ stateRef, setState, runCommandRef })];
      },
    });
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit.configure({ trailingNode: false }), slashExtension],
      content: "",
    });

    editor.commands.insertContent("/");
    expect(setState).toHaveBeenCalledTimes(1);
    expect(current.open && current.query).toBe("");

    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(current.open && current.selected).toBe(2);
    expect(setState).toHaveBeenCalledTimes(3);

    editor.view.dispatch(editor.state.tr.setMeta("unrelated", true));
    expect(setState).toHaveBeenCalledTimes(3);

    editor.commands.insertContent("h");
    expect(setState).toHaveBeenCalledTimes(4);
    expect(current.open && current.query).toBe("h");
    editor.destroy();
  });

  it("compares every field that can visibly move or select the menu", () => {
    const state = {
      open: true,
      from: 1,
      to: 2,
      query: "h",
      selected: 0,
      x: 10,
      y: 20,
      bottom: null,
      maxHeight: 300,
      placement: "below",
    } satisfies SlashCommandState;
    expect(slashCommandStatesEqual(state, { ...state })).toBe(true);
    expect(slashCommandStatesEqual(state, { ...state, selected: 1 })).toBe(false);
    expect(slashCommandStatesEqual(state, { ...state, y: 21 })).toBe(false);
    expect(slashCommandStatesEqual(state, CLOSED_SLASH_COMMAND_STATE)).toBe(false);
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
        DohcTaskItem,
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
      bottom: null,
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
      bottom: null,
      placement: "below",
    };

    expect(() =>
      runSlashCommand(editor, "image", state, setSlashState),
    ).not.toThrow();
    expect(editor.getText()).toBe("");
    editor.destroy();
  });
});

describe("MarkdownEditor slash command: math", () => {
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
        ...dohcMarkdownExtensions,
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

  it("keeps code-block exit in the normal editor flow without a permanent plus button", () => {
    const chromeExtension = Extension.create({
      name: "testCodeBlockChrome",
      addProseMirrorPlugins() {
        return [makeCodeBlockChromePlugin()];
      },
    });
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit.configure({ trailingNode: false }), chromeExtension],
      content: '<pre><code class="language-js">code</code></pre>',
    });

    expect(editor.view.dom.querySelector(".dohc-code-block-toolbar")).not.toBeNull();
    expect(editor.view.dom.querySelector(".dohc-code-block-continuation")).toBeNull();
    expect(editor.view.dom.querySelector(".dohc-code-block-continue-btn")).toBeNull();
    editor.destroy();
  });

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

  it("Cmd/Ctrl+Enter always inserts a paragraph below, even with content after", () => {
    const editor = makeEditor("```\ncode\n```\n\nSome text");
    expect(editor.state.doc.childCount).toBe(2);

    expect(pressAtEndOfCode(editor, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).content.size).toBe(0);
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

// The live editor registers its own extension list, and the collaboration
// binding converts the Y.Doc through THAT schema. A `paragraph+` task item
// makes the indented list schema-invalid, so binding drops the whole task list
// and the document opens empty (#700).
describe("MarkdownEditor nested checklists", () => {
  it("binds an indented list under a checkbox from the Y.Doc", async () => {
    const markdown = ["- [ ] parent", "  - child one", "  - child two"].join("\n");
    const ydoc = markdownToYDoc(markdown);
    const view = render(
      createElement(MarkdownEditor, {
        value: markdown,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/checklist.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      await waitFor(() => expect(editor.textContent).toContain("parent"));
      expect(editor.querySelector("li[data-checked] ul")).not.toBeNull();
      expect(editor.textContent).toContain("child one");
      expect(editor.textContent).toContain("child two");
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });
});

describe("MarkdownEditor history", () => {
  it("keeps malformed rich markdown from crashing the editor transaction loop", async () => {
    const user = userEvent.setup();
    const markdown = [
      "- item",
      "",
      "> [!note]",
      "",
      "| Hello |     |     |     |     |",
      "| ----- | --- | --- | --- | --- |",
      "|       |     |     |     |     |",
      "",
      "$$1 + 1 = 2$$",
    ].join("\n");
    const parsed = new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({ trailingNode: false }),
        ...dohcMarkdownExtensions,
        TaskList,
        DohcTaskItem,
        TableKit,
        Markdown,
      ],
      content: markdown,
      contentType: "markdown",
    });

    expect(() => parsed.state.doc.check()).not.toThrow();
    parsed.destroy();

    const view = render(
      createElement(MarkdownEditor, {
        value: markdown,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/rich.md",
        knownFiles: [],
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      editor.focus();
      await user.keyboard("stable");
      expect(editor.textContent).toContain("stable");
    } finally {
      view.unmount();
    }
  });

  it("undoes and redoes a local edit in collaboration mode", async () => {
    const ydoc = new Y.Doc();
    const user = userEvent.setup();
    const view = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/collaborative.md",
        knownFiles: [],
        collab: {
          ydoc,
          status: "connected",
          peerCount: 0,
          synced: true,
        },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");

      editor.focus();
      await user.keyboard("collaborative edit");
      expect(editor.textContent).toBe("collaborative edit");

      fireEvent.keyDown(editor, {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
      });
      await waitFor(() => expect(editor.textContent).toBe(""));

      fireEvent.keyDown(editor, {
        key: "y",
        code: "KeyY",
        ctrlKey: true,
      });
      await waitFor(() => expect(editor.textContent).toBe("collaborative edit"));
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

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

  it("keeps local StarterKit undo working outside collaboration mode", async () => {
    const user = userEvent.setup();
    render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/local.md",
        knownFiles: [],
      }),
    );

    const editor = await screen.findByTestId("markdown-editor");
    editor.focus();
    await user.keyboard("local edit");
    expect(editor.textContent).toBe("local edit");

    fireEvent.keyDown(editor, {
      key: "z",
      code: "KeyZ",
      ctrlKey: true,
    });
    await waitFor(() => expect(editor.textContent).toBe(""));
  });
});

describe("MarkdownEditor remote carets", () => {
  it("stays inert (no caret decoration) when collab has no awareness", async () => {
    const ydoc = new Y.Doc();
    const user = userEvent.setup();
    const view = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/no-awareness.md",
        knownFiles: [],
        // Same shape as today's only production caller (FileInspector's
        // engine-mode branch): a live ydoc, but no awareness yet.
        collab: { ydoc, status: "connected", peerCount: 0, synced: true },
      }),
    );

    try {
      const editor = await screen.findByTestId("markdown-editor");
      editor.focus();
      await user.keyboard("solo in a shared doc");
      expect(editor.textContent).toBe("solo in a shared doc");
      expect(view.container.querySelector(".collaboration-carets__caret")).toBeNull();
    } finally {
      view.unmount();
      ydoc.destroy();
    }
  });

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
// all read from (they all serialize through this same mounted editor's
// markdown manager). Before MarkdownEditor.tsx registered
// FenceWideningCodeBlock, StarterKit's default codeBlock hardcoded a
// three-backtick fence regardless of content, so a code block whose own
// content held a ``` line closed its fence early and truncated on
// re-import (#704).
describe("MarkdownEditor markdown export: code fence widening (#704)", () => {
  it("widens a code fence in the live editor's getMarkdown when the block content contains a fence", async () => {
    const content = "before\n```\nafter";
    const value = ["````js", "before", "```", "after", "````"].join("\n");
    const ref = createRef<MarkdownEditorHandle>();
    const view = render(
      createElement(MarkdownEditor, {
        ref,
        value,
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/fence.md",
        knownFiles: [],
      }),
    );

    try {
      await screen.findByTestId("markdown-editor");
      const markdown = ref.current?.getMarkdown();
      expect(markdown).toMatch(/^`{4,}js$/m);
      expect(markdown).toContain(content);
    } finally {
      view.unmount();
    }
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
