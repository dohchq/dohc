// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor, Extension } from "@tiptap/core";
import { addColumnAfter, addRowAfter, cellAround, CellSelection } from "@tiptap/pm/tables";
import { dropPoint } from "@tiptap/pm/transform";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  MarkdownBulletList,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import {
  createBodySequenceHistory,
  isBodySequenceChange,
} from "@dohc/ydoc-projection/body-sequence-editor";
import { isUnevenTable } from "@dohc/ydoc-projection/body-sequence-tables";
import { BodySequence } from "@dohc/ydoc-projection/body-sequence-tiptap";
import {
  boundary,
  element,
  exchange,
  LINES,
  note,
  noteOf,
  onStop,
  page,
  person,
  quiet,
  raceTests,
  stopEveryone,
  withEditor,
  type Page,
} from "@dohc/ydoc-projection/body-sequence-testing";
import { lookupEmoji, makeEmojiPlugin } from "./emojiTrigger";
import { desktopMarkdownExtensions } from "./extensions";
import { ListConversions } from "./listEditing";

afterEach(stopEveryone);

beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
});

const BOUNDARY = { ...quiet(), boundaries: 1, attributes: 2 };

const EmojiTrigger = Extension.create({
  name: "emojiTrigger",
  addProseMirrorPlugins: () => [makeEmojiPlugin(() => {})],
});

function desktop(baseline: Uint8Array, clientID: number) {
  return desktopOn(page(baseline, clientID));
}

