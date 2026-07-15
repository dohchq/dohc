// @vitest-environment jsdom
import { createElement, useEffect, useRef, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import {
  CLOSED_SLASH_COMMAND_STATE,
  makeSlashCommandPlugin,
  SlashCommandMenu,
  type SlashCommandId,
  type SlashCommandState,
} from "./slashCommands";

// Same Range/scroll stubs the other picker tests use — the plugin calls
// view.coordsAtPos, which reaches into DOM Range measurement under jsdom.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
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
