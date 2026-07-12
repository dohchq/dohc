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
import userEvent from "@testing-library/user-event";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { dohcMarkdownExtensions } from "./extensions";
import { MarkdownEditor } from "./MarkdownEditor";
import {
  findEmptyListItemParagraph,
  makeCodeBlockChromePlugin,
  makeCodeBlockContinuationPlugin,
} from "./codeBlockChrome";
import {
  CLOSED_SLASH_COMMAND_STATE,
  filterSlashCommands,
  findSlashCommandMatch,
  runSlashCommand,
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

describe("MarkdownEditor slash command: math", () => {
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

  it("Cmd/Ctrl+Enter always inserts a paragraph below, even with content after", () => {
    const editor = makeEditor("```\ncode\n```\n\nSome text");
    expect(editor.state.doc.childCount).toBe(2);

    expect(pressAtEndOfCode(editor, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).content.size).toBe(0);
    editor.destroy();
  });

  it("renders the add-paragraph strip only after a terminal code block", () => {
    const trailing = makeEditor("```\ncode\n```");
    trailing.registerPlugin(makeCodeBlockChromePlugin());
    expect(
      trailing.view.dom.querySelectorAll(".dohc-code-block-continuation"),
    ).toHaveLength(1);
    trailing.destroy();

    // With content below, the next block is already the click target.
    const followed = makeEditor("```\ncode\n```\n\nSome text");
    followed.registerPlugin(makeCodeBlockChromePlugin());
    expect(
      followed.view.dom.querySelectorAll(".dohc-code-block-continuation"),
    ).toHaveLength(0);
    followed.destroy();
  });

  it("clicking anywhere on the continuation strip appends a paragraph", () => {
    const editor = makeEditor("```\ncode\n```");
    editor.registerPlugin(makeCodeBlockChromePlugin());
    const strip = editor.view.dom.querySelector(".dohc-code-block-continuation");
    expect(strip).not.toBeNull();

    fireEvent.click(strip!);
    expect(editor.state.doc.childCount).toBe(2);
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

describe("MarkdownEditor history", () => {
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