function desktopOn(base: Page, shared?: Y.UndoManager) {
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const history = shared ?? createBodySequenceHistory(base.doc, { captureTimeout: 0 });
  const shown = { count: 0 };
  const editor = new Editor({
    element,
    extensions: [
      ...desktopMarkdownExtensions,
      StarterKit.configure({
        trailingNode: false,
        undoRedo: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      ListConversions,
      MarkdownBulletList,
      MarkdownListItem,
      MarkdownOrderedList,
      MarkdownTaskList,
      DohcTaskItem,
      TableKit.configure({ table: false }),
      DohcMarkdownTable,
      EmojiTrigger,
      BodySequence.configure({ sequence: base.sequence, containers: base.containers, history }),
    ],
    onTransaction({ transaction }) {
      if (isBodySequenceChange(transaction)) shown.count += 1;
    },
  });
  onStop(() => {
    editor.destroy();
    if (!shared) history.destroy();
    element.remove();
  });
  const seat = withEditor({ ...base, view: editor.view, history, shown });
  return {
    ...seat,
    editor,
    type(letters: string) {
      for (const letter of letters) {
        const { from, to } = editor.view.state.selection;
        const handled = editor.view.someProp("handleTextInput", (handle) =>
          handle(editor.view, from, to, letter, () => editor.view.state.tr.insertText(letter)),
        );
        if (!handled) editor.view.dispatch(editor.view.state.tr.insertText(letter));
      }
    },
  };
}

describe("a plain editor and a Tiptap editor racing", () => {
  raceTests((baseline, at) => (at === 1 ? desktop(baseline, 20) : person(baseline, 10 * (at + 1))));
});

describe("a Tiptap editor and a plain editor racing", () => {
  raceTests((baseline, at) => (at === 1 ? person(baseline, 20) : desktop(baseline, 10 * (at + 1))));
});

describe("what one Tiptap change does to the items of the sequence", () => {
  it("deletes one boundary for Backspace at the start of a line, and inserts one for Enter", () => {
    const a = desktop(note(...LINES), 10);
    const lower = a.boundaryIds()[1]!;
    const joined = a.effects(() => a.join(1));
    expect(joined).toEqual({
      made: quiet(),
      gone: BOUNDARY,
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [lower],
      madeBoundaries: [],
      shown: 0,
    });
    const split = a.effects(() => a.split(0, 7));
    expect(split).toMatchObject({
      made: BOUNDARY,
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.lines()).toEqual(LINES);
    a.expectMirror();
  });

  it("leaves the old boundary with the text for Enter at the start of a line, a heading too", () => {
    const a = desktop(note(...LINES), 10);
    const [first, second, third] = a.boundaryIds();
    const split = a.effects(() => a.split(1, 0));
    expect(split).toMatchObject({
      made: BOUNDARY,
      gone: quiet(),
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.boundaryLines()).toEqual([
      { id: first, text: "One one" },
      { id: split.madeBoundaries[0], text: "" },
      { id: second, text: "Two two two" },
      { id: third, text: "Three" },
    ]);
    a.select([3, 0]);
    a.editor.commands.setHeading({ level: 2 });
    const above = a.effects(() => a.split(3, 0));
    expect(above.gone.boundaries).toBe(0);
    expect(a.boundaryLines().slice(3)).toEqual([
      { id: above.madeBoundaries[0], text: "" },
      { id: third, text: "Three" },
    ]);
    expect(a.blocks().slice(3)).toEqual(["paragraph", "h2"]);
    a.expectMirror();
  });

  it("changes formatting only for the bold command, and attributes only for the heading command", () => {
    const a = desktop(note(...LINES), 10);
    a.select([0, 4], [1, 3]);
    const bold = a.effects(() => a.editor.commands.toggleBold());
    expect(bold).toMatchObject({
      made: { ...quiet(), formats: 2 },
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.lettersMarked("bold")).toBe("oneTwo");
    a.select([2, 1]);
    const heading = a.effects(() => a.editor.commands.toggleHeading({ level: 2 }));
    expect(heading).toMatchObject({
      made: { ...quiet(), attributes: 2 },
      gone: { ...quiet(), attributes: 1 },
      other: 0,
      goneBoundaries: [],
      madeBoundaries: [],
    });
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "h2"]);
    a.expectMirror();
  });

  it("deletes the typed marker and changes attributes for the heading input rule", () => {
    const a = desktop(note(...LINES), 10);
    a.select([1, 0]);
    a.type("##");
    const effects = a.effects(() => a.type(" "));
    expect(effects.made).toEqual({ ...quiet(), attributes: 2 });
    expect(effects.gone).toEqual({ ...quiet(), letters: 2, attributes: 1 });
    expect(effects.goneLetters).toBe("##");
    expect(effects.goneBoundaries).toEqual([]);
    expect(a.blocks()).toEqual(["paragraph", "h2", "paragraph"]);
    expect(a.lines()).toEqual(LINES);
    a.expectMirror();
  });

  it("keeps the letters between the markers of the bold input rule", () => {
    const a = desktop(note("One", ""), 10);
    a.select([1, 0]);
    const effects = a.effects(() => a.type("**bold**"));
    expect(a.lines()).toEqual(["One", "bold"]);
    expect(a.lettersMarked("bold")).toBe("bold");
    expect(effects.madeLetters).toBe("bold");
    a.expectMirror();
  });

  it("undoes and redoes through the Tiptap commands, with one transaction each, also chained after focus as the app's paste offer chains it", () => {
    const a = desktop(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.typeAt(0, 7, "!");
    b.typeAt(2, 5, "?");
    exchange(a, b);
    const seen: boolean[] = [];
    a.editor.on("transaction", ({ transaction }) => seen.push(isBodySequenceChange(transaction)));
    expect(a.editor.can().undo()).toBe(true);
    expect(seen).toEqual([]);
    expect(a.editor.commands.undo()).toBe(true);
    expect(seen).toEqual([true]);
    expect(a.editor.commands.undo()).toBe(false);
    expect(a.editor.can().undo()).toBe(false);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one", "Two two two", "Three?"]);
    expect(a.editor.commands.redo()).toBe(true);
    expect(seen).toEqual([true, true]);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    expect(a.press("z", { ctrlKey: true })).toBe(true);
    expect(a.press("y", { ctrlKey: true })).toBe(true);
    expect(a.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    expect(a.editor.chain().focus().undo().run()).toBe(true);
    expect(seen).toHaveLength(5);
    expect(seen.every((shows) => shows)).toBe(true);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one", "Two two two", "Three?"]);
    a.expectMirror();
    b.expectMirror();
  });

  it("gives text before the first boundary its boundary in a change of its own, which the undo command leaves", () => {
    const head = () =>
      noteOf(({ sequence }) => {
        sequence.insert(0, "hh", {});
        sequence.insertEmbed(2, boundary(), {});
        sequence.insert(3, "ab", {});
      });
    const a = desktop(head(), 10);
    const b = person(head(), 20);
    const [ab] = a.boundaryIds();
    a.select([0, 1]);
    expect(a.editor.commands.setHeading({ level: 2 })).toBe(true);
    expect(a.blocks()).toEqual(["h2", "paragraph"]);
    expect(a.sent).toHaveLength(2);
    expect(a.history.undoStack).toHaveLength(1);
    const [given] = a.boundaryIds();
    exchange(a, b);
    b.typeAt(0, 0, "B");
    exchange(b, a);
    expect(a.editor.commands.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.blocks()).toEqual(["paragraph", "paragraph"]);
      expect(each.boundaryLines()).toEqual([
        { id: given, text: "Bhh" },
        { id: ab, text: "ab" },
      ]);
    }
    expect(a.editor.commands.undo()).toBe(false);
  });

  it("refuses a list, which this step does not write yet", () => {
    const a = desktop(note(...LINES), 10);
    a.select([1, 0]);
    a.editor.commands.toggleBulletList();
    a.type("- ");
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(a.view.state.doc.childCount).toBe(3);
    a.expectMirror();
  });
});

describe("the desktop's commands next to a line with no boundary of its own", () => {
  const WIKILINK = () => element("wikilink", { target: "Page", label: null });
  const codeThenTextItCannotHold = () =>
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "codeBlock", language: null }), {});
      sequence.insert(1, "ab", {});
      sequence.insertEmbed(3, WIKILINK(), {});
      sequence.insert(4, "cd", {});
    });
  const mathThenText = () =>
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "mathBlock", tex: "a+b" }), {});
      sequence.insert(1, "spilled text", {});
    });

  it("sends one change for a code block's new language, and gives the paragraph after the code no boundary", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab"), paragraph(wikilink, "cd"))');
    a.select([0, 1]);
    const effects = a.effects(() =>
      a.editor.commands.updateAttributes("codeBlock", { language: "js" }),
    );
    expect(a.view.state.doc.child(0).attrs.language).toBe("js");
    expect(a.sent).toHaveLength(1);
    expect(effects.madeBoundaries).toEqual([]);
    a.expectMirror();
  });

  it("sends one change for a math block's new TeX, and gives the paragraph after it no boundary", () => {
    const a = desktop(mathThenText(), 10);
    expect(a.view.state.doc.toString()).toBe('doc(mathBlock, paragraph("spilled text"))');
    const effects = a.effects(() =>
      a.view.dispatch(a.view.state.tr.setNodeMarkup(0, undefined, { tex: "a+b+c" })),
    );
    expect(a.view.state.doc.child(0).attrs.tex).toBe("a+b+c");
    expect(a.sent).toHaveLength(1);
    expect(effects.madeBoundaries).toEqual([]);
    a.expectMirror();
  });

  it("gives the paragraph after a code block its boundary first when setHorizontalRule replaces a selection in the code, so a letter typed at that paragraph's start stays there when the divider is undone", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    a.select([0, 1], [0, 2]);
    expect(a.editor.commands.setHorizontalRule()).toBe(true);
    expect(a.view.state.doc.toString()).toBe(
      'doc(codeBlock("a"), horizontalRule, paragraph(wikilink, "cd"))',
    );
    expect(a.sent).toHaveLength(2);
    exchange(a, b);
    b.typeAt(2, 0, "P");
    exchange(b, a);
    expect(a.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("P", wikilink, "cd"))',
      );
    }
  });

  it.each([
    [
      "text before the first boundary",
      () =>
        noteOf(({ sequence }) => {
          sequence.insert(0, "ab", {});
          sequence.insertEmbed(2, boundary(), {});
          sequence.insert(3, "cd", {});
        }),
      0,
      ["h2", "paragraph", "paragraph"],
    ],
    [
      "the paragraph after a math block",
      () =>
        noteOf(({ sequence }) => {
          sequence.insertEmbed(0, boundary({ type: "mathBlock", tex: "x" }), {});
          sequence.insert(1, "ab", {});
          sequence.insertEmbed(3, boundary(), {});
          sequence.insert(4, "cd", {});
        }),
      1,
      ["mathBlock", "h2", "paragraph", "paragraph"],
    ],
  ] as const)(
    "stores the heading that insertContent puts over %s and into the next line",
    (_name, lines, line, blocks) => {
      const a = desktop(lines(), 10);
      const before = a.view.state.doc.toJSON();
      a.select([line, 0], [line + 1, 1]);
      expect(a.editor.commands.insertContent("<h2>X</h2><p>Y</p>")).toBe(true);
      expect(a.blocks()).toEqual(blocks);
      expect(a.lines().slice(-3)).toEqual(["X", "Y", "d"]);
      a.expectMirror();
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      a.expectMirror();
    },
  );

  it("gives the paragraph after a code block its boundary first when setHorizontalRule replaces a selection that runs from the code to that paragraph's start, so a letter typed there stays there when the divider is undone", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    a.select([0, 1], [1, 0]);
    expect(a.editor.commands.setHorizontalRule()).toBe(true);
    expect(a.view.state.doc.toString()).toBe(
      'doc(codeBlock("a"), horizontalRule, paragraph(wikilink, "cd"))',
    );
    expect(a.sent).toHaveLength(2);
    exchange(a, b);
    b.typeAt(2, 0, "P");
    exchange(b, a);
    expect(a.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("P", wikilink, "cd"))',
      );
    }
  });

  it("writes no boundary for the paragraph after a code block when Backspace deletes a selection that runs from the code to that paragraph's start, so a letter typed there stays there when the delete is undone", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    a.select([0, 1], [1, 0]);
    const effects = a.effects(() => a.press("Backspace"));
    expect(a.view.state.doc.toString()).toBe('doc(codeBlock("a"), paragraph(wikilink, "cd"))');
    expect(a.sent).toHaveLength(1);
    expect(effects.madeBoundaries).toEqual([]);
    exchange(a, b);
    b.typeAt(1, 0, "P");
    exchange(b, a);
    expect(a.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("P", wikilink, "cd"))',
      );
    }
  });

  it("records no boundary for the paragraph after a code block when a letter is typed over a selection that runs from the code to that paragraph's start, so a letter someone else types there stays there when the change is undone", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    a.select([0, 1], [1, 0]);
    const effects = a.effects(() => a.type("Z"));
    expect(a.view.state.doc.toString()).toBe('doc(codeBlock("aZ"), paragraph(wikilink, "cd"))');
    expect(effects.madeBoundaries).toEqual([]);
    exchange(a, b);
    b.typeAt(1, 0, "P");
    exchange(b, a);
    expect(a.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("P", wikilink, "cd"))',
      );
    }
  });

  it("keeps the code block's boundary when insertContent puts a code block over a selection from its start to the start of the paragraph after it, so a language someone else gives it at the same moment stays", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    const [code] = a.boundaryIds();
    a.select([0, 0], [1, 0]);
    const effects = a.effects(() => a.editor.commands.insertContent("<pre><code>X</code></pre>"));
    expect(a.view.state.doc.toString()).toBe('doc(codeBlock("X"), paragraph(wikilink, "cd"))');
    expect(effects.goneBoundaries).toEqual([]);
    expect(a.boundaryIds()).toEqual([code]);
    b.view.dispatch(b.view.state.tr.setNodeMarkup(0, undefined, { language: "js" }));
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe('doc(codeBlock("X"), paragraph(wikilink, "cd"))');
      expect(each.view.state.doc.child(0).attrs.language).toBe("js");
    }
  });

  it.each([
    ["Backspace deletes", (a: ReturnType<typeof desktop>) => a.press("Backspace"), "a"],
    ["a typed letter replaces", (a: ReturnType<typeof desktop>) => a.type("Z"), "aZ"],
  ] as const)(
    "gives the paragraph after a code block its boundary first when %s a selection that ends in it and it stays a paragraph, so it is still the heading someone else made it when the change is undone",
    (_name, act, code) => {
      const codeThenAParagraphItKeeps = () =>
        noteOf(({ sequence }) => {
          sequence.insertEmbed(0, boundary({ type: "codeBlock", language: null }), {});
          sequence.insert(1, "ab", {});
          sequence.insertEmbed(3, WIKILINK(), {});
          sequence.insert(4, "x", {});
          sequence.insertEmbed(5, element("hardBreak", {}), {});
        });
      const a = desktop(codeThenAParagraphItKeeps(), 10);
      const b = person(codeThenAParagraphItKeeps(), 20);
      a.select([0, 1], [1, 1]);
      act(a);
      expect(a.view.state.doc.toString()).toBe(
        `doc(codeBlock("${code}"), paragraph("x", hardBreak))`,
      );
      a.expectMirror();
      expect(a.sent).toHaveLength(2);
      exchange(a, b);
      b.select([1, 0]);
      expect(b.retype("heading", { level: 3 })).toBe(true);
      exchange(b, a);
      expect(a.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), heading(wikilink, "x", hardBreak))',
        );
      }
    },
  );

  const underCode = () =>
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary(), {});
      sequence.insert(1, "ab", {});
      sequence.insertEmbed(3, boundary({ type: "codeBlock", language: null }), {});
      sequence.insert(4, "cd", {});
      sequence.insertEmbed(6, WIKILINK(), {});
      sequence.insert(7, "ef", {});
      sequence.insertEmbed(9, boundary(), {});
      sequence.insert(10, "gh", {});
    });

  it("writes Enter over a selection from the line above across a code block into the paragraph after it: that paragraph gets its boundary first and keeps it, and the heading someone else then makes it stays when the Enter is undone", () => {
    const a = desktop(underCode(), 10);
    const b = person(underCode(), 20);
    a.select([0, 1], [2, 1]);
    const effects = a.effects(() => expect(a.press("Enter")).toBe(true));
    expect(a.view.state.doc.toString()).toBe(
      'doc(paragraph("a"), paragraph("ef"), paragraph("gh"))',
    );
    expect(a.sent).toHaveLength(2);
    expect(effects.madeBoundaries).toHaveLength(1);
    expect(effects.madeLetters).toBe("");
    a.expectMirror();
    exchange(a, b);
    b.typeAt(1, 0, "P");
    b.select([1, 0]);
    expect(b.retype("heading", { level: 3 })).toBe(true);
    exchange(b, a);
    expect(a.editor.commands.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(paragraph("ab"), codeBlock("cd"), heading(wikilink, "Pef"), paragraph("gh"))',
      );
    }
  });

  it.each([
    ["P", 'heading("P"), paragraph(wikilink, "ef")'],
    ["", 'heading, paragraph(wikilink, "ef")'],
  ])(
    "leaves the heading someone else makes that paragraph, with %j typed at its start, above the paragraph's text when client 20 presses that Enter, client 10 has not got it, and the Enter is undone: the other's boundary comes first (a known behaviour)",
    (typed, twoBlocks) => {
      const a = desktop(underCode(), 20);
      const b = person(underCode(), 10);
      a.select([0, 1], [2, 0]);
      expect(a.press("Enter")).toBe(true);
      if (typed) b.typeAt(2, 0, typed);
      b.select([2, 0]);
      expect(b.retype("heading", { level: 3 })).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          `doc(paragraph("a"), ${twoBlocks}, paragraph("gh"))`,
        );
      }
      expect(a.editor.commands.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          `doc(paragraph("ab"), codeBlock("cd"), ${twoBlocks}, paragraph("gh"))`,
        );
      }
    },
  );

  it("writes nothing when text dragged from the line above across a code block to the start of the paragraph after it is dropped in the line above, where that paragraph would be joined away and split off again under a boundary undo takes away; it is still the heading someone else then makes it", () => {
    const a = desktop(underCode(), 10);
    const b = person(underCode(), 20);
    const read =
      'doc(paragraph("ab"), codeBlock("cd"), paragraph(wikilink, "ef"), paragraph("gh"))';
    expect(a.view.state.doc.toString()).toBe(read);
    a.select([0, 2], [2, 0]);
    const { state } = a.view;
    const slice = state.selection.content();
    const dropped = state.tr.deleteSelection();
    const at = dropped.mapping.map(dropPoint(state.doc, 2, slice) ?? 2);
    a.view.dispatch(dropped.replaceRange(at, at, slice));
    expect(a.sent).toEqual([]);
    expect(a.view.state.doc.toString()).toBe(read);
    expect(a.view.state.selection.toJSON()).toEqual(state.selection.toJSON());
    a.expectMirror();
    b.typeAt(2, 0, "P");
    b.select([2, 0]);
    expect(b.retype("heading", { level: 3 })).toBe(true);
    exchange(b, a);
    a.undo();
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(paragraph("ab"), codeBlock("cd"), heading("P", wikilink, "ef"), paragraph("gh"))',
      );
    }
  });

  it("gives setHorizontalRule's divider a boundary of its own when the selection runs to the end of the next line, so it is still a divider when someone else makes that line a heading at the same moment", () => {
    const a = desktop(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    const [, second] = a.boundaryIds();
    a.select([0, LINES[0]!.length], [1, LINES[1]!.length]);
    const effects = a.effects(() => a.editor.commands.setHorizontalRule());
    expect(a.blocks()).toEqual(["paragraph", "horizontalRule", "paragraph"]);
    expect(effects.goneBoundaries).toEqual([second]);
    expect(effects.madeBoundaries).toHaveLength(1);
    b.select([1, 0]);
    b.retype("heading", { level: 2 });
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.blocks()).toEqual(["paragraph", "horizontalRule", "paragraph"]);
      expect(each.lines()).toEqual(["One one", "", "Three"]);
    }
  });

  it("puts setHorizontalRule's divider in front of a line's own boundary when the caret is at the line's start, so the line is still the heading someone else made it at the same moment", () => {
    const a = desktop(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    const [first, second, third] = a.boundaryIds();
    a.select([1, 0]);
    const effects = a.effects(() => a.editor.commands.setHorizontalRule());
    expect(effects.goneBoundaries).toEqual([]);
    expect(effects.madeBoundaries).toHaveLength(1);
    expect(a.boundaryIds()).toEqual([first, effects.madeBoundaries[0], second, third]);
    b.select([1, 0]);
    b.retype("heading", { level: 2 });
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.blocks()).toEqual(["paragraph", "horizontalRule", "h2", "paragraph"]);
      expect(each.lines()).toEqual(["One one", "", "Two two two", "Three"]);
    }
  });
});

