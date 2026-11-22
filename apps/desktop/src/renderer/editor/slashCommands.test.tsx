// @vitest-environment jsdom
import { createElement, useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AnyExtension, Editor, Extension } from "@tiptap/core";
import { DohcRawInline } from "@dohc/ydoc-projection/markdown-extensions";
import { StarterKit } from "@tiptap/starter-kit";
import { Collaboration } from "@tiptap/extension-collaboration";
import * as yTiptap from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  CLOSED_SLASH_COMMAND_STATE,
  dismissSlashCommand,
  filterSlashCommands,
  makeSlashCommandPlugin,
  runSlashCommand,
  SlashCommandMenu,
  type SlashCommandId,
  type SlashCommandState,
} from "./slashCommands";
import { insertBlockAfter } from "./blockControls";

// Same Range stubs the other picker tests use — the plugin calls
// view.coordsAtPos, which reaches into DOM Range measurement under jsdom.
beforeEach(() => {
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { inListView, mockListLayout } from "../ui/listLayout.testSupport";

const OPEN_STATE_BASE = {
  open: true as const,
  from: 1,
  to: 2,
  query: "",
  selected: 0,
  x: 100,
  y: 40,
  bottom: null,
  maxHeight: 320,
  placement: "below" as const,
};

function Harness({
  onEditor,
  onState,
}: {
  onEditor: (editor: Editor) => void;
  onState: (state: SlashCommandState) => void;
}) {
  const [slashState, setSlashState] = useState<SlashCommandState>(CLOSED_SLASH_COMMAND_STATE);
  const slashStateRef = useRef<SlashCommandState>(slashState);
  const runCommandRef = useRef<(id: SlashCommandId) => void>(() => {});
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    slashStateRef.current = slashState;
  }, [slashState]);

  useEffect(() => {
    onState(slashState);
  }, [slashState, onState]);

  if (!editorRef.current) {
    const extension = Extension.create({
      name: "dohcTestSlash",
      addProseMirrorPlugins() {
        return [
          makeSlashCommandPlugin({
            stateRef: slashStateRef,
            setState: setSlashState,
            runCommandRef,
          }),
        ];
      },
    });
    editorRef.current = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit.configure({ trailingNode: false }), extension],
      content: "<p></p>",
    });
    onEditor(editorRef.current);
  }

  return createElement(SlashCommandMenu, {
    state: slashState,
    onSelect: () => {},
    onHover: () => {},
  });
}

describe("slash menu render stability", () => {
  it("keeps the menu mounted (same DOM node) while the query is typed", () => {
    let editor: Editor | null = null;
    const states: SlashCommandState[] = [];

    const { container } = render(
      createElement(Harness, {
        onEditor: (instance) => {
          editor = instance;
        },
        onState: (state) => states.push(state),
      }),
    );

    const type = (text: string) => {
      act(() => {
        editor!.commands.insertContent(text);
      });
    };

    type("/");
    const menuAfterOpen = container.querySelector(".dohc-slash-menu");
    expect(menuAfterOpen).not.toBeNull();

    type("h");
    type("e");

    const menuAfterTyping = container.querySelector(".dohc-slash-menu");
    expect(menuAfterTyping).not.toBeNull();
    // Same element instance — the menu must update in place, not remount
    // (a remount replays the pop-in animation, which reads as flicker).
    expect(menuAfterTyping).toBe(menuAfterOpen);

    const openFlags = states.map((state) => state.open);
    const firstOpen = openFlags.indexOf(true);
    expect(firstOpen).toBeGreaterThanOrEqual(0);
    for (let i = firstOpen; i < openFlags.length; i++) {
      expect(openFlags[i]).toBe(true);
    }

    act(() => editor!.destroy());
  });
});

function makeSlashEditor(ydoc?: Y.Doc, extra: AnyExtension[] = []) {
  const stateRef: { current: SlashCommandState } = { current: CLOSED_SLASH_COMMAND_STATE };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false, undoRedo: false }),
      ...extra,
      ...(ydoc ? [Collaboration.configure({ document: ydoc })] : []),
      Extension.create({
        name: "dohcTestSlash",
        addProseMirrorPlugins() {
          return [
            makeSlashCommandPlugin({
              stateRef,
              setState: (next) => {
                stateRef.current = typeof next === "function" ? next(stateRef.current) : next;
              },
              runCommandRef: { current: () => {} },
              yTiptap: ydoc ? yTiptap : null,
            }),
          ];
        },
      }),
    ],
    ...(ydoc ? {} : { content: "<p></p>" }),
  });
  const press = (key: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    return event;
  };
  return { editor, stateRef, press };
}

