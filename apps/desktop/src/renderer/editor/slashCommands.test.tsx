// @vitest-environment jsdom
import { createElement, useEffect, useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Collaboration } from "@tiptap/extension-collaboration";
import * as yTiptap from "@tiptap/y-tiptap";
import * as Y from "yjs";
import {
  CLOSED_SLASH_COMMAND_STATE,
  makeSlashCommandPlugin,
  SlashCommandMenu,
  type SlashCommandId,
  type SlashCommandState,
} from "./slashCommands";

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

// Minimal replica of MarkdownEditor's slash wiring: useState + ref-sync +
// plugin extension, rendering the real SlashCommandMenu. `onState` observes
// every committed state so tests can assert on the stream.
function Harness({
  onEditor,
  onState,
}: {
  onEditor: (editor: Editor) => void;
  onState: (state: SlashCommandState) => void;
}) {
  const [slashState, setSlashState] = useState<SlashCommandState>(
    CLOSED_SLASH_COMMAND_STATE,
  );
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

    // The observed state stream must never pass through a closed state
    // between two open ones while the slash query is being typed.
    const openFlags = states.map((state) => state.open);
    const firstOpen = openFlags.indexOf(true);
    expect(firstOpen).toBeGreaterThanOrEqual(0);
    for (let i = firstOpen; i < openFlags.length; i++) {
      expect(openFlags[i]).toBe(true);
    }

    act(() => editor!.destroy());
  });
});

// The plugin alone, on a plain ref, as blockExit.test wires it. With a Y.Doc,
// the editor is bound to it as MarkdownEditor binds a shared document.
function makeSlashEditor(ydoc?: Y.Doc) {
  const stateRef: { current: SlashCommandState } = { current: CLOSED_SLASH_COMMAND_STATE };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ trailingNode: false, undoRedo: false }),
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
    // With the menu closed, Escape is no longer the menu's.
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
    // Inside the trigger, the caret keeps it dismissed.
    editor.commands.setTextSelection(4);
    expect(stateRef.current.open).toBe(false);

    editor.commands.setTextSelection(1);
    expect(stateRef.current.open).toBe(false);
    editor.commands.setTextSelection(6);
    expect(stateRef.current).toMatchObject({ open: true, from: 1, query: "head" });
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

  // The editor on one Y.Doc, and a collaborator's Y.Doc synced both ways.
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
    // The box hangs from its bottom edge (`gap` above the cursor): when the
    // query filters the list and the menu gets shorter, it grows upward while
    // the edge next to the cursor stays put — no per-keystroke leaping.
    expect(menu.style.bottom).toBe("106px");
    expect(menu.style.top).toBe("");
  });
});

// The menu is taller than its cap, and the editor keeps focus while its keys
// move the active option.
describe("SlashCommandMenu on the Menu part's recipe", () => {
  it("marks the active option and scrolls only the list to show it", () => {
    const restore = mockListLayout(200);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const props = { onSelect: () => {}, onHover: () => {} };
      const { rerender } = render(createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE }, ...props }));
      const list = screen.getByRole("listbox", { name: "slash commands" });
      const options = screen.getAllByRole("option");
      const last = options.at(-1)!;
      expect(options[0]!.hasAttribute("data-active")).toBe(true);
      expect(inListView(list, last)).toBe(false);

      rerender(createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE, selected: options.length - 1 }, ...props }));
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(options[0]!.hasAttribute("data-active")).toBe(false);
      expect(inListView(list, last)).toBe(true);
      rerender(createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE, selected: 0 }, ...props }));
      expect(inListView(list, options[0]!)).toBe(true);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("takes the active option only from a pointer that moves", () => {
    const onHover = vi.fn();
    render(createElement(SlashCommandMenu, { state: { ...OPEN_STATE_BASE }, onSelect: () => {}, onHover }));
    const second = screen.getAllByRole("option")[1]!;
    fireEvent.mouseMove(second, { movementX: 0, movementY: 0 });
    expect(onHover).not.toHaveBeenCalled();
    fireEvent.mouseMove(second, { movementX: 0, movementY: 3 });
    expect(onHover).toHaveBeenCalledWith(1);
  });
});
