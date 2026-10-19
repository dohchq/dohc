// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { keydownHandler } from "@tiptap/pm/keymap";
import { EditorState } from "@tiptap/pm/state";
import { DecorationSet, type EditorView } from "@tiptap/pm/view";
import { StarterKit } from "@tiptap/starter-kit";
import type { MenuItemConstructorOptions } from "electron";
import { EDITOR_MENU_COMMANDS, isEditorMenuCommand, type EditorMenuCommand } from "../../ipc/channels";
import { shortcutAccelerators } from "../../shortcuts/shortcutRegistry";
import { buildMenuTemplate } from "../../window/applicationMenu";
import { boldText, codeBlock, doc, hardBreak, paragraph, schema } from "./testDocs";
import {
  buildReplaceActiveTransaction,
  buildReplaceAllTransaction,
  CLOSED_FIND_REPLACE_STATE,
  computeMatches,
  findReplaceExtension,
  findReplaceKey,
  findReplaceReducer,
  makeFindReplacePlugin,
  nextMatchIndex,
  prevMatchIndex,
  runFindCommand,
  type FindReplaceAction,
  type FindReplaceState,
} from "./findReplace";

// Real ProseMirror documents built through the shared dohc schema
// (testDocs.ts). A single paragraph's text starts at pos 1, matching the
// hand-computed positions below.

describe("computeMatches", () => {
  it("finds multiple matches in plain text", () => {
    const d = doc(paragraph("the cat sat on the mat"));
    expect(computeMatches(d, "at", true)).toEqual([
      { from: 6, to: 8 }, // c-AT
      { from: 10, to: 12 }, // s-AT
      { from: 21, to: 23 }, // m-AT
    ]);
  });

  it("is case-insensitive by default and case-sensitive when asked", () => {
    const d = doc(paragraph("Cat cat CAT"));
    expect(computeMatches(d, "cat", false)).toHaveLength(3);
    expect(computeMatches(d, "cat", true)).toEqual([{ from: 5, to: 8 }]);
  });

  it("spans adjacent text nodes within the same textblock (**bo**ld)", () => {
    // A bold "bo" (pos 1-3) directly followed by a plain "ld" (pos 3-5)
    // inside one paragraph — two text nodes, positionally contiguous.
    const d = doc(paragraph(boldText("bo"), "ld"));
    expect(computeMatches(d, "old", false)).toEqual([{ from: 2, to: 5 }]);
    expect(computeMatches(d, "bold", false)).toEqual([{ from: 1, to: 5 }]);
  });

  it("does not merge across a block boundary or a non-text gap", () => {
    // "end" at 1..4 in the first paragraph (nodeSize 5); "start" resumes at
    // 6 in the second — not contiguous.
    const d = doc(paragraph("end"), paragraph("start"));
    expect(computeMatches(d, "endstart", false)).toEqual([]);
    expect(computeMatches(d, "end", false)).toEqual([{ from: 1, to: 4 }]);
    expect(computeMatches(d, "start", false)).toEqual([{ from: 6, to: 11 }]);

    // A non-text leaf (hardBreak) between two text nodes in the same
    // paragraph also breaks the run.
    const withBreak = doc(paragraph("end", hardBreak(), "start"));
    expect(computeMatches(withBreak, "endstart", false)).toEqual([]);
  });

  it("searches code blocks too — no exclusion by node type", () => {
    const d = doc(codeBlock("const at = 1"));
    expect(computeMatches(d, "at", false)).toEqual([{ from: 7, to: 9 }]);
  });

  it("returns no matches for an empty query or an absent query string", () => {
    const d = doc(paragraph("hello world"));
    expect(computeMatches(d, "", false)).toEqual([]);
    expect(computeMatches(d, "xyz", false)).toEqual([]);
  });
});