describe("Escape on the slash menu", () => {
  it("closes it, keeps the typed text, and keeps it closed while the query is typed", () => {
    const { editor, stateRef, press } = makeSlashEditor();
    editor.commands.insertContent("/he");
    expect(stateRef.current.open).toBe(true);

    expect(press("Escape").defaultPrevented).toBe(true);
    expect(stateRef.current.open).toBe(false);
    expect(editor.state.doc.textContent).toBe("/he");

    editor.commands.insertContent("a");
    editor.commands.insertContent("d");
    expect(editor.state.doc.textContent).toBe("/head");
    expect(stateRef.current.open).toBe(false);
    expect(press("Escape").defaultPrevented).toBe(false);
    editor.destroy();
  });

  it("opens again for a fresh /", () => {
    const { editor, stateRef, press } = makeSlashEditor();
    editor.commands.insertContent("/he");
    press("Escape");
    editor.commands.insertContent("x");
    expect(stateRef.current.open).toBe(false);

    editor.commands.insertContent(" /");
    expect(stateRef.current).toMatchObject({ open: true, from: 6, query: "" });
    editor.destroy();
  });

  it("opens again when the caret leaves the trigger and comes back", () => {
    const { editor, stateRef, press } = makeSlashEditor();
    editor.commands.insertContent("/head");
    press("Escape");
    editor.commands.setTextSelection(4);
    expect(stateRef.current.open).toBe(false);

    editor.commands.setTextSelection(1);
    expect(stateRef.current.open).toBe(false);
    editor.commands.setTextSelection(6);
    expect(stateRef.current).toMatchObject({ open: true, from: 1, query: "head" });
    editor.destroy();
  });
});

describe("the slash trigger after an inline atom", () => {
  // A sealed piece's text is its source, so text offsets and positions differ.
  it.each(["<kbd>", "&nbsp;"])("finds the / after a sealed %s", (source) => {
    const { editor, stateRef } = makeSlashEditor(undefined, [DohcRawInline]);
    editor.commands.insertContent([
      { type: "text", text: "Press " },
      { type: "rawInline", attrs: { source } },
      { type: "text", text: "K /he" },
    ]);
    // "Press " fills 1-6, the piece 7, "K " 8-9, so the / is at 10.
    expect(stateRef.current).toMatchObject({ open: true, from: 10, query: "he" });
    editor.destroy();
  });

  it("finds the / that starts a line after a hard break", () => {
    const { editor, stateRef } = makeSlashEditor();
    editor.commands.insertContent([
      { type: "text", text: "a" },
      { type: "hardBreak" },
      { type: "text", text: "/he" },
    ]);
    expect(stateRef.current).toMatchObject({ open: true, from: 3, query: "he" });
    editor.destroy();
  });
});

// A collaborator's edits arrive through Y.js, which replaces the whole
// document in the editor and restores the caret.
describe("Escape on the slash menu in a shared document", () => {
  const docs: Y.Doc[] = [];
  afterEach(() => {
    for (const doc of docs.splice(0)) doc.destroy();
  });

  function makeSharedSlashEditor() {
    const ydoc = new Y.Doc();
    const peer = new Y.Doc();
    docs.push(ydoc, peer);
    const relay = (from: Y.Doc, to: Y.Doc) =>
      from.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "relay") Y.applyUpdate(to, update, "relay");
      });
    relay(ydoc, peer);
    relay(peer, ydoc);
    const peerText = (paragraph: number) =>
      (peer.getXmlFragment("default").get(paragraph) as Y.XmlElement).get(0) as Y.XmlText;
    return { ...makeSlashEditor(ydoc), peerText };
  }

  it("stays closed through a collaborator's edit elsewhere", () => {
    const { editor, stateRef, press, peerText } = makeSharedSlashEditor();
    editor.commands.setContent("<p>Intro</p><p>/he</p>");
    editor.commands.setTextSelection(11);
    expect(stateRef.current).toMatchObject({ open: true, from: 8 });
    press("Escape");

    peerText(0).insert(5, ", edited");
    expect(editor.state.doc.textContent).toBe("Intro, edited/he");
    expect(editor.state.selection.from).toBe(19);
    expect(stateRef.current.open).toBe(false);

    editor.commands.insertContent("a");
    expect(stateRef.current.open).toBe(false);
    editor.destroy();
  });

  it("stays closed when a collaborator edits the dismissed query", () => {
    const { editor, stateRef, press, peerText } = makeSharedSlashEditor();
    editor.commands.insertContent("/he");
    press("Escape");

    peerText(0).insert(2, "x");
    expect(editor.state.doc.textContent).toBe("/hxe");
    expect(editor.state.selection.from).toBe(5);
    expect(stateRef.current.open).toBe(false);
    editor.destroy();
  });

  it("opens for a different trigger a collaborator puts in its place", () => {
    const { editor, stateRef, press, peerText } = makeSharedSlashEditor();
    editor.commands.insertContent("/he");
    press("Escape");

    const text = peerText(0);
    text.doc!.transact(() => {
      text.delete(0, 3);
      text.insert(0, "/xx");
    });
    expect(editor.state.doc.textContent).toBe("/xx");
    expect(stateRef.current).toMatchObject({ open: true, from: 1, query: "xx" });
    editor.destroy();
  });

  it("opens for an identical trigger when a collaborator deletes the dismissed one", () => {
    const { editor, stateRef, press, peerText } = makeSharedSlashEditor();
    editor.commands.insertContent("/he /he");
    expect(stateRef.current).toMatchObject({ open: true, from: 5 });
    press("Escape");

    peerText(0).delete(3, 4);
    expect(editor.state.doc.textContent).toBe("/he");
    expect(stateRef.current).toMatchObject({ open: true, from: 1, query: "he" });
    editor.destroy();
  });
});

