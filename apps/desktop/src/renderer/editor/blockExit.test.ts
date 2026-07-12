// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { NodeSelection } from "@tiptap/pm/state";
import type { Dispatch, SetStateAction } from "react";
import { dohcMarkdownExtensions } from "./extensions";
import { makeBlockExitPlugin } from "./blockExit";
import { makeCodeBlockContinuationPlugin } from "./codeBlockChrome";
import { makeCalloutChromePlugin } from "./calloutChrome";
import {
  CLOSED_SLASH_COMMAND_STATE,
  makeSlashCommandPlugin,
  type SlashCommandState,
} from "./slashCommands";

// Shared across editors; reset per makeEditor (tests build one editor each).
const slashStateRef: { current: SlashCommandState } = {
  current: CLOSED_SLASH_COMMAND_STATE,
};
const applySlashState: Dispatch<SetStateAction<SlashCommandState>> = (next) => {
  slashStateRef.current =
    typeof next === "function" ? next(slashStateRef.current) : next;
};

// Mirrors MarkdownEditor's dohcDecorations plugin order: the slash-command
// plugin sees keys BEFORE the block-exit plugin (menu navigation wins), and
// the whole set runs before StarterKit's keymaps (Mod-Enter beats HardBreak).
const testChrome = Extension.create({
  name: "testBlockExitChrome",
  addProseMirrorPlugins() {
    return [
      makeSlashCommandPlugin({
        stateRef: slashStateRef,
        setState: applySlashState,
        runCommandRef: { current: () => {} },
      }),
      makeCodeBlockContinuationPlugin(),
      makeBlockExitPlugin(),
      makeCalloutChromePlugin(),
    ];
  },
});

const editors: Editor[] = [];
const mounts: HTMLElement[] = [];

function makeEditor(markdown: string): Editor {
  slashStateRef.current = CLOSED_SLASH_COMMAND_STATE;
  const element = document.createElement("div");
  document.body.appendChild(element);
  mounts.push(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      ...dohcMarkdownExtensions,
      TaskList,
      TaskItem,
      TableKit.configure({ table: { resizable: true } }),
      Markdown.configure({ indentation: { style: "space", size: 2 } }),
      testChrome,
    ],
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  // Unhandled arrows fall through to gapcursor, whose vertical-motion probe
  // needs client rects jsdom does not implement.
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
  while (editors.length) editors.pop()?.destroy();
  while (mounts.length) mounts.pop()?.remove();
  vi.restoreAllMocks();
});

function press(editor: Editor, init: KeyboardEventInit): void {
  editor.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

function textblockPos(editor: Editor, text: string): { pos: number; size: number } {
  let found: { pos: number; size: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text) {
      found = { pos, size: node.content.size };
    }
  });
  if (!found) throw new Error(`no textblock with text "${text}"`);
  return found;
}

function caretAtEndOf(editor: Editor, text: string): void {
  const { pos, size } = textblockPos(editor, text);
  editor.commands.setTextSelection(pos + 1 + size);
}

function caretAtStartOf(editor: Editor, text: string): void {
  const { pos } = textblockPos(editor, text);
  editor.commands.setTextSelection(pos + 1);
}

function selectedNodeName(editor: Editor): string | null {
  const selection = editor.state.selection;
  return selection instanceof NodeSelection ? selection.node.type.name : null;
}

function topLevelTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.forEach((node) => types.push(node.type.name));
  return types;
}