describe("nextMatchIndex / prevMatchIndex — wrapping navigation", () => {
  it("wraps forward past the last match", () => {
    expect(nextMatchIndex(3, 0)).toBe(1);
    expect(nextMatchIndex(3, 1)).toBe(2);
    expect(nextMatchIndex(3, 2)).toBe(0);
  });

  it("wraps backward past the first match", () => {
    expect(prevMatchIndex(3, 2)).toBe(1);
    expect(prevMatchIndex(3, 1)).toBe(0);
    expect(prevMatchIndex(3, 0)).toBe(2);
  });

  it("starts at the first/last match when nothing is active yet", () => {
    expect(nextMatchIndex(3, -1)).toBe(0);
    expect(prevMatchIndex(3, -1)).toBe(2);
  });

  it("is always -1 with no matches", () => {
    expect(nextMatchIndex(0, -1)).toBe(-1);
    expect(prevMatchIndex(0, -1)).toBe(-1);
  });
});

describe("findReplaceReducer", () => {
  const catDoc = doc(paragraph("the cat sat on the mat"));

  it("open computes matches and activates the first one", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    expect(state.open).toBe(true);
    expect(state.replaceOpen).toBe(false);
    expect(state.matches).toHaveLength(3);
    expect(state.activeIndex).toBe(0);
  });

  it("open with replace:true expands the replace row; a second open keeps it expanded", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: true, query: "cat" },
      catDoc,
    );
    expect(opened.replaceOpen).toBe(true);
    const reopened = findReplaceReducer(opened, { type: "open", replace: false }, catDoc);
    expect(reopened.replaceOpen).toBe(true); // Mod-f after Mod-h doesn't collapse it
    expect(reopened.query).toBe("cat"); // and doesn't clobber the typed query
  });

  it("setQuery recomputes matches and resets to the first match", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const navigated = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(navigated.activeIndex).toBe(1);
    const requeried = findReplaceReducer(navigated, { type: "setQuery", query: "cat" }, catDoc);
    expect(requeried.matches).toHaveLength(1);
    expect(requeried.activeIndex).toBe(0);
  });

  it("no matches state: activeIndex is -1 and the counter has nothing to show", () => {
    const state = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "zzz" },
      catDoc,
    );
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
  });

  it("close resets to the closed state, dropping query/replacement/matches", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: true, query: "cat" },
      catDoc,
    );
    expect(findReplaceReducer(opened, { type: "close" }, catDoc)).toEqual(CLOSED_FIND_REPLACE_STATE);
  });

  it("sync keeps the same match active by position when the doc changes elsewhere", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(onSecond.activeIndex).toBe(1);
    const secondMatchFrom = onSecond.matches[1]!.from;

    // An edit after the active match (appending text at the end) doesn't
    // shift any earlier position, so the same match should stay active.
    const appendedDoc = doc(paragraph("the cat sat on the mat, extra"));
    const synced = findReplaceReducer(onSecond, { type: "sync" }, appendedDoc);
    expect(synced.activeIndex).toBe(1);
    expect(synced.matches[synced.activeIndex]?.from).toBe(secondMatchFrom);
  });

  it("sync advances forward when the active match disappears (e.g. after Replace)", () => {
    const opened = findReplaceReducer(
      CLOSED_FIND_REPLACE_STATE,
      { type: "open", replace: false, query: "at" },
      catDoc,
    );
    const onSecond = findReplaceReducer(opened, { type: "next" }, catDoc);
    expect(onSecond.activeIndex).toBe(1);

    // The "sat" occurrence (the active match) is gone; only "cat" (before the
    // old position) and "mat" (after it) remain. Forward progression should
    // land on "mat" — the nearest match at/after where we were — not snap
    // back to "cat" at the top of the doc.
    const editedDoc = doc(paragraph("the cat ran on the mat"));
    const synced = findReplaceReducer(onSecond, { type: "sync" }, editedDoc);
    expect(synced.matches).toHaveLength(2);
    expect(synced.activeIndex).toBe(1);
    expect(synced.matches[synced.activeIndex]?.from).toBe(21);
  });
});

