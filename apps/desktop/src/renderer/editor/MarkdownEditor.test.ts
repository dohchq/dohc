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
import {
  commands,
  Editor,
  Extension,
  getSchema,
  getExtensionField,
  getSchemaTypeByName,
  type AnyConfig,
  type JSONContent,
  type TiptapEditorHTMLElement,
} from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { marked } from "marked";
// Bare TaskItem is imported here only as the contrast case for the schema-
// fidelity pin below — every registered test-local editor schema in
// this file uses DohcTaskItem.
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { NodeSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import {
  prosemirrorJSONToYXmlFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import { DohcTaskItem } from "@dohc/ydoc-projection/markdown-extensions";
import { desktopMarkdownExtensions } from "./extensions";
import {
  getDohcProseMirrorSchema,
  getDohcYDocBodyFragment,
  markdownToYDoc,
} from "@dohc/ydoc-projection";
import { SHORTCUTS, shortcutAccelerators, type ShortcutId } from "../../shortcuts/shortcutRegistry";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { sendToFocusedEditor } from "./editorMenuCommands";
import { findReplaceKey } from "./findReplace";
import { measureParseWork } from "./markdownParseWork";
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
  // and still logs the warning, since nothing in that document resolves
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
  // unguarded seed logs the related `(doc)` warning variant here specifically
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

// The bare-TaskItem swap isn't registration-only — a bare TaskItem's
// `paragraph+` content model rejects the nested list a real task item can
// hold. Driven through the real Y.Doc round trip (the same
// prosemirrorJSONToYXmlFragment / yXmlFragmentToProseMirrorRootNode pair
// production uses), a document that nests a list under a task item survives
// with DohcTaskItem and is dropped entirely (the whole doc reduces to
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
      ...desktopMarkdownExtensions,
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

describe("MarkdownEditor slash command: image", () => {
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

  it.each(["bullet", "ordered", "task"])("indents and outdents %s items with Tab and Shift-Tab", async (kind) => {
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

  it.each(["Enter", "Backspace"])("lifts an empty child with %s", async (key) => {
    const { surface, editor } = await mount("- parent\n  - child");
    caret(editor, "child");
    act(() => { editor.commands.deleteRange({ from: editor.state.selection.from, to: editor.state.selection.from + 5 }); });
    reversible(surface, editor, () => { fireEvent.keyDown(surface, { key }); }, () => {
      expect(surface.querySelector("li li")).toBeNull();
      expect(surface.querySelectorAll("li")).toHaveLength(2);
    });
  });

  it("joins a child at its start with Backspace", async () => {
    const { surface, editor } = await mount("- parent\n  - child");
    caret(editor, "child");
    reversible(surface, editor, () => { fireEvent.keyDown(surface, { key: "Backspace" }); }, () => {
      expect(surface.querySelector("li li")).toBeNull();
      expect(surface.textContent).toContain("child");
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
    ["bullet", "numbered-list"], ["bullet", "task-list"],
    ["ordered", "bulleted-list"], ["ordered", "task-list"],
    ["task", "bulleted-list"], ["task", "numbered-list"],
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

  it.each([
    ["top-level cursor", "- a\n- child\n- c", "child", false],
    ["top-level selection", "- a\n- child\n- c", "child", true],
    ["nested quote", "- parent\n  - child\n\n    > quote", "quote", false],
    ["nested callout", "- parent\n  - child\n\n    > [!NOTE]\n    > callout", "callout", false],
  ] as const)("keeps Tiptap conversion scope for %s", async (_name, markdown, text, multi) => {
    const { surface, editor } = await mount(markdown);
    if (multi) caret(editor, "c", 1);
    const end = editor.state.selection.to;
    caret(editor, text, 2);
    if (multi) act(() => { editor.commands.setTextSelection({ from: editor.state.selection.from, to: end }); });
    const before = editor.getJSON();
    const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
    editor.view.dispatch(closeHistory(editor.state.tr));
    act(() => { editor.commands.command(commands.toggleList("taskList", "taskItem")); });
    const expected = editor.getJSON();
    const expectedSelection = editor.state.selection.toJSON();
    fireEvent.keyDown(surface, { key: "z", ctrlKey: true });
    expect(editor.getJSON()).toEqual(before);
    act(() => { editor.commands.setTextSelection(selection); });
    reversible(surface, editor, () => { editor.commands.toggleTaskList(); }, () => {
      expect(editor.getJSON()).toEqual(expected);
      expect(editor.state.selection.toJSON()).toEqual(expectedSelection);
    });
  });

  it.each(["before", "after", "both"])("joins converted children with task neighbours %s", async (side) => {
    const { surface, editor } = await mount(`- parent\n${side !== "after" ? "  - [ ] a\n" : ""}  - child${side !== "before" ? "\n  - [ ] c" : ""}`);
    caret(editor, "child", 2);
    reversible(surface, editor, () => { editor.commands.toggleTaskList(); }, () => {
      const lists = surface.querySelectorAll('li > ul[data-type="taskList"]');
      expect(lists).toHaveLength(1);
      expect(lists[0]!.querySelectorAll(":scope > li")).toHaveLength(side === "both" ? 3 : 2);
      expect(editor.state.selection.$from.parent.textContent).toBe("child");
      expect(editor.state.selection.$from.parentOffset).toBe(2);
    });
  });

  it.each([
    ["See here", 4, "- 5 points"],
    ["See here", 4, "- first\n  - second"],
    ["", 0, "- 5 points"],
    ["", 0, "- a\n\n# Heading\n\n| t |\n|---|"],
  ] as const)("keeps literal paste in %s at %i: %s", async (text, offset, pasted) => {
    const { surface, editor } = await mount(text);
    caret(editor, text, offset);
    reversible(surface, editor, () => {
      fireEvent.paste(surface, { clipboardData: {
        files: [], types: ["text/plain"], getData: (type: string) => type === "text/plain" ? pasted : "",
      } });
    }, () => {
      expect(surface.querySelector("li, h1, table")).toBeNull();
      expect(surface.textContent).toContain(pasted.split("\n")[0]);
    });
  });

  it("keeps a list pasted at the start of a heading literal", async () => {
    const { surface, editor } = await mount("# Title");
    caret(editor, "Title", 0);
    reversible(surface, editor, () => {
      fireEvent.paste(surface, { clipboardData: {
        files: [], types: ["text/plain"], getData: (type: string) => type === "text/plain" ? "- a\n- b" : "",
      } });
    }, () => {
      expect(surface.querySelector("li")).toBeNull();
      expect(surface.querySelector("h1")?.textContent).toContain("- a");
    });
  });

  it.each(["plain", "code"])("keeps Markdown literal when pasting as %s text", async (context) => {
    const { surface, editor } = await mount(context === "code" ? "```\nseed\n```" : "");
    caret(editor, context === "code" ? "seed" : "");
    if (context === "plain") fireEvent.keyDown(surface, { key: "Shift", shiftKey: true });
    fireEvent.paste(surface, { clipboardData: {
      files: [], types: ["text/plain"],
      getData: (type: string) => type === "text/plain" ? "- parent\n  - child" : "",
    } });
    expect(surface.querySelector("li")).toBeNull();
    expect(surface.textContent).toContain("- parent");
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

// The block gutter selects a whole table, which Backspace and Delete then
// remove. Without the editor's table node selection, Tiptap turns the gutter's
// selection into a selection of the table's cells.
describe("MarkdownEditor table gutter", () => {
  it.each(["Backspace", "Delete"])("selects a whole table from its gutter and deletes it with %s", async (key) => {
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

// The editor reads Markdown through the projection's parser. A block
// tokenizer that splits or searches the rest of the document only to reject an
// ordinary paragraph makes opening a long note quadratic. Counting newline
// splits alone missed the block-marker searches.
describe("MarkdownEditor markdown import", () => {
  it("reads a linear amount of text when it opens or replaces ordinary paragraphs", async () => {
    const body = (paragraphs: number, text: string) => Array(paragraphs).fill(text).join("\n\n");
    const measure = async (paragraphs: number) => {
      const ref = createRef<MarkdownEditorHandle>();
      let view: ReturnType<typeof render> | undefined;
      const open = await measureParseWork(async () => {
        view = render(
          createElement(MarkdownEditor, {
            ref,
            value: body(paragraphs, "Ordinary paragraph."),
            onDirty: vi.fn(),
            workspaceId: "workspace-1",
            path: "notes/long.md",
            knownFiles: [],
          }),
        );
        const editor = editorBehind(await screen.findByTestId("markdown-editor"));
        expect(editor.state.doc.childCount).toBe(paragraphs);
      });
      const replace = await measureParseWork(() => {
        act(() => ref.current?.replaceMarkdown(body(paragraphs, "Replaced paragraph.")));
        const editor = editorBehind(screen.getByTestId("markdown-editor"));
        expect(editor.state.doc.childCount).toBe(paragraphs);
        expect(editor.state.doc.lastChild?.textContent).toBe("Replaced paragraph.");
      });
      view?.unmount();
      return { open, replace };
    };
    const small = await measure(64);
    const large = await measure(128);
    for (const path of ["open", "replace"] as const) {
      expect(small[path].search, path).toBeGreaterThan(0);
      expect(large[path].split, `${path} newline split characters: ${small[path].split} -> ${large[path].split}`)
        .toBeLessThan(small[path].split * 2.2);
      expect(large[path].search, `${path} searched characters: ${small[path].search} -> ${large[path].search}`)
        .toBeLessThan(small[path].search * 2.2);
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
        ...desktopMarkdownExtensions,
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

  it("reports an asynchronous image insert after the editor loses focus", async () => {
    let resolveSettings!: (value: unknown) => void;
    const settings = new Promise((resolve) => {
      resolveSettings = resolve;
    });
    const writeWorkspaceAsset = vi.fn().mockResolvedValue(undefined);
    window.dohcDesktop = {
      getWorkspaceSettings: vi.fn(() => settings),
      writeWorkspaceAsset,
    } as never;
    const onDirty = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], "photo.png", {
      type: "image/png",
    });
    Object.defineProperty(file, "arrayBuffer", {
      configurable: true,
      value: async () => new Uint8Array([1, 2, 3]).buffer,
    });

    try {
      render(
        createElement(
          "div",
          null,
          createElement("button", { type: "button" }, "Other pane"),
          createElement(MarkdownEditor, {
            value: "# Before\n",
            onDirty,
            workspaceId: "workspace-1",
            path: "notes/shared.md",
            knownFiles: [],
          }),
        ),
      );
      const editor = await screen.findByTestId("markdown-editor");
      await flushAnimationFrames();
      editor.focus();
      onDirty.mockClear();
      fireEvent.paste(editor, {
        clipboardData: {
          files: [file],
          getData: () => "",
          types: ["Files"],
        },
      });
      screen.getByRole("button", { name: "Other pane" }).focus();

      resolveSettings({
        settings: {
          files: {
            attachmentLocation: "per-document",
            attachmentFolderName: "assets",
          },
        },
      });

      await waitFor(() => expect(writeWorkspaceAsset).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          onDirty.mock.calls.some(([materialize]) =>
            (materialize as () => string)().includes("assets/photo-"),
          ),
        ).toBe(true),
      );
      expect(document.activeElement).not.toBe(editor);
    } finally {
      delete window.dohcDesktop;
    }
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

  it("maps an end cursor across peer content prepended by replacement", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(MarkdownEditor, {
        ref,
        value: "# Target\n\nTail",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    act(() => ref.current?.focus("end"));
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(selectionTextOffset(editor)).toBe(editor.textContent?.length);

    act(() =>
      ref.current?.replaceMarkdown("# Peer\n\n# Target\n\nTail"),
    );

    expect(document.activeElement).toBe(editor);
    expect(selectionTextOffset(editor)).toBe(editor.textContent?.length);
    expect(onDirty).not.toHaveBeenCalled();
    await user.keyboard("!");
    expect(editor.textContent).toMatch(/Tail!$/);
  });

  it("keeps an end cursor before peer content appended by replacement", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    const user = userEvent.setup();
    render(
      createElement(MarkdownEditor, {
        ref,
        value: "# Target\n\nTail",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    act(() => ref.current?.focus("end"));
    await waitFor(() => expect(document.activeElement).toBe(editor));

    act(() =>
      ref.current?.replaceMarkdown("# Target\n\nTail\n\nPeer"),
    );
    expect(onDirty).not.toHaveBeenCalled();
    await user.keyboard("!");

    expect(editor.textContent).toContain("Tail!");
    expect(editor.textContent).not.toContain("Peer!");
    expect(onDirty).toHaveBeenCalledTimes(1);
  });

  it("keeps a cursor in unchanged content between disjoint peer edits", async () => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn();
    render(
      createElement(MarkdownEditor, {
        ref,
        value: "Before\n\nTarget\n\nAfter",
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/shared.md",
        knownFiles: [],
      }),
    );
    const editor = await screen.findByTestId("markdown-editor");
    const target = Array.from(editor.querySelectorAll("p")).find(
      (paragraph) => paragraph.textContent === "Target",
    );
    const text = target?.firstChild;
    if (!(text instanceof Text)) throw new Error("expected target paragraph text");
    editor.focus();
    const range = document.createRange();
    range.setStart(text, 3);
    range.collapse(true);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    await waitFor(() => expect(selectionTextOffset(editor)).toBe(9));

    act(() =>
      ref.current?.replaceMarkdown("Peer\n\nBefore\n\nTarget\n\nAfter\n\nTail"),
    );

    expect(selectionTextOffset(editor)).toBe(13);
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

  it("reports an edit that lands before the first animation frame", async () => {
    holdAnimationFrames();
    const onDirty = vi.fn();
    const user = userEvent.setup();
    const view = render(createElement(MarkdownEditor, editorProps(onDirty)));

    try {
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
    }
  });

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

  it("writes a caret into an empty document when Tab focuses it", async () => {
    const { view } = mount("");
    try {
      const editor = await screen.findByTestId("markdown-editor");
      focusByKeyboard(editor);

      const paragraph = editor.querySelector("p");
      const anchor = document.getSelection()?.anchorNode ?? null;
      expect(paragraph?.contains(anchor)).toBe(true);
      expect(selectionTextOffset(editor)).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("writes a caret when focus leaves the DOM caret at the editor root", async () => {
    const { view } = mount("Body text");
    try {
      const editor = await screen.findByTestId("markdown-editor");
      editor.focus();
      expect(document.getSelection()?.anchorNode).toBe(editor);

      fireEvent.focus(editor);

      const paragraph = editor.querySelector("p");
      const anchor = document.getSelection()?.anchorNode ?? null;
      expect(paragraph?.contains(anchor)).toBe(true);
      expect(selectionTextOffset(editor)).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("keeps a caret that is already inside the content", async () => {
    const { view } = mount("Body text");
    try {
      const editor = await screen.findByTestId("markdown-editor");
      const text = editor.querySelector("p")?.firstChild;
      if (!(text instanceof Text)) throw new Error("expected paragraph text");
      editor.focus();
      const range = document.createRange();
      range.setStart(text, 4);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      fireEvent.focus(editor);

      expect(selectionTextOffset(editor)).toBe(4);
    } finally {
      view.unmount();
    }
  });

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

  it("moves focus and the caret at once when the handle focuses the start", async () => {
    const { ref, view } = mount("First\n\nSecond");
    try {
      const editor = await screen.findByTestId("markdown-editor");
      screen.getByTestId("markdown-editor").blur();

      act(() => ref.current?.focus("start"));

      expect(document.activeElement).toBe(editor);
      expect(selectionTextOffset(editor)).toBe(0);
    } finally {
      view.unmount();
    }
  });
});


it.each([["Win32", "win32"], ["MacIntel", "darwin"]] as const)("keeps the display catalogue and allowed shell conflicts aligned with the mounted %s editor keymaps", async (navigatorPlatform, platform) => {
  const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(navigatorPlatform);
  vi.stubGlobal("dohcDesktop", { platform });
  try {
    render(createElement(MarkdownEditor, { value: "Text", onDirty: vi.fn(), workspaceId: "ws", path: "note.md", knownFiles: [] }));
    const surface = await screen.findByTestId("markdown-editor");
    const editor = await waitFor(() => editorBehind(surface));
    const keymaps = editor.extensionManager.extensions.flatMap((extension) => {
      const shortcuts = getExtensionField<AnyConfig["addKeyboardShortcuts"]>(extension, "addKeyboardShortcuts", {
        name: extension.name, options: extension.options, storage: extension.storage, editor, type: getSchemaTypeByName(extension.name, editor.schema),
      });
      return Object.keys(shortcuts?.() ?? {}).filter((key) => /Mod-|Ctrl-|Alt-|Meta-/.test(key))
        .map((key) => ({ extension: extension.name, key }));
    });
    const canonical = (key: string) => {
      const parts = key.toLowerCase().split("-");
      return [parts.includes("mod") ? "commandorcontrol" : "", parts.includes("ctrl") ? "ctrl" : "", parts.includes("meta") ? "meta" : "", parts.includes("shift") ? "shift" : "", parts.includes("alt") ? "alt" : "", parts.at(-1)!].filter(Boolean).join("+");
    };
    const mounted = [...new Set(keymaps.map(({ key }) => canonical(key)))].sort();
    const listed = (Object.keys(SHORTCUTS) as ShortcutId[]).filter((id) => {
      const row = SHORTCUTS[id];
      return row.owner === "editor" && (!("platforms" in row) || (row.platforms as readonly string[]).includes(platform));
    }).flatMap((id) => shortcutAccelerators(id, platform).map((key) => key.toLowerCase())).sort();
    expect(listed).toEqual(mounted);
    if (platform === "darwin") {
      expect(mounted).toEqual(expect.arrayContaining(["ctrl+a", "ctrl+e", "ctrl+h", "ctrl+d", "ctrl+alt+backspace", "commandorcontrol+alt+f"]));
      expect(mounted).not.toContain("commandorcontrol+d");
      expect(mounted).not.toContain("commandorcontrol+h");
    } else {
      expect(mounted).toContain("commandorcontrol+h");
    }
    const conflicts = Object.entries(SHORTCUTS).filter(([, row]) => row.owner === "shell" || row.owner === "history-restore")
      .flatMap(([id, row]) => row.accelerators.filter((key) => ["commandorcontrol", "ctrl", "meta"].some((modifier) => mounted.includes(key.toLowerCase().replace("commandorcontrol", modifier)))).map((accelerator) => [id, accelerator]));
    // These existing overlaps belong to the editor when it claims the event.
    // A new overlap must be reviewed rather than silently taking an editor key.
    expect(conflicts).toEqual([
      ["command-palette", "CommandOrControl+K"],
      ["toggle-sidebar", "CommandOrControl+B"],
      ["history-restore-undo", "CommandOrControl+Z"],
    ]);
  } finally {
    platformSpy.mockRestore();
  }
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