describe("the desktop editor's own plugins, which add to a change", () => {
  const ADDRESS = "https://example.com";
  const twoPanes = (line: string) => {
    const base = page(note(line), 10);
    const history = createBodySequenceHistory(base.doc, { captureTimeout: 0 });
    onStop(() => history.destroy());
    return { base, first: desktopOn(base, history), second: desktopOn(base, history) };
  };

  it("write no link when a pane shows an address a peer typed, also a pane nobody can edit", () => {
    const { base, first, second } = twoPanes("see ");
    second.editor.setEditable(false);
    const peer = person(note("see "), 20);
    peer.typeAt(0, 4, `${ADDRESS} and`);
    exchange(peer, base);
    expect(base.sent).toEqual([]);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual([`see ${ADDRESS} and`]);
    }
    expect(first.lettersMarked("link")).toBe("");
  });

  it("still link an address the person types, once, and show it in the other pane", () => {
    const { first, second } = twoPanes("see ");
    first.select([0, 4]);
    first.type(`${ADDRESS} `);
    expect(first.lettersMarked("link")).toBe(ADDRESS);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual([`see ${ADDRESS} `]);
    }
  });

  it("expand no shortcode when a peer makes one bold just before the caret", () => {
    const a = desktop(note("say :smile:"), 10);
    const b = person(note("say :smile:"), 20);
    a.select([0, 11]);
    b.select([0, 4], [0, 11]);
    b.toggle("bold");
    exchange(b, a);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(["say :smile:"]);
    expect(a.lettersMarked("bold")).toBe(":smile:");
    a.expectMirror();
  });

  it("still expand a shortcode the person types", () => {
    const a = desktop(note("say "), 10);
    a.select([0, 4]);
    a.type(":smile:");
    expect(a.lines()).toEqual([`say ${lookupEmoji("smile")!.emoji}`]);
    a.expectMirror();
  });

  it("share undo between two panes on one note", () => {
    const { first, second } = twoPanes("ab");
    first.typeAt(0, 1, "A");
    second.typeAt(0, 2, "B");
    expect(first.editor.commands.undo()).toBe(true);
    for (const pane of [first, second]) expect(pane.lines()).toEqual(["aAb"]);
    expect(second.editor.commands.undo()).toBe(true);
    for (const pane of [first, second]) expect(pane.lines()).toEqual(["ab"]);
    expect(first.editor.commands.redo()).toBe(true);
    expect(second.editor.commands.redo()).toBe(true);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual(["aABb"]);
    }
  });
});