describe("buildReplaceActiveTransaction / buildReplaceAllTransaction", () => {
  function stateFor(text: string): EditorState {
    return EditorState.create({ schema, doc: doc(paragraph(text)) });
  }

  it("replace-active preserves the surrounding text", () => {
    const text = "the cat sat on the mat";
    const state = stateFor(text);
    const matches = computeMatches(state.doc, "cat", true);
    expect(matches).toHaveLength(1);

    const find: Pick<FindReplaceState, "matches" | "activeIndex" | "replacement"> = {
      matches,
      activeIndex: 0,
      replacement: "dog",
    };
    const tr = buildReplaceActiveTransaction(state, find);
    expect(tr).not.toBeNull();
    const next = state.apply(tr!);
    expect(next.doc.textContent).toBe("the dog sat on the mat");
  });

  it("replace-active is a no-op (null transaction) with no active match", () => {
    const state = stateFor("no match here");
    const tr = buildReplaceActiveTransaction(state, { matches: [], activeIndex: -1, replacement: "x" });
    expect(tr).toBeNull();
  });

  it("replace-all replaces every match and reports the count", () => {
    const text = "the cat sat on the mat";
    const state = stateFor(text);
    const matches = computeMatches(state.doc, "the", true);
    expect(matches).toHaveLength(2);

    const { tr, count } = buildReplaceAllTransaction(state, { matches, replacement: "a" });
    expect(count).toBe(2);
    const next = state.apply(tr);
    expect(next.doc.textContent).toBe("a cat sat on a mat");
  });

  it("replace-all count is 0 and the transaction is a no-op with no matches", () => {
    const state = stateFor("nothing to see");
    const { tr, count } = buildReplaceAllTransaction(state, { matches: [], replacement: "x" });
    expect(count).toBe(0);
    expect(tr.doc.textContent).toBe(state.doc.textContent);
  });
});

// The reducer/transaction-builder suites above test the pure pieces in
// isolation; this exercises the real registered plugin end-to-end so the
// meta-action wiring, the docChanged→auto-sync branch in apply(), and
// buildFindDecorations can't silently regress.
describe("makeFindReplacePlugin (registered plugin, real EditorState)", () => {
  function openState(query: string) {
    const plugin = makeFindReplacePlugin();
    let state = EditorState.create({
      schema,
      doc: doc(paragraph("the cat sat on the mat")),
      plugins: [plugin],
    });
    state = state.apply(
      state.tr.setMeta(findReplaceKey, { type: "open", replace: false, query }),
    );
    return { plugin, state };
  }

  it("open meta populates plugin state and renders a decoration per match", () => {
    const { plugin, state } = openState("the");
    const find = findReplaceKey.getState(state);
    expect(find?.open).toBe(true);
    expect(find?.matches).toHaveLength(2);

    const decos = plugin.props.decorations?.call(plugin, state);
    expect(decos).toBeInstanceOf(DecorationSet);
    expect((decos as DecorationSet).find()).toHaveLength(2);
  });

  it("a doc-changing transaction without find meta auto-syncs matches", () => {
    const { state } = openState("the");
    expect(findReplaceKey.getState(state)?.matches).toHaveLength(2);

    // Insert another "the " at the start of the paragraph text — no find
    // meta on this transaction, so only the plugin's docChanged branch can
    // pick it up.
    const next = state.apply(state.tr.insertText("the ", 1));
    expect(findReplaceKey.getState(next)?.matches).toHaveLength(3);
  });
});