describe("blockExit Mod-Enter escape", () => {
  it("exits a callout into a paragraph below instead of inserting a hard break", () => {
    const editor = makeEditor("> [!note] Title\n> hello");
    editor.commands.focus("end");

    press(editor, { key: "Enter", ctrlKey: true });

    expect(topLevelTypes(editor)).toEqual(["callout", "paragraph"]);
    expect(editor.state.doc.toString()).not.toContain("hardBreak");
    // Caret sits in the new paragraph, ready to type.
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.depth).toBe(1);
  });

  it("keeps HardBreak's Mod-Enter in a top-level paragraph", () => {
    const editor = makeEditor("hello");
    editor.commands.focus("end");

    press(editor, { key: "Enter", ctrlKey: true });

    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
    expect(editor.state.doc.toString()).toContain("hardBreak");
  });

  it("exits a table cell into a paragraph below the table", () => {
    const editor = makeEditor("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(topLevelTypes(editor)).toEqual(["table"]);
    editor.commands.focus("end");

    press(editor, { key: "Enter", ctrlKey: true });

    expect(topLevelTypes(editor)).toEqual(["table", "paragraph"]);
    expect(editor.state.selection.$from.depth).toBe(1);
  });

  it("reuses an existing empty paragraph below instead of stacking new ones", () => {
    const editor = makeEditor("> [!note] Title\n> hello");
    editor.commands.focus("end");

    press(editor, { key: "Enter", ctrlKey: true });
    caretAtEndOf(editor, "hello");
    press(editor, { key: "Enter", ctrlKey: true });

    expect(topLevelTypes(editor)).toEqual(["callout", "paragraph"]);
  });

  it("escapes a NodeSelection on a math block into a paragraph after it", () => {
    const editor = makeEditor("$$x^2$$");
    editor.commands.setNodeSelection(0);

    press(editor, { key: "Enter", ctrlKey: true });

    expect(topLevelTypes(editor)).toEqual(["mathBlock", "paragraph"]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });
});

describe("blockExit ArrowDown at document end", () => {
  it("creates a paragraph below a doc-terminal callout", () => {
    const editor = makeEditor("> [!note] Title\n> hello");
    editor.commands.focus("end");

    press(editor, { key: "ArrowDown" });

    expect(topLevelTypes(editor)).toEqual(["callout", "paragraph"]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.depth).toBe(1);
  });

  it("creates a paragraph below a doc-terminal query block", () => {
    const editor = makeEditor("```dohc-query\nselect x\n```");
    editor.commands.focus("end");

    press(editor, { key: "ArrowDown" });

    expect(topLevelTypes(editor)).toEqual(["queryBlock", "paragraph"]);
  });

  it("creates a paragraph below a doc-terminal table from its last cell", () => {
    const editor = makeEditor("| a | b |\n| --- | --- |\n| 1 | 2 |");
    editor.commands.focus("end");

    press(editor, { key: "ArrowDown" });

    expect(topLevelTypes(editor)).toEqual(["table", "paragraph"]);
  });

  it("does not mutate the doc when content follows the callout", () => {
    const editor = makeEditor("> [!note] Title\n> hello\n\nafter");
    caretAtEndOf(editor, "hello");
    const before = editor.getJSON();

    press(editor, { key: "ArrowDown" });

    expect(editor.getJSON()).toEqual(before);
  });

  it("does not append below a doc-terminal top-level paragraph", () => {
    const editor = makeEditor("hello");
    editor.commands.focus("end");
    const before = editor.getJSON();

    press(editor, { key: "ArrowDown" });

    expect(editor.getJSON()).toEqual(before);
  });

  it("yields to slash-menu navigation while the menu is open", () => {
    const editor = makeEditor("> [!note] Title\n> hello");
    editor.commands.focus("end");
    editor.commands.insertContent(" /hea");
    expect(slashStateRef.current.open).toBe(true);
    const before = editor.getJSON();

    press(editor, { key: "ArrowDown" });

    // The menu consumed the key: selection moved in the menu, doc untouched.
    expect(editor.getJSON()).toEqual(before);
    expect(slashStateRef.current.open && slashStateRef.current.selected).toBe(1);
  });
});

describe("blockExit folded callout (toggle) guards", () => {
  it("ArrowDown from above selects the folded callout instead of hiding the caret", () => {
    const editor = makeEditor("before\n\n> [!note]- Title\n> hidden");
    caretAtEndOf(editor, "before");

    press(editor, { key: "ArrowDown" });

    expect(selectedNodeName(editor)).toBe("callout");
  });

  it("ArrowUp from below selects the folded callout", () => {
    const editor = makeEditor("> [!note]- Title\n> hidden\n\nafter");
    caretAtStartOf(editor, "after");

    press(editor, { key: "ArrowUp" });

    expect(selectedNodeName(editor)).toBe("callout");
  });

  it("Backspace after a folded callout selects it; a second Backspace deletes it", () => {
    const editor = makeEditor("> [!note]- Title\n> hidden\n\nafter");
    caretAtStartOf(editor, "after");
    const before = editor.getJSON();

    press(editor, { key: "Backspace" });

    // First press: nothing joined into the hidden body, callout selected.
    expect(editor.getJSON()).toEqual(before);
    expect(selectedNodeName(editor)).toBe("callout");

    press(editor, { key: "Backspace" });

    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
    expect(editor.state.doc.textContent).toBe("after");
  });

  it("Backspace after an UNfolded callout keeps the default join into its body", () => {
    const editor = makeEditor("> [!note] Title\n> body\n\nafter");
    caretAtStartOf(editor, "after");

    press(editor, { key: "Backspace" });

    expect(selectedNodeName(editor)).toBeNull();
    expect(topLevelTypes(editor)).toEqual(["callout"]);
  });

  it("Delete before a folded callout selects it instead of pulling hidden content up", () => {
    const editor = makeEditor("before\n\n> [!note]- Title\n> hidden");
    caretAtEndOf(editor, "before");
    const before = editor.getJSON();

    press(editor, { key: "Delete" });

    expect(editor.getJSON()).toEqual(before);
    expect(selectedNodeName(editor)).toBe("callout");
  });

  it("does not intercept arrows around unfolded callouts", () => {
    const editor = makeEditor("before\n\n> [!note] Title\n> body");
    caretAtEndOf(editor, "before");

    press(editor, { key: "ArrowDown" });

    expect(selectedNodeName(editor)).toBeNull();
  });
});

// These lock the DEFAULT escape/delete paths the fixes above build on — if a
// future extension swallows them, callouts become traps again.
describe("blockExit locked defaults", () => {
  it("Enter on the empty last child lifts out of the callout", () => {
    const editor = makeEditor("> [!note] Title\n> hello");
    editor.commands.focus("end");

    press(editor, { key: "Enter" });
    press(editor, { key: "Enter" });

    expect(topLevelTypes(editor)).toEqual(["callout", "paragraph"]);
    expect(editor.state.doc.firstChild?.childCount).toBe(1);
  });

  it("Backspace in an empty callout removes it", () => {
    const editor = makeEditor("before\n\n> [!note] Title");
    editor.commands.focus("end");

    press(editor, { key: "Backspace" });

    expect(topLevelTypes(editor)).toEqual(["paragraph", "paragraph"]);
  });

  it("Enter on a NodeSelection over a math block creates a paragraph after it", () => {
    const editor = makeEditor("$$x^2$$");
    editor.commands.setNodeSelection(0);

    press(editor, { key: "Enter" });

    expect(topLevelTypes(editor)).toEqual(["mathBlock", "paragraph"]);
  });

  it("Backspace in an emptied query block turns it back into a paragraph", () => {
    const editor = makeEditor("```dohc-query\nx\n```");
    editor.commands.command(({ tr, dispatch }) => {
      if (dispatch) dispatch(tr.delete(1, 2));
      return true;
    });
    editor.commands.setTextSelection(1);

    press(editor, { key: "Backspace" });

    expect(topLevelTypes(editor)).toEqual(["paragraph"]);
  });
});