describe("SlashCommandMenu placement anchoring", () => {
  it("top-anchors below-placement menus at the cursor", () => {
    const { container } = render(
      createElement(SlashCommandMenu, {
        state: { ...OPEN_STATE_BASE },
        onSelect: () => {},
        onHover: () => {},
      }),
    );
    const menu = container.querySelector<HTMLElement>(".dohc-slash-menu")!;
    expect(menu.style.top).toBe("40px");
    expect(menu.style.bottom).toBe("");
  });

  it("bottom-anchors above-placement menus so filtering cannot detach them from the cursor", () => {
    const { container } = render(
      createElement(SlashCommandMenu, {
        state: {
          ...OPEN_STATE_BASE,
          y: 174,
          bottom: 106,
          placement: "above",
        },
        onSelect: () => {},
        onHover: () => {},
      }),
    );
    const menu = container.querySelector<HTMLElement>(".dohc-slash-menu")!;
    expect(menu.style.bottom).toBe("106px");
    expect(menu.style.top).toBe("");
  });
});

describe("SlashCommandMenu on the Menu part's recipe", () => {
  it("marks the active option and scrolls only the list to show it", () => {
    const restore = mockListLayout(200);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const props = { onSelect: () => {}, onHover: () => {} };
      const { rerender } = render(
        createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE }, ...props }),
      );
      const list = screen.getByRole("listbox", { name: "slash commands" });
      const options = screen.getAllByRole("option");
      const last = options.at(-1)!;
      expect(options[0]!.hasAttribute("data-active")).toBe(true);
      expect(inListView(list, last)).toBe(false);

      rerender(
        createElement(SlashCommandMenu, {
          state: { ...OPEN_STATE_BASE, selected: options.length - 1 },
          ...props,
        }),
      );
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(options[0]!.hasAttribute("data-active")).toBe(false);
      expect(inListView(list, last)).toBe(true);
      rerender(
        createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE, selected: 0 }, ...props }),
      );
      expect(inListView(list, options[0]!)).toBe(true);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("takes the active option only from a pointer that moves", () => {
    const onHover = vi.fn();
    render(
      createElement(SlashCommandMenu, {
        state: { ...OPEN_STATE_BASE },
        onSelect: () => {},
        onHover,
      }),
    );
    const second = screen.getAllByRole("option")[1]!;
    fireEvent.mouseMove(second, { movementX: 0, movementY: 0 });
    expect(onHover).not.toHaveBeenCalled();
    fireEvent.mouseMove(second, { movementX: 0, movementY: 3 });
    expect(onHover).toHaveBeenCalledWith(1);
  });

  it("shows section headers when query is empty and hides them when filtering", () => {
    const { rerender } = render(
      createElement(SlashCommandMenu, {
        state: { ...OPEN_STATE_BASE, query: "" },
        onSelect: () => {},
        onHover: () => {},
      }),
    );
    expect(screen.getByText("Basic blocks")).toBeTruthy();
    expect(screen.getByText("Lists")).toBeTruthy();
    expect(screen.getByText("Blocks")).toBeTruthy();
    expect(screen.getByText("Media & links")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Basic blocks" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Lists" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Blocks" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Media & links" })).toBeTruthy();

    rerender(
      createElement(SlashCommandMenu, {
        state: { ...OPEN_STATE_BASE, query: "head" },
        onSelect: () => {},
        onHover: () => {},
      }),
    );
    expect(screen.queryByText("Basic blocks")).toBeNull();
  });

  it("dismisses on outside mousedown", () => {
    const onDismiss = vi.fn();
    render(
      createElement(SlashCommandMenu, {
        state: { ...OPEN_STATE_BASE },
        onSelect: () => {},
        onHover: () => {},
        onDismiss,
      }),
    );
    fireEvent.mouseDown(screen.getByRole("listbox", { name: "slash commands" }));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("filterSlashCommands tiered scoring & code suppression", () => {
  it("ranks label prefixes ahead of alias matches", () => {
    expect(
      filterSlashCommands("t")
        .slice(0, 3)
        .map((c) => c.id),
    ).toEqual(["task-list", "toggle", "table"]);
    expect(filterSlashCommands("d")[0]?.id).toBe("divider");
    expect(filterSlashCommands("i")[0]?.id).toBe("image");
    expect(
      filterSlashCommands("m")
        .slice(0, 2)
        .map((c) => c.id),
    ).toEqual(["math", "mermaid"]);
  });

  it("does not trigger inside code blocks or inline code marks", () => {
    const { editor, stateRef } = makeSlashEditor();
    editor.commands.setContent("<pre><code>/he</code></pre>");
    editor.commands.setTextSelection(4);
    expect(stateRef.current.open).toBe(false);

    editor.commands.setContent("<p><code>/he</code></p>");
    editor.commands.setTextSelection(4);
    expect(stateRef.current.open).toBe(false);
    editor.destroy();
  });

  it("keeps gutter '+' in pure UI state with zero Y.Doc mutation until typing or picking a block", () => {
    const ydoc = new Y.Doc();
    const peerDoc = new Y.Doc();
    const syncUpdates: Uint8Array[] = [];
    ydoc.on("update", (update: Uint8Array) => {
      syncUpdates.push(update);
      Y.applyUpdate(peerDoc, update);
    });
    const { editor, stateRef, press } = makeSlashEditor(ydoc);
    editor.commands.setContent("<p>Hello</p>");
    syncUpdates.length = 0;

    // Clicking gutter '+' opens the slash menu without touching the document or emitting any Y.Doc update.
    insertBlockAfter(editor, 0);
    expect(stateRef.current.open).toBe(true);
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe("Hello");
    expect(syncUpdates).toHaveLength(0);

    // A remote peer edit while the gutter menu is open followed by Escape leaves zero stray '/'.
    const peerBody = peerDoc.getXmlFragment("default");
    const peerParagraph = peerBody.get(0) as Y.XmlElement;
    (peerParagraph.get(0) as Y.XmlText).insert(5, " peer");
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peerDoc));
    press("Escape");
    expect(stateRef.current.open).toBe(false);
    expect(editor.state.doc.textContent).toBe("Hello peer");
    expect(editor.state.doc.textContent).not.toContain("/");

    // Clicking gutter '+' and running a command inserts the new block cleanly after the target block.
    insertBlockAfter(editor, 0);
    expect(stateRef.current.open).toBe(true);
    runSlashCommand(editor, "heading-1", stateRef.current, (next) => {
      stateRef.current = typeof next === "function" ? next(stateRef.current) : next;
    });
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).textContent).toBe("Hello peer");
    expect(editor.state.doc.child(1).type.name).toBe("heading");
    expect(editor.state.doc.child(1).attrs.level).toBe(1);

    // Clicking gutter '+' then typing 'h' materializes '/h' so filtering works seamlessly.
    insertBlockAfter(editor, 0);
    expect(stateRef.current.open).toBe(true);
    press("h");
    expect(stateRef.current).toMatchObject({ open: true, query: "h" });
    expect(editor.state.doc.child(1).textContent).toBe("/h");

    // Outside-click dismiss on a fresh gutter open leaves zero doc edit, while manually typed '/' stays on Escape.
    editor.commands.setContent("<p></p>");
    insertBlockAfter(editor, 0);
    expect(stateRef.current.open).toBe(true);
    dismissSlashCommand(editor.view);
    expect(stateRef.current.open).toBe(false);
    expect(editor.state.doc.textContent).toBe("");

    editor.commands.insertContent("/");
    expect(stateRef.current.open).toBe(true);
    press("Escape");
    expect(stateRef.current.open).toBe(false);
    expect(editor.state.doc.textContent).toBe("/");

    editor.destroy();
    ydoc.destroy();
    peerDoc.destroy();
  });
});