describe("findReplaceExtension keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  // jsdom reports no Mac navigator, so ProseMirror reads Mod as Control here.
  function replaceOpenAfter(platform: string, init: KeyboardEventInit): boolean {
    vi.stubGlobal("dohcDesktop", { platform });
    const editor = new Editor({ extensions: [StarterKit, findReplaceExtension], content: "<p>the cat</p>" });
    try {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      editor.view.someProp("handleKeyDown", (handle) => handle(editor.view, event));
      return findReplaceKey.getState(editor.state)?.replaceOpen ?? false;
    } finally {
      editor.destroy();
    }
  }

  it("opens Replace with ⌥⌘F on macOS and leaves ⌘H to Hide", () => {
    expect(replaceOpenAfter("darwin", { key: "ƒ", keyCode: 70, ctrlKey: true, altKey: true })).toBe(true);
    expect(replaceOpenAfter("darwin", { key: "h", keyCode: 72, ctrlKey: true })).toBe(false);
  });

  it.each(["win32", "linux"])("opens Replace with Ctrl+H on %s", (platform) => {
    expect(replaceOpenAfter(platform, { key: "h", keyCode: 72, ctrlKey: true })).toBe(true);
    expect(replaceOpenAfter(platform, { key: "f", keyCode: 70, ctrlKey: true, altKey: true })).toBe(false);
  });

  it.each([
    ["darwin", { key: "g", metaKey: true }, { key: "G", metaKey: true, shiftKey: true }, [{ key: "g", ctrlKey: true }, { key: "F3" }]],
    ["win32", { key: "F3" }, { key: "F3", shiftKey: true }, [{ key: "g", ctrlKey: true }, { key: "g", metaKey: true }]],
    ["linux", { key: "F3" }, { key: "F3", shiftKey: true }, [{ key: "g", ctrlKey: true }]],
  ] as const)("finds again from the document on %s while the bar has a query", (platform, next, previous, others) => {
    vi.stubGlobal("dohcDesktop", { platform });
    const editor = new Editor({ extensions: [StarterKit, findReplaceExtension], content: "<p>the cat, the mat, the hat</p>" });
    try {
      const press = (init: KeyboardEventInit) => editor.view.someProp("handleKeyDown", (handle) =>
        handle(editor.view, new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))) ?? false;
      const find = (action: FindReplaceAction) => editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, action));
      const active = () => findReplaceKey.getState(editor.state)?.activeIndex;
      // With the bar closed, the key is left to anything else that wants it.
      expect(press(next)).toBe(false);
      find({ type: "open", replace: false, query: "the" });
      expect(active()).toBe(0);
      expect(press(next)).toBe(true);
      expect(active()).toBe(1);
      press(next);
      press(next);
      expect(active()).toBe(0);
      expect(press(previous)).toBe(true);
      expect(active()).toBe(2);
      for (const other of others) expect(press(other), JSON.stringify(other)).toBe(false);
      expect(active()).toBe(2);
      find({ type: "setQuery", query: "" });
      expect(press(next)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it("matches ⌥⌘F through the keymap's keyCode fallback, where macOS reports ƒ", () => {
    // On macOS, prosemirror-keymap normalizes Mod-Alt-f to Meta-Alt-f.
    const run = vi.fn(() => true);
    const handled = keydownHandler({ "Meta-Alt-f": run })(
      {} as EditorView,
      new KeyboardEvent("keydown", { key: "ƒ", keyCode: 70, metaKey: true, altKey: true }),
    );
    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("Edit > Find on macOS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  // jsdom reports no Mac navigator, so ProseMirror reads Mod as Control here.
  // Find again matches the platform's own ⌘G.
  const KEYS = {
    "editor-find": { key: "f", keyCode: 70, ctrlKey: true },
    "editor-replace": { key: "ƒ", keyCode: 70, ctrlKey: true, altKey: true },
    "find-again-next": { key: "g", metaKey: true },
    "find-again-previous": { key: "G", metaKey: true, shiftKey: true },
  } as const satisfies Record<EditorMenuCommand, KeyboardEventInit>;

  function mount() {
    vi.stubGlobal("dohcDesktop", { platform: "darwin" });
    const element = document.body.appendChild(document.createElement("div"));
    const editor = new Editor({ element, extensions: [StarterKit, findReplaceExtension], content: "<p>the cat, the mat, the hat</p>" });
    const actions: FindReplaceAction["type"][] = [];
    editor.on("transaction", ({ transaction }) => {
      const action = transaction.getMeta(findReplaceKey) as FindReplaceAction | undefined;
      if (action) actions.push(action.type);
    });
    const find = (action: FindReplaceAction) => editor.view.dispatch(editor.state.tr.setMeta(findReplaceKey, action));
    const press = (command: EditorMenuCommand) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...KEYS[command] });
      editor.view.dom.dispatchEvent(event);
      return event;
    };
    return { editor, actions, find, press };
  }

  it.each(EDITOR_MENU_COMMANDS)("runs %s as its key runs it", (command) => {
    const byKey = mount();
    const byMenu = mount();
    try {
      // Find again steps through an open search.
      if (command.startsWith("find-again")) {
        for (const { find } of [byKey, byMenu]) find({ type: "open", replace: false, query: "the" });
      }
      expect(byKey.press(command).defaultPrevented).toBe(true);
      expect(runFindCommand(byMenu.editor, command)).toBe(true);
      expect(byKey.actions.at(-1)).toBe({ "editor-find": "open", "editor-replace": "open", "find-again-next": "next", "find-again-previous": "prev" }[command]);
      expect(byMenu.actions).toEqual(byKey.actions);
      expect(findReplaceKey.getState(byMenu.editor.state)).toEqual(findReplaceKey.getState(byKey.editor.state));
      expect(findReplaceKey.getState(byMenu.editor.state)?.replaceOpen).toBe(command === "editor-replace");
    } finally {
      byKey.editor.destroy();
      byMenu.editor.destroy();
    }
  });

  it("runs each key once: the editor keeps the keys it takes, and the menu gets only the rest", () => {
    const { editor, actions, find, press } = mount();
    const sent: EditorMenuCommand[] = [];
    const menu = buildMenuTemplate({
      isDev: false,
      platform: "darwin",
      sendCommand: (_window, command) => {
        if (!isEditorMenuCommand(command)) throw new Error(`Unexpected menu command: ${command}`);
        sent.push(command);
        runFindCommand(editor, command);
      },
      stepZoom: vi.fn(),
      showAbout: vi.fn(),
    });
    const edit = menu.find((entry) => entry.label === "Edit")!.submenu as MenuItemConstructorOptions[];
    const findItems = edit.find((entry) => entry.label === "Find")!.submenu as MenuItemConstructorOptions[];
    // macOS offers a key to the menu only when the page leaves it unhandled.
    const type = (command: EditorMenuCommand) => {
      actions.length = 0;
      sent.length = 0;
      if (!press(command).defaultPrevented) {
        const item = findItems.find((entry) => entry.accelerator === shortcutAccelerators(command, "darwin")[0])!;
        (item.click as (item: unknown, window: unknown) => void)(undefined, undefined);
      }
      return { actions: [...actions], sent: [...sent] };
    };
    try {
      // With no search open, find again reaches the menu, which finds nothing.
      expect(type("find-again-next")).toEqual({ actions: [], sent: ["find-again-next"] });
      expect(type("editor-find")).toEqual({ actions: ["open"], sent: [] });
      find({ type: "setQuery", query: "the" });
      expect(type("find-again-next")).toEqual({ actions: ["next"], sent: [] });
      expect(type("find-again-previous")).toEqual({ actions: ["prev"], sent: [] });
      expect(type("editor-replace")).toEqual({ actions: ["open"], sent: [] });
      expect(findReplaceKey.getState(editor.state)).toMatchObject({ open: true, replaceOpen: true, activeIndex: 0 });
    } finally {
      editor.destroy();
    }
  });
});