describe("the desktop editor in a table two people's changes left uneven", () => {
  const unevenTable = () => {
    const first = desktop(note("before"), 10);
    first.select([0, 6]);
    expect(first.editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true })).toBe(true);
    const baseline = Y.encodeStateAsUpdate(first.doc);
    const a = desktop(baseline, 20);
    const b = desktop(baseline, 30);
    a.select([a.lines().length - 2, 0]);
    expect(addRowAfter(a.editor.view.state, a.editor.view.dispatch)).toBe(true);
    b.select([1, 0]);
    expect(addColumnAfter(b.editor.view.state, b.editor.view.dispatch)).toBe(true);
    exchange(a, b);
    const table = a.editor.state.doc.child(1);
    expect(isUnevenTable(table)).toBe(true);
    return a;
  };

  it("adds no row for Tab in the last cell", () => {
    const a = unevenTable();
    const lines = a.lines();
    a.select([lines.length - 1, 0]);
    const tab = new KeyboardEvent("keydown", { key: "Tab" });
    expect(a.editor.view.someProp("handleKeyDown", (handle) => handle(a.editor.view, tab))).toBe(
      true,
    );
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(lines);
    a.expectMirror();
  });

  it("turns a selection of cells into a caret in its head cell", () => {
    const a = unevenTable();
    const { state } = a.editor;
    const cells: number[] = [];
    state.doc.child(1).descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell") cells.push(state.doc.child(0).nodeSize + 1 + pos);
      return node.type.spec.tableRole !== "cell";
    });
    const $anchor = state.doc.resolve(cells[0]!);
    const $head = state.doc.resolve(cells.at(-1)!);
    a.editor.view.dispatch(state.tr.setSelection(new CellSelection($anchor, $head)));
    const { selection } = a.editor.state;
    expect(selection).not.toBeInstanceOf(CellSelection);
    expect(cellAround(selection.$head)?.pos).toBe(cells.at(-1));
    expect(a.sent).toEqual([]);
  });
});
