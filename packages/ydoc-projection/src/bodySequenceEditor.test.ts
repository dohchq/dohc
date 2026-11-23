// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setBlockType } from "@tiptap/pm/commands";
import { Fragment, Mark, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  AllSelection,
  EditorState,
  NodeSelection,
  Plugin,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { BLOCK_ELEMENT, recordsOfContainer } from "./bodySequenceGrammar.js";
import {
  bodySequenceAnchor,
  bodySequenceAnchorPosition,
  createBodySequenceHistory,
  isBodySequenceChange,
  keepBodySequenceFormatting,
} from "./bodySequenceEditor.js";
import { boundaryAt, createBodyReader } from "./bodySequenceReading.js";
import { keepsContainers } from "./bodySequenceWriting.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  boundary,
  declared,
  editorOn,
  element,
  elementsOf,
  exchange,
  LINES,
  note,
  noteOf,
  onStop,
  page,
  person,
  quiet,
  raceTests,
  reconnect,
  schema,
  stopEveryone,
  tokensOf,
  type HostShape,
  type Page,
  type Person,
} from "./bodySequenceTestSupport.js";

afterEach(stopEveryone);

const BOUNDARY = { ...quiet(), boundaries: 1, attributes: 2 };

describe("what one editor change does to the items of the sequence", () => {
  it("deletes one boundary and no letter for Backspace at the start of a line", () => {
    const a = person(note(...LINES), 10);
    const lower = a.boundaryIds()[1]!;
    const effects = a.effects(() => a.join(1));
    expect(effects).toEqual({
      made: quiet(),
      gone: BOUNDARY,
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [lower],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.lines()).toEqual(["One oneTwo two two", "Three"]);
    a.expectMirror();
  });

  it("deletes one boundary and no letter for Delete at the end of a line", () => {
    const a = person(note(...LINES), 10);
    const lower = a.boundaryIds()[1]!;
    a.select([0, 7]);
    const effects = a.effects(() => expect(a.press("Delete")).toBe(true));
    expect(effects).toEqual({
      made: quiet(),
      gone: BOUNDARY,
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [lower],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.lines()).toEqual(["One oneTwo two two", "Three"]);
    a.expectMirror();
  });

  it("deletes the empty upper line's boundary for Backspace below an empty line", () => {
    const a = person(note("One", "", "Three"), 10);
    const [, upper] = a.boundaryIds();
    const effects = a.effects(() => a.join(2));
    expect(effects.gone).toEqual(BOUNDARY);
    expect(effects.made).toEqual(quiet());
    expect(effects.goneBoundaries).toEqual([upper]);
    expect(a.lines()).toEqual(["One", "Three"]);
    a.expectMirror();
  });

  it("inserts one boundary with its type and path, and no letter, for Enter", () => {
    const a = person(note(...LINES), 10);
    const effects = a.effects(() => a.split(1, 4));
    expect(effects).toMatchObject({
      made: BOUNDARY,
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [],
    });
    expect(effects.madeBoundaries).toHaveLength(1);
    const made = tokensOf(a.sequence).find((token) => token.id === effects.madeBoundaries[0]);
    expect(made).toMatchObject({ attrs: '[["path",[]],["type","paragraph"]]' });
    expect(a.lines()).toEqual(["One one", "Two ", "two two", "Three"]);
    a.expectMirror();
  });

  it("leaves the old boundary with the text for Enter at the start of a line that has text", () => {
    const a = person(note(...LINES), 10);
    const [first, second, third] = a.boundaryIds();
    const effects = a.effects(() => a.split(1, 0));
    expect(effects).toMatchObject({ made: BOUNDARY, gone: quiet(), other: 0 });
    const [made] = effects.madeBoundaries;
    expect(a.boundaryLines()).toEqual([
      { id: first, text: "One one" },
      { id: made, text: "" },
      { id: second, text: "Two two two" },
      { id: third, text: "Three" },
    ]);
    a.expectMirror();
  });

  it("puts the new boundary after the old one for Enter in an empty line", () => {
    const a = person(note("One", "", "Three"), 10);
    const [first, second, third] = a.boundaryIds();
    const effects = a.effects(() => a.split(1, 0));
    expect(effects).toMatchObject({ made: BOUNDARY, gone: quiet(), other: 0 });
    expect(a.boundaryIds()).toEqual([first, second, effects.madeBoundaries[0], third]);
    a.expectMirror();
  });

  it("keeps a heading's boundary with its text and gives the new line above its own", () => {
    const a = person(
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary({ type: "heading", level: 2 }), {});
        sequence.insert(1, "Title", {});
      }),
      10,
    );
    const [heading] = a.boundaryIds();
    const effects = a.effects(() => a.split(0, 0));
    expect(effects.gone).toEqual(quiet());
    expect(effects.made.boundaries).toBe(1);
    expect(a.boundaryLines()).toEqual([
      { id: effects.madeBoundaries[0], text: "" },
      { id: heading, text: "Title" },
    ]);
    expect(a.blocks()).toEqual(["paragraph", "h2"]);
    a.expectMirror();
  });

  it("inserts n letters and nothing else for n typed letters", () => {
    const a = person(note(...LINES), 10);
    const effects = a.effects(() => a.typeAt(1, 3, "hello"));
    expect(effects).toEqual({
      made: { ...quiet(), letters: 5 },
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "hello",
      goneBoundaries: [],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.lines()[1]).toBe("Twohello two two");
    a.expectMirror();
  });

  it("changes formatting only when a mark is toggled across lines", () => {
    const a = person(note(...LINES), 10);
    a.select([0, 4], [1, 3]);
    const on = a.effects(() => a.toggle("bold"));
    expect(on).toEqual({
      made: { ...quiet(), formats: 2 },
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.lettersMarked("bold")).toBe("oneTwo");
    a.expectMirror();
    const off = a.effects(() => a.toggle("bold"));
    expect(off).toMatchObject({
      made: quiet(),
      gone: { ...quiet(), formats: 2 },
      other: 0,
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.lettersMarked("bold")).toBe("");
    a.expectMirror();
  });

  it("keeps a link's attributes on the letters it covers", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 0], [1, 3]);
    const effects = a.effects(() => a.mark("link", { href: "https://example.com/a" }));
    expect(effects.made).toEqual({ ...quiet(), formats: 2 });
    exchange(a, b);
    b.expectMirror();
    expect(b.view.state.doc.child(1).firstChild!.marks[0]!.attrs.href).toBe(
      "https://example.com/a",
    );
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
  });

  it("sets attributes on the same boundary for paragraph to heading and back", () => {
    const a = person(note(...LINES), 10);
    const before = a.boundaryIds();
    a.select([1, 2]);
    const up = a.effects(() => a.retype("heading", { level: 2 }));
    expect(up).toEqual({
      made: { ...quiet(), attributes: 2 },
      gone: { ...quiet(), attributes: 1 },
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.blocks()).toEqual(["paragraph", "h2", "paragraph"]);
    a.expectMirror();
    const down = a.effects(() => a.retype("paragraph"));
    expect(down).toMatchObject({
      made: { ...quiet(), attributes: 1 },
      gone: { ...quiet(), attributes: 1 },
      other: 0,
    });
    expect(a.boundaryIds()).toEqual(before);
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "paragraph"]);
    a.expectMirror();
    const again = a.effects(() => a.retype("heading", { level: 2 }));
    expect(again.made).toEqual({ ...quiet(), attributes: 1 });
    const first = a.effects(() => a.retype("heading", { level: 1 }));
    expect(first.made).toEqual({ ...quiet(), attributes: 1 });
    expect(a.blocks()).toEqual(["paragraph", "h1", "paragraph"]);
    expect(a.boundaryIds()).toEqual(before);
    a.expectMirror();
  });

  it("writes every attribute of a kind when a boundary takes it, defaults too", () => {
    const a = person(note(...LINES), 10);
    a.select([0, 0]);
    a.retype("heading", { level: 1 });
    a.select([1, 0]);
    a.retype("codeBlock");
    const [heading, code] = elementsOf(a.sequence, "boundary");
    expect(heading!.attrs).toBe('[["level",1],["path",[]],["type","heading"]]');
    expect(code!.attrs).toBe('[["language",null],["path",[]],["type","codeBlock"]]');
    a.expectMirror();
  });

  it("deletes the selected letters and the boundaries inside a selection across three lines", () => {
    const a = person(note(...LINES), 10);
    const [, second, third] = a.boundaryIds();
    a.select([0, 4], [2, 2]);
    const effects = a.effects(() => expect(a.press("Backspace")).toBe(true));
    expect(effects).toEqual({
      made: quiet(),
      gone: { ...quiet(), letters: 16, boundaries: 2, attributes: 4 },
      other: 0,
      goneLetters: "oneTwo two twoTh",
      madeLetters: "",
      goneBoundaries: [second, third],
      madeBoundaries: [],
      shown: 0,
    });
    expect(a.lines()).toEqual(["One ree"]);
    a.expectMirror();
  });

  it("inserts the pasted letters and one boundary for two paragraphs pasted in a line", () => {
    const a = person(note(...LINES), 10);
    a.select([1, 4]);
    const effects = a.effects(() =>
      a.view.pasteHTML("<p>Xx</p><p>Yy</p>", new window.Event("paste") as ClipboardEvent),
    );
    expect(effects).toMatchObject({
      made: { ...BOUNDARY, letters: 4 },
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "XxYy",
      goneBoundaries: [],
    });
    expect(a.lines()).toEqual(["One one", "Two Xx", "Yytwo two", "Three"]);
    a.expectMirror();
  });

  it("keeps a line's boundary with its text when lines are pasted at its start", () => {
    const a = person(note(...LINES), 10);
    const [first, second, third] = a.boundaryIds();
    a.select([1, 0]);
    const effects = a.effects(() =>
      a.view.pasteHTML("<p>Xx</p><p>Yy</p>", new window.Event("paste") as ClipboardEvent),
    );
    expect(effects.gone).toEqual(quiet());
    expect(effects.made).toEqual({ ...BOUNDARY, letters: 4 });
    expect(a.boundaryLines()).toEqual([
      { id: first, text: "One one" },
      { id: effects.madeBoundaries[0], text: "Xx" },
      { id: second, text: "YyTwo two two" },
      { id: third, text: "Three" },
    ]);
    a.expectMirror();
  });

  it("keeps the first line's boundary when everything is selected and deleted", () => {
    const a = person(note(...LINES), 10);
    const [first, second, third] = a.boundaryIds();
    a.select([0, 0], [2, 5]);
    const effects = a.effects(() => expect(a.press("Backspace")).toBe(true));
    expect(effects.goneBoundaries).toEqual([second, third]);
    expect(effects.made).toEqual(quiet());
    expect(a.boundaryIds()).toEqual([first]);
    expect(a.lines()).toEqual([""]);
    a.expectMirror();
  });

  it.each([
    ["hardBreak", {}, 0],
    ["image", { src: "/a.png", alt: "A", title: null }, 3],
    ["wikilink", { target: "Page", label: "shown" }, 2],
    ["mathInline", { tex: "x^2" }, 1],
    ["inlineAtom", { atomId: "date", params: "{}", source: "{{date}}" }, 3],
    ["escapedPunctuation", { value: "*" }, 1],
    ["rawInline", { source: "<b>" }, 1],
  ] as const)("inserts one element for %s and deletes that element", (name, attrs, attributes) => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 3]);
    const made = a.effects(() => a.put(name, attrs));
    expect(made).toMatchObject({
      made: { ...quiet(), items: 1, attributes },
      gone: quiet(),
      other: 0,
    });
    expect(elementsOf(a.sequence, "item")).toMatchObject([{ name }]);
    expect(a.view.state.doc.child(1).child(1).type.name).toBe(name);
    expect(a.view.state.doc.child(1).child(1).attrs).toEqual(attrs);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
    a.select([1, 3], [1, 4]);
    const gone = a.effects(() => expect(a.press("Backspace")).toBe(true));
    expect(gone).toMatchObject({
      made: quiet(),
      gone: { ...quiet(), items: 1, attributes },
      other: 0,
      goneLetters: "",
    });
    expect(a.lines()).toEqual(LINES);
    a.expectMirror();
  });

  it("sets the attributes of the same element when an inline item is changed", () => {
    const a = person(note(...LINES), 10);
    a.select([1, 3]);
    a.put("wikilink", { target: "Page", label: null });
    const [before] = elementsOf(a.sequence, "item");
    const pos = a.view.state.doc.child(0).nodeSize + 4;
    const effects = a.effects(() =>
      a.view.dispatch(a.view.state.tr.setNodeMarkup(pos, null, { target: "Other", label: null })),
    );
    expect(effects).toMatchObject({
      made: { ...quiet(), attributes: 1 },
      gone: { ...quiet(), attributes: 1 },
      other: 0,
    });
    const [after] = elementsOf(a.sequence, "item");
    expect(after!.id).toBe(before!.id);
    expect(after!.attrs).toBe('[["label",null],["target","Other"]]');
    a.expectMirror();
  });

  it("holds a code block's letters, a line feed at the very end of the note too", () => {
    const a = person(note("One", "x"), 10);
    const b = person(note("One", "x"), 20);
    a.select([1, 0]);
    const retyped = a.effects(() => a.retype("codeBlock"));
    expect(retyped.made).toEqual({ ...quiet(), attributes: 2 });
    expect(retyped.goneBoundaries).toEqual([]);
    a.select([1, 1]);
    const effects = a.effects(() => a.type("\n"));
    expect(effects.made).toEqual({ ...quiet(), letters: 1 });
    expect(a.sequence.toString().endsWith("x\n")).toBe(true);
    a.type("y");
    expect(a.lines()).toEqual(["One", "x\ny"]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(b.blocks()).toEqual(["paragraph", "codeBlock"]);
  });

  it("stores a rule as one boundary, and deletes that boundary with the rule", () => {
    const a = person(note("One", "", "Three"), 10);
    a.select([1, 0]);
    const effects = a.effects(() => a.put("horizontalRule"));
    expect(effects.other).toBe(0);
    expect(effects.madeLetters).toBe("");
    expect(a.blocks()).toContain("horizontalRule");
    a.expectMirror();
    expect(elementsOf(a.sequence, "boundary").map((token) => token.attrs)).toContain(
      '[["path",[]],["type","horizontalRule"]]',
    );
    const b = person(Y.encodeStateAsUpdate(a.doc), 20);
    b.expectMirror();
    expect(b.blocks()).toEqual(a.blocks());
  });

  it("writes nothing back for a change that came from the sequence", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.split(1, 4);
    a.typeAt(0, 0, "x");
    a.select([2, 0], [2, 3]);
    a.toggle("italic");
    a.select([0, 1]);
    a.put("hardBreak");
    for (const update of a.sent.splice(0)) b.receive(update);
    expect(b.sent).toEqual([]);
    b.expectMirror();
    expect(b.view.state.doc.eq(a.view.state.doc)).toBe(true);
  });

  it("refuses a list, a quote and a tick, and keeps the editor and the sequence the same", () => {
    const a = person(note(...LINES), 10);
    const before = a.view.state.doc;
    const { bulletList, listItem, blockquote } = schema.nodes;
    a.view.dispatch(
      a.view.state.tr.replaceWith(
        0,
        a.view.state.doc.child(0).nodeSize,
        bulletList!.create(null, listItem!.create(null, a.view.state.doc.child(0))),
      ),
    );
    a.view.dispatch(
      a.view.state.tr.wrap(a.view.state.doc.resolve(1).blockRange()!, [{ type: blockquote! }]),
    );
    expect(a.view.state.doc).toBe(before);
    expect(a.sent).toEqual([]);
    a.expectMirror();
  });
});

describe("a note with no boundary for some of its blocks", () => {
  it("types into an empty note with letters only, and gives the first line a boundary when it is split at its start", () => {
    const a = person(Y.encodeStateAsUpdate(new Y.Doc()), 10);
    const b = person(Y.encodeStateAsUpdate(new Y.Doc()), 20);
    expect(a.lines()).toEqual([""]);
    expect(a.effects(() => a.type("ab")).made).toEqual({ ...quiet(), letters: 2 });
    a.expectMirror();
    expect(a.effects(() => a.split(0, 1)).made).toEqual(BOUNDARY);
    expect(a.lines()).toEqual(["a", "b"]);
    a.expectMirror();
    const split = a.effects(() => a.split(0, 0));
    expect(split.made).toEqual({ ...quiet(), boundaries: 2, attributes: 4 });
    expect(a.lines()).toEqual(["", "a", "b"]);
    expect(a.boundaryLines().map((line) => line.text)).toEqual(["", "a", "b"]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(b.lines()).toEqual(["", "a", "b"]);
  });

  it("writes two boundaries for Enter in an empty note", () => {
    const a = person(Y.encodeStateAsUpdate(new Y.Doc()), 10);
    const effects = a.effects(() => a.split(0, 0));
    expect(effects.made).toEqual({ ...quiet(), boundaries: 2, attributes: 4 });
    expect(a.lines()).toEqual(["", ""]);
    a.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual([""]);
    expect(a.boundaryIds()).toHaveLength(1);
    a.expectMirror();
  });

  it("gives the text before the first boundary a boundary when its kind changes or it is emptied", () => {
    const head = () =>
      noteOf(({ sequence }) => {
        sequence.insert(0, "ab", {});
        sequence.insertEmbed(2, boundary(), {});
        sequence.insert(3, "cd", {});
      });
    const a = person(head(), 10);
    expect(a.lines()).toEqual(["ab", "cd"]);
    a.select([0, 1]);
    const retyped = a.effects(() => a.retype("heading", { level: 2 }));
    expect(retyped.made).toEqual({ ...quiet(), boundaries: 1, attributes: 4 });
    expect(a.sent).toHaveLength(2);
    expect(tokensOf(a.sequence)[0]).toMatchObject({ kind: "boundary" });
    expect(a.blocks()).toEqual(["h2", "paragraph"]);
    a.expectMirror();

    const b = person(head(), 20);
    b.select([0, 0], [0, 2]);
    const emptied = b.effects(() => b.press("Backspace"));
    expect(emptied.goneLetters).toBe("ab");
    expect(emptied.made).toEqual(BOUNDARY);
    expect(b.lines()).toEqual(["", "cd"]);
    b.expectMirror();

    const c = person(head(), 30);
    expect(c.effects(() => c.typeAt(0, 1, "x")).made).toEqual({ ...quiet(), letters: 1 });
    expect(c.effects(() => c.join(1)).gone).toEqual(BOUNDARY);
    expect(c.lines()).toEqual(["axbcd"]);
    c.expectMirror();
  });

  it("shows and edits the paragraph after a rule, and the one after a code block's first inline item", () => {
    const a = person(
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary({ type: "horizontalRule" }), {});
        sequence.insert(1, "after", {});
        sequence.insertEmbed(6, boundary({ type: "codeBlock", language: null }), {});
        sequence.insert(7, "code", {});
        sequence.insertEmbed(11, element("wikilink", { target: "Page", label: null }), {});
        sequence.insert(12, "tail", {});
      }),
      10,
    );
    expect(a.blocks()).toEqual(["horizontalRule", "paragraph", "codeBlock", "paragraph"]);
    expect(a.lines()).toEqual(["", "after", "code", "tail"]);
    a.expectMirror();
    expect(a.effects(() => a.typeAt(1, 5, "!")).made).toEqual({ ...quiet(), letters: 1 });
    expect(a.effects(() => a.typeAt(1, 0, ">")).made).toEqual({ ...quiet(), letters: 1 });
    expect(a.lines()).toEqual(["", ">after!", "code", "tail"]);
    a.expectMirror();
    a.typeAt(3, 0, "x");
    expect(a.lines()).toEqual(["", ">after!", "code", "xtail"]);
    expect(a.blocks()).toEqual(["horizontalRule", "paragraph", "codeBlock", "paragraph"]);
    a.expectMirror();
    a.select([1, 0], [1, 7]);
    a.press("Backspace");
    expect(a.blocks()).toEqual(["horizontalRule", "paragraph", "codeBlock", "paragraph"]);
    expect(a.lines()).toEqual(["", "", "code", "xtail"]);
    a.expectMirror();
    a.typeAt(2, 4, "!");
    expect(a.lines()).toEqual(["", "", "code!", "xtail"]);
    a.expectMirror();
  });
});

const PASTE = "<p>Xx</p><p>Yy</p>";
const paste = (a: Person) => a.view.pasteHTML(PASTE, new window.Event("paste") as ClipboardEvent);

const ACTIONS: [string, (a: Person) => void][] = [
  ["typed letters", (a) => a.typeAt(1, 3, "hello")],
  ["Enter in a line", (a) => a.split(1, 4)],
  ["Enter at the start of a line", (a) => a.split(1, 0)],
  ["Backspace at the start of a line", (a) => a.join(1)],
  [
    "Delete at the end of a line",
    (a) => {
      a.select([0, 7]);
      a.press("Delete");
    },
  ],
  [
    "a mark across lines",
    (a) => {
      a.select([0, 4], [1, 3]);
      a.toggle("bold");
    },
  ],
  [
    "a link",
    (a) => {
      a.select([1, 0], [1, 3]);
      a.mark("link", { href: "https://example.com/a" });
    },
  ],
  [
    "a paragraph made a heading",
    (a) => {
      a.select([1, 2]);
      a.retype("heading", { level: 2 });
    },
  ],
  [
    "a paragraph made a code block",
    (a) => {
      a.select([1, 2]);
      a.retype("codeBlock");
    },
  ],
  [
    "a selection across three lines deleted",
    (a) => {
      a.select([0, 4], [2, 2]);
      a.press("Backspace");
    },
  ],
  [
    "two paragraphs pasted in a line",
    (a) => {
      a.select([1, 4]);
      paste(a);
    },
  ],
  [
    "an inline item",
    (a) => {
      a.select([1, 3]);
      a.put("wikilink", { target: "Page", label: null });
    },
  ],
  [
    "a rule",
    (a) => {
      a.select([2, 5]);
      a.put("horizontalRule");
    },
  ],
];

describe.each(["bare", "hosted"] as const)("undo and redo on a %s page", (shape) => {
  it.each(ACTIONS)("undoes and redoes %s, and never someone else's change", (_name, change) => {
    const a = person(note(...LINES), 10, shape);
    const b = person(note(...LINES), 20, shape);
    b.typeAt(2, 5, "?");
    exchange(a, b);
    const before = a.view.state.doc.toJSON();
    change(a);
    const after = a.view.state.doc.toJSON();
    expect(after).not.toEqual(before);
    a.expectMirror();
    exchange(a, b);
    expect(b.view.state.doc.toJSON()).toEqual(after);
    expect(a.undo()).toBe(true);
    while (a.undo());
    a.expectMirror();
    expect(a.view.state.doc.toJSON()).toEqual(before);
    exchange(a, b);
    b.expectMirror();
    expect(b.view.state.doc.toJSON()).toEqual(before);
    expect(a.redo()).toBe(true);
    while (a.redo());
    a.expectMirror();
    expect(a.view.state.doc.toJSON()).toEqual(after);
    exchange(a, b);
    b.expectMirror();
    expect(b.view.state.doc.toJSON()).toEqual(after);
    expect(b.sent).toEqual([]);
  });

  it("undoes an inline item's deletion with its attributes", () => {
    const a = person(note(...LINES), 10, shape);
    a.select([1, 3]);
    a.put("image", { src: "/a.png", alt: "A", title: null });
    const withItem = a.view.state.doc.toJSON();
    a.select([1, 3], [1, 4]);
    a.press("Backspace");
    expect(a.lines()).toEqual(LINES);
    expect(a.undo()).toBe(true);
    expect(a.view.state.doc.toJSON()).toEqual(withItem);
    a.expectMirror();
  });

  it("undoes and redoes with Mod-z, Mod-Shift-z and Mod-y", () => {
    const a = person(note(...LINES), 10, shape);
    const b = person(note(...LINES), 20, shape);
    a.typeAt(0, 7, "!");
    b.typeAt(2, 5, "?");
    exchange(a, b);
    expect(a.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    expect(a.press("z", { ctrlKey: true })).toBe(true);
    expect(a.press("z", { ctrlKey: true })).toBe(false);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one", "Two two two", "Three?"]);
    expect(a.press("y", { ctrlKey: true })).toBe(true);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    expect(a.press("z", { ctrlKey: true })).toBe(true);
    expect(a.press("Z", { ctrlKey: true, shiftKey: true, keyCode: 90 })).toBe(true);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    a.expectMirror();
    b.expectMirror();
  });

  it("removes an image's title that had no value before it was set, and keeps the text typed before", () => {
    const a = person(
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary(), {});
        sequence.insert(1, "One", {});
        sequence.insertEmbed(4, element("image", { src: "/a.png", alt: "A" }), {});
      }),
      10,
      shape,
    );
    const title = () => a.view.state.doc.child(0).lastChild!.attrs.title as unknown;
    a.typeAt(0, 3, "x");
    a.view.dispatch(
      a.view.state.tr.setNodeMarkup(5, null, { src: "/a.png", alt: "A", title: "Shown" }),
    );
    expect(title()).toBe("Shown");
    expect(elementsOf(a.sequence, "item")[0]!.attrs).toContain('["title","Shown"]');
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["Onex"]);
    expect(title()).toBe(null);
    expect(elementsOf(a.sequence, "item")[0]!.attrs).toBe('[["alt","A"],["src","/a.png"]]');
    a.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["One"]);
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(true);
    expect(a.redo()).toBe(true);
    expect(a.lines()).toEqual(["Onex"]);
    expect(title()).toBe("Shown");
    a.expectMirror();
  });

  it("leaves a heading's level on the boundary when the change to a heading is undone", () => {
    const a = person(note(...LINES), 10, shape);
    a.select([1, 0]);
    a.retype("heading", { level: 2 });
    expect(a.undo()).toBe(true);
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(elementsOf(a.sequence, "boundary")[1]!.attrs).toBe(
      '[["level",2],["path",[]],["type","paragraph"]]',
    );
    const again = a.effects(() => a.retype("heading", { level: 3 }));
    expect(again.made).toEqual({ ...quiet(), attributes: 2 });
    expect(a.blocks()).toEqual(["paragraph", "h3", "paragraph"]);
    a.expectMirror();
  });

  it("keeps a change from someone else out of a person's undo, also one made in their line", () => {
    const a = person(note(...LINES), 10, shape);
    const b = person(note(...LINES), 20, shape);
    b.typeAt(1, 0, ">");
    b.split(1, 5);
    b.select([0, 0], [0, 3]);
    b.toggle("bold");
    exchange(b, a);
    expect(a.history.undoStack).toHaveLength(0);
    expect(a.undo()).toBe(false);
    a.typeAt(1, 1, "x");
    exchange(a, b);
    expect(a.history.undoStack).toHaveLength(1);
    expect(a.undo()).toBe(true);
    expect(a.undo()).toBe(false);
    exchange(a, b);
    expect(a.lines()).toEqual(["One one", ">Two ", "two two", "Three"]);
    expect(a.lettersMarked("bold")).toBe("One");
    expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
  });

  it("puts the caret where an undone change was", () => {
    const a = person(note(...LINES), 10, shape);
    a.typeAt(2, 5, "!");
    a.select([0, 0]);
    a.undo();
    expect(a.view.state.selection.from).toBe(a.view.state.doc.content.size - 1);
    a.join(1);
    a.select([1, 2]);
    a.undo();
    expect(a.lines()).toEqual(LINES);
    expect(a.view.state.selection.$from.parentOffset).toBe(0);
    expect(a.view.state.selection.$from.index(0)).toBe(1);
  });
});

describe("a change of the sequence from elsewhere", () => {
  it("keeps the selection around its letters while someone else changes the note around it", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 4], [1, 7]);
    b.typeAt(0, 0, "Zero ");
    b.split(0, 5);
    b.typeAt(2, 0, "> ");
    b.join(3);
    exchange(b, a);
    expect(a.lines()).toEqual(["Zero ", "One one", "> Two two twoThree"]);
    const { from, to } = a.view.state.selection;
    expect(a.view.state.doc.textBetween(from, to)).toBe("two");
    a.expectMirror();
  });

  it("keeps the selection around its letters when letters land at both of its ends", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 4], [1, 7]);
    b.typeAt(1, 7, "]");
    b.typeAt(1, 4, "[");
    exchange(b, a);
    expect(a.lines()[1]).toBe("Two [two] two");
    const { from, to } = a.view.state.selection;
    expect(a.view.state.doc.textBetween(from, to)).toBe("two");
  });

  it("leaves a caret at the end of its line when someone else presses Enter there", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([0, 7]);
    b.split(0, 7);
    b.type("new");
    exchange(b, a);
    expect(a.lines()).toEqual(["One one", "new", "Two two two", "Three"]);
    expect(a.view.state.selection.$from.index(0)).toBe(0);
    expect(a.view.state.selection.$from.parentOffset).toBe(7);
  });

  it("keeps a selected rule selected", () => {
    const rule = () =>
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary(), {});
        sequence.insert(1, "One", {});
        sequence.insertEmbed(4, boundary({ type: "horizontalRule" }), {});
        sequence.insertEmbed(5, boundary(), {});
        sequence.insert(6, "Two", {});
      });
    const a = person(rule(), 10);
    const b = person(rule(), 20);
    a.view.dispatch(
      a.view.state.tr.setSelection(
        NodeSelection.create(a.view.state.doc, a.view.state.doc.child(0).nodeSize),
      ),
    );
    b.typeAt(0, 0, "Zero ");
    b.split(0, 5);
    exchange(b, a);
    expect(a.view.state.selection.toJSON()).toMatchObject({ type: "node" });
    expect(a.view.state.doc.nodeAt(a.view.state.selection.from)!.type.name).toBe("horizontalRule");
  });

  it("keeps bold that was switched on for the next letter", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 3]);
    a.toggle("bold");
    b.typeAt(0, 0, "Zero ");
    exchange(b, a);
    a.type("x");
    expect(a.lettersMarked("bold")).toBe("x");
    expect(a.lines()[1]).toBe("Twox two two");
  });

  it("keeps the nodes of the lines it does not touch", () => {
    const a = person(note(...LINES, "Four", "Five"), 10);
    const b = person(note(...LINES, "Four", "Five"), 20);
    const before = [0, 1, 3, 4].map((line) => a.view.state.doc.child(line));
    b.typeAt(2, 5, "!");
    exchange(b, a);
    for (const [at, line] of [0, 1, 3, 4].entries())
      expect(a.view.state.doc.child(line)).toBe(before[at]);
    a.typeAt(2, 0, "x");
    b.typeAt(4, 0, "y");
    exchange(a, b);
    for (const [at, line] of [0, 1, 3].entries())
      expect(a.view.state.doc.child(line)).toBe(before[at]);
    a.expectMirror();
  });

  it("shows many changes that arrive as one update, as after a reconnect", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([2, 1], [2, 4]);
    b.typeAt(0, 0, "Zero ");
    b.split(0, 5);
    b.select([1, 4], [2, 3]);
    b.press("Backspace");
    b.select([2, 0]);
    b.retype("heading", { level: 2 });
    b.select([2, 0], [2, 3]);
    b.toggle("bold");
    b.typeAt(2, 5, "!");
    b.split(1, 2);
    reconnect(b, a);
    a.expectMirror();
    expect(a.view.state.doc.toJSON()).toEqual(b.view.state.doc.toJSON());
    expect(a.lines()).toEqual(["Zero ", "On", "e  two two", "Three!"]);
    const { from, to } = a.view.state.selection;
    expect(a.view.state.doc.textBetween(from, to)).toBe("hre");
  });

  it("reads marks again from the sequence after code is removed here", () => {
    const a = person(note("One two"), 10);
    const b = person(note("One two"), 20);
    a.select([0, 0], [0, 3]);
    a.mark("code");
    b.select([0, 0], [0, 3]);
    b.mark("bold");
    exchange(a, b);
    const marks = (each: Person) =>
      each.view.state.doc.child(0).firstChild!.marks.map((mark) => mark.type.name);
    expect(marks(a)).toEqual(["code"]);
    expect(marks(b)).toEqual(["code"]);
    a.select([0, 0], [0, 3]);
    a.toggle("code");
    expect(marks(a)).toEqual(["bold"]);
    a.expectMirror();
    exchange(a, b);
    expect(marks(b)).toEqual(["bold"]);
  });

  it("shows no mark on an inline item, as the sequence reads", () => {
    const a = person(note(...LINES), 10);
    a.select([1, 3]);
    a.put("hardBreak");
    a.select([1, 0], [1, 6]);
    a.toggle("bold");
    expect(a.view.state.doc.child(1).child(1).marks).toEqual([]);
    expect(a.lettersMarked("bold")).toBe("Two t");
    a.expectMirror();
  });

  it("gives an anchor that stays with its letters through changes and in another editor", () => {
    const a = person(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.select([1, 4], [1, 7]);
    const { from, to } = a.view.state.selection;
    const anchors = [from, to].map((pos) => bodySequenceAnchor(a.view.state, pos)!);
    b.typeAt(1, 0, "> ");
    b.join(1);
    b.split(0, 3);
    exchange(b, a);
    a.typeAt(0, 0, "x");
    const [start, end] = anchors.map((anchor) => bodySequenceAnchorPosition(a.view.state, anchor)!);
    expect(a.view.state.doc.textBetween(start!, end!)).toBe("two");
    exchange(a, b);
    const [there, thereEnd] = anchors.map((anchor) =>
      bodySequenceAnchorPosition(b.view.state, anchor)!,
    );
    expect(b.view.state.doc.textBetween(there!, thereEnd!)).toBe("two");
    const lineEnd = a.view.state.doc.child(0).nodeSize - 1;
    const atLineEnd = bodySequenceAnchor(a.view.state, lineEnd)!;
    const atLineStart = bodySequenceAnchor(a.view.state, lineEnd + 2)!;
    expect(bodySequenceAnchorPosition(a.view.state, atLineEnd)).toBe(lineEnd);
    expect(bodySequenceAnchorPosition(a.view.state, atLineStart)).toBe(lineEnd + 2);
  });

  it("applies nothing another plugin adds while the editor shows the note: at its mount, for a change from elsewhere, for an undo", () => {
    const lastLineEmpty = new Plugin({
      appendTransaction(_transactions, _before, state) {
        if (state.doc.lastChild!.content.size === 0) return null;
        return state.tr.insert(state.doc.content.size, schema.nodes.paragraph!.create());
      },
    });
    const a = person(note(...LINES), 10, "bare", [lastLineEmpty]);
    a.expectMirror();
    expect(a.lines()).toEqual(LINES);
    expect(a.sent).toEqual([]);
    const b = person(note(...LINES), 20);
    b.typeAt(2, 5, "F");
    exchange(b, a);
    a.expectMirror();
    expect(a.lines()).toEqual(["One one", "Two two two", "ThreeF"]);
    expect(a.sent).toEqual([]);
    a.select([0, 0]);
    expect(a.lines()).toEqual(["One one", "Two two two", "ThreeF", ""]);
    expect(a.sent).toHaveLength(1);
    a.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["One one", "Two two two", "ThreeF"]);
    expect(a.sent).toHaveLength(2);
    a.expectMirror();
  });

  it("shows the sequence again when a host swaps in a state it never read from it", () => {
    const a = person(note(...LINES), 10);
    a.view.updateState(
      EditorState.create({
        schema,
        plugins: a.view.state.plugins,
        doc: schema.topNodeType.createAndFill()!,
      }),
    );
    expect(a.lines()).toEqual(LINES);
    expect(a.sent).toEqual([]);
    a.expectMirror();
  });
});

const CONTAINERS = [
  ["L", "bulletList"],
  ["a", "listItem"],
  ["b", "listItem"],
  ["q", "callout"],
  ["T", "table"],
  ["r", "tableRow"],
  ["c1", "tableCell"],
  ["c2", "tableCell"],
  ["N", "taskList"],
  ["t", "taskItem"],
] as const;

function noteWithContainers(): Uint8Array {
  return noteOf(({ sequence, containers }) => {
    for (const [id, type] of CONTAINERS)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        containers.set(key, value);
    containers.set("q.title", "Careful");
    const line = (path: string[], text: string, attrs: Record<string, unknown> = {}) => {
      sequence.insertEmbed(sequence.length, boundary({ path, ...attrs }), {});
      sequence.insert(sequence.length, text, {});
    };
    line([], "Top");
    line(["L", "a"], "first");
    line(["L", "a"], "more of first");
    line(["L", "b"], "second");
    line(["q"], "inside a callout");
    line(["T", "r", "c1"], "cell one");
    line(["T", "r", "c2"], "cell two");
    line(["N", "t"], "a to-do", { type: "heading", level: 2 });
    line([], "Bottom");
  });
}

const NESTED = [
  "Top",
  "first",
  "more of first",
  "second",
  "inside a callout",
  "cell one",
  "cell two",
  "",
  "a to-do",
  "Bottom",
];

const pathsOf = (a: Person) =>
  elementsOf(a.sequence, "boundary").map((token) =>
    (
      Object.fromEntries(JSON.parse(token.attrs) as [string, unknown][]) as {
        path: string[];
      }
    ).path.join("/"),
  );

describe("a note that has lists, a callout and a table, written by someone else", () => {
  it("shows what the sequence reads as and writes nothing on opening", () => {
    const a = person(noteWithContainers(), 10);
    a.expectMirror();
    expect(a.lines()).toEqual(NESTED);
    expect(a.view.state.doc.childCount).toBe(6);
    expect(a.sent).toEqual([]);
  });

  it("types, marks, splits and joins inside a container, and each new boundary has the container's path", () => {
    const a = person(noteWithContainers(), 10);
    const b = person(noteWithContainers(), 20);
    for (const line of [1, 3, 4, 5, 6, 8])
      expect(a.effects(() => a.typeAt(line, 2, "x"))).toMatchObject({
        made: { ...quiet(), letters: 1 },
        gone: quiet(),
        shown: 0,
      });
    a.select([1, 0], [3, 3]);
    expect(a.effects(() => a.toggle("bold")).made).toEqual({ ...quiet(), formats: 2 });
    expect(a.effects(() => a.split(4, 3))).toMatchObject({ made: BOUNDARY, gone: quiet() });
    expect(a.lines().slice(4, 6)).toEqual(["inx", "side a callout"]);
    expect(pathsOf(a).slice(3, 7)).toEqual(["L/b", "q", "q", "T/r/c1"]);
    expect(a.effects(() => a.join(5)).gone).toEqual(BOUNDARY);
    expect(a.lines()[4]).toBe("inxside a callout");
    expect(a.effects(() => a.split(5, 4)).made).toEqual(BOUNDARY);
    expect(pathsOf(a).slice(5, 8)).toEqual(["T/r/c1", "T/r/c1", "T/r/c2"]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
  });

  it("gives a to-do's added first paragraph a boundary with the item's path when it is typed in", () => {
    const a = person(noteWithContainers(), 10);
    const b = person(noteWithContainers(), 20);
    expect(a.blocks().slice(7, 9)).toEqual(["paragraph", "h2"]);
    const effects = a.effects(() => a.typeAt(7, 0, "x"));
    expect(effects.made).toEqual({ ...BOUNDARY, letters: 1 });
    expect(effects.gone).toEqual(quiet());
    expect(a.lines().slice(7, 9)).toEqual(["x", "a to-do"]);
    expect(pathsOf(a).slice(7, 9)).toEqual(["N/t", "N/t"]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.lines().slice(7, 9)).toEqual(["", "a to-do"]);
    a.expectMirror();
  });

  it("refuses a change to a container, and deletes a whole one", () => {
    const a = person(noteWithContainers(), 10);
    const before = a.view.state.doc;
    a.select([3, 0]);
    a.press("Backspace");
    a.select([1, 2], [3, 2]);
    a.press("Backspace");
    const item = before.child(4).firstChild!;
    a.view.dispatch(
      a.view.state.tr.setNodeMarkup(
        before.child(0).nodeSize +
          before.child(1).nodeSize +
          before.child(2).nodeSize +
          before.child(3).nodeSize +
          1,
        null,
        { ...item.attrs, checked: true },
      ),
    );
    expect(a.view.state.doc).toBe(before);
    expect(a.sent).toEqual([]);
    const list = before.child(1);
    const from = before.child(0).nodeSize;
    const effects = a.effects(() =>
      a.view.dispatch(a.view.state.tr.delete(from, from + list.nodeSize)),
    );
    expect(effects.gone.boundaries).toBe(3);
    expect(effects.made).toEqual(quiet());
    expect(a.lines().slice(0, 2)).toEqual(["Top", "inside a callout"]);
    expect(a.containers.get("L")).toBe("bulletList");
    a.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(NESTED);
    a.expectMirror();
  });

  it("shows a setting and a list's kind that someone else changes", () => {
    const a = person(noteWithContainers(), 10);
    const writer = page(noteWithContainers(), 30);
    const untouched = a.view.state.doc.child(1);
    writer.doc.transact(() => {
      writer.containers.set("t.checked", true);
      writer.containers.set("q.title", "Now");
    });
    exchange(writer, a);
    expect(a.view.state.doc.child(4).firstChild!.attrs.checked).toBe(true);
    expect(a.view.state.doc.child(2).attrs.title).toBe("Now");
    expect(a.view.state.doc.child(1)).toBe(untouched);
    writer.containers.set("L", "orderedList");
    exchange(writer, a);
    expect(a.view.state.doc.child(1).type.name).toBe("orderedList");
    expect(a.sent).toEqual([]);
    a.expectMirror();
  });

  type Fixture = { name: string; update: string };
  const FIXTURES = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "body-sequence.json"), "utf8"),
  ) as Fixture[];

  it.each(FIXTURES)(
    "shows the stored note with $name, and types at every place in it",
    ({ update }) => {
      const baseline = Buffer.from(update, "base64");
      const a = person(baseline, 10);
      const b = person(baseline, 20);
      a.expectMirror();
      expect(a.sent).toEqual([]);
      let typed = 0;
      for (;;) {
        const places = textPlaces(a.view.state.doc);
        const place = places[typed];
        if (!place) break;
        a.view.dispatch(
          a.view.state.tr.setSelection(
            TextSelection.create(a.view.state.doc, place.pos + place.size),
          ),
        );
        a.type("x");
        a.expectMirror();
        expect(textPlaces(a.view.state.doc)[typed]!.size).toBe(place.size + 1);
        a.view.dispatch(
          a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, place.pos)),
        );
        a.type("y");
        a.expectMirror();
        typed += 1;
      }
      expect(typed).toBeGreaterThan(0);
      exchange(a, b);
      b.expectMirror();
      expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
      while (a.undo());
      a.expectMirror();
      exchange(a, b);
      expect(readBodySequence(schema, b.doc).textContent).not.toMatch(/[xy]{2}/u);
    },
  );
});

function textPlaces(doc: ProseMirrorNode): { pos: number; size: number }[] {
  const places: { pos: number; size: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) places.push({ pos: pos + 1, size: node.content.size });
    return node.isBlock && !node.isTextblock;
  });
  return places;
}

describe("a block that has text after it which it cannot hold", () => {
  const spilling = () =>
    noteOf(({ sequence, containers }) => {
      for (const [id, type] of [
        ["L", "bulletList"],
        ["I", "listItem"],
      ] as const)
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          containers.set(key, value);
      sequence.insertEmbed(0, boundary({ type: "heading", level: 1 }), {});
      sequence.insert(1, "Head", {});
      sequence.insertEmbed(5, boundary({ type: "horizontalRule", path: ["L", "I"] }), {});
      sequence.insert(6, "tail", {});
      sequence.insertEmbed(10, boundary({ type: "codeBlock", language: null }), {});
      sequence.insert(11, "code", {});
      sequence.insertEmbed(15, element("wikilink", { target: "Page", label: null }), {});
      sequence.insert(16, "rest", {});
    });

  it("keeps that text in its list when the block is deleted", () => {
    const a = person(spilling(), 10);
    const b = person(spilling(), 20);
    expect(a.view.state.doc.toString()).toBe(
      'doc(heading("Head"), bulletList(listItem(paragraph, horizontalRule, paragraph("tail"))), codeBlock("code"), paragraph(wikilink, "rest"))',
    );
    const rule = a.view.state.doc.child(0).nodeSize + 4;
    const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(rule, rule + 1)));
    expect(effects.goneLetters).toBe("");
    expect(effects.madeLetters).toBe("");
    expect(effects.goneBoundaries).toEqual([]);
    expect(effects.madeBoundaries).toHaveLength(1);
    expect(a.view.state.doc.toString()).toBe(
      'doc(heading("Head"), bulletList(listItem(paragraph, paragraph("tail"))), codeBlock("code"), paragraph(wikilink, "rest"))',
    );
    expect(pathsOf(a)).toEqual(["", "L/I", "L/I", ""]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(a.undo()).toBe(true);
    a.expectMirror();
    expect(a.lines()).toEqual(["Head", "", "", "tail", "code", "rest"]);
  });

  it("keeps a letter typed in front of that text out of the code block, and copies no letter", () => {
    const a = person(spilling(), 10);
    const effects = a.effects(() => a.typeAt(5, 0, "x"));
    expect(effects).toMatchObject({
      made: { ...BOUNDARY, letters: 1 },
      gone: quiet(),
      other: 0,
      madeLetters: "x",
    });
    expect(a.lines().slice(4)).toEqual(["code", "xrest"]);
    a.expectMirror();
    expect(a.effects(() => a.typeAt(5, 0, "y"))).toMatchObject({
      made: { ...quiet(), letters: 1 },
      gone: quiet(),
      other: 0,
    });
    expect(a.lines().slice(4)).toEqual(["code", "yxrest"]);
    a.expectMirror();
  });

  it("keeps the kinds the editor shows when an empty code block with such text is changed", () => {
    const empty = () =>
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary({ type: "codeBlock", language: null }), {});
        sequence.insertEmbed(1, element("image", { src: "/a.png", alt: "a", title: null }), {});
        sequence.insert(2, "w", {});
      });
    const a = person(empty(), 10);
    expect(a.blocks()).toEqual(["codeBlock", "paragraph"]);
    a.select([0, 0], [1, 1]);
    a.retype("heading", { level: 3 });
    expect(a.view.state.doc.toString()).toBe('doc(heading, heading(image, "w"))');
    expect(a.blocks()).toEqual(["h3", "h3"]);
    a.expectMirror();

    const b = person(empty(), 20);
    b.select([1, 0], [1, 2]);
    const effects = b.effects(() => b.retype("codeBlock"));
    expect(effects.goneLetters).toBe("");
    expect(effects.madeLetters).toBe("");
    expect(b.view.state.doc.toString()).toBe('doc(codeBlock, codeBlock("w"))');
    b.expectMirror();
  });

  it("gives that text its own paragraph when the code block becomes a paragraph", () => {
    const a = person(spilling(), 10);
    a.select([4, 0]);
    const effects = a.effects(() => a.retype("paragraph"));
    expect(effects.goneLetters).toBe("");
    expect(effects.madeLetters).toBe("");
    expect(effects.goneBoundaries).toEqual([]);
    expect(effects.madeBoundaries).toHaveLength(1);
    expect(a.blocks().slice(4)).toEqual(["paragraph", "paragraph"]);
    expect(a.lines().slice(4)).toEqual(["code", "rest"]);
    a.expectMirror();
  });
});

describe("a paragraph the reader added in front of a list item's content", () => {
  const item = (...lines: [Record<string, unknown>, string][]) =>
    noteOf(({ sequence, containers }) => {
      for (const [id, type] of [
        ["L", "bulletList"],
        ["I", "listItem"],
      ] as const)
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          containers.set(key, value);
      sequence.insertEmbed(0, boundary(), {});
      sequence.insert(1, "Top", {});
      for (const [attrs, text] of lines) {
        sequence.insertEmbed(sequence.length, boundary({ ...attrs, path: ["L", "I"] }), {});
        sequence.insert(sequence.length, text, {});
      }
    });

  it("keeps the list when the item's only stored line is deleted, by making its boundary the paragraph's", () => {
    const a = person(item([{ type: "heading", level: 2 }, ""]), 10);
    const [, heading] = a.boundaryIds();
    expect(a.view.state.doc.toString()).toBe(
      'doc(paragraph("Top"), bulletList(listItem(paragraph, heading)))',
    );
    a.select([2, 0]);
    const effects = a.effects(() => expect(a.press("Backspace")).toBe(true));
    expect(effects.goneBoundaries).toEqual([]);
    expect(effects.madeBoundaries).toEqual([]);
    expect(a.boundaryIds()).toEqual([a.boundaryIds()[0], heading]);
    expect(a.view.state.doc.toString()).toBe(
      'doc(paragraph("Top"), bulletList(listItem(paragraph)))',
    );
    expect(pathsOf(a)).toEqual(["", "L/I"]);
    a.expectMirror();
    expect(a.undo()).toBe(true);
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "h2"]);
    a.expectMirror();
  });

  it("keeps a line in its list when it is joined into that paragraph", () => {
    const a = person(item([{ type: "heading", level: 2 }, "Title"]), 10);
    const b = person(item([{ type: "heading", level: 2 }, "Title"]), 20);
    const [, heading] = a.boundaryIds();
    const first = a.view.state.doc.child(0).nodeSize + 3;
    const effects = a.effects(() => a.view.dispatch(a.view.state.tr.join(first + 1)));
    expect(effects).toMatchObject({ goneLetters: "", madeLetters: "", goneBoundaries: [] });
    expect(a.boundaryLines()[1]).toEqual({ id: heading, text: "Title" });
    expect(a.view.state.doc.toString()).toBe(
      'doc(paragraph("Top"), bulletList(listItem(paragraph("Title"))))',
    );
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
  });
});

describe("two lists with a line between them", () => {
  const twoLists = (lowerList: string, ...between: string[]) =>
    noteOf(({ sequence, containers }) => {
      for (const [id, type] of [
        ["L", "bulletList"],
        ["M", "bulletList"],
        ["I", "listItem"],
        ["J", "listItem"],
      ] as const)
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          containers.set(key, value);
      const line = (path: string[], text: string) => {
        sequence.insertEmbed(sequence.length, boundary({ path }), {});
        sequence.insert(sequence.length, text, {});
      };
      line(["L", "I"], "one");
      for (const text of between) line([], text);
      line([lowerList, "J"], "two");
    });

  it("refuses to remove the last line between two that share an id, so they never read as one", () => {
    const a = person(twoLists("L", ""), 10);
    const before = a.view.state.doc;
    const between = before.child(0).nodeSize;
    a.view.dispatch(a.view.state.tr.delete(between, between + 2));
    a.select([1, 0]);
    a.press("Backspace");
    a.press("Delete");
    expect(a.view.state.doc).toBe(before);
    expect(a.view.state.doc.childCount).toBe(3);
    expect(a.sent).toEqual([]);
    a.expectMirror();

    const b = person(twoLists("L", "", "x"), 20);
    const both = b.view.state.tr.delete(between, between + 2).delete(between, between + 3);
    expect(both.doc.childCount).toBe(2);
    b.view.dispatch(both);
    expect(b.view.state.doc.childCount).toBe(4);
    expect(b.sent).toEqual([]);
    const one = b.effects(() => b.view.dispatch(b.view.state.tr.delete(between, between + 2)));
    expect(one.gone).toEqual(BOUNDARY);
    expect(b.view.state.doc.toString()).toBe(
      'doc(bulletList(listItem(paragraph("one"))), paragraph("x"), bulletList(listItem(paragraph("two"))))',
    );
    b.expectMirror();
  });

  it("removes the line between two that have their own ids", () => {
    const a = person(twoLists("M", ""), 10);
    const between = a.view.state.doc.child(0).nodeSize;
    const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(between, between + 2)));
    expect(effects.gone).toEqual(BOUNDARY);
    expect(effects.made).toEqual(quiet());
    expect(a.view.state.doc.toString()).toBe(
      'doc(bulletList(listItem(paragraph("one"))), bulletList(listItem(paragraph("two"))))',
    );
    a.expectMirror();
  });
});

describe("letters that are two units long", () => {
  const FACE = String.fromCodePoint(0x1f600);

  it("refuses to delete, split, type or format between the two units of one", () => {
    const a = person(note(`a${FACE}b`), 10);
    const inside = 3;
    const before = a.view.state.doc;
    a.view.dispatch(a.view.state.tr.delete(inside - 1, inside));
    a.view.dispatch(a.view.state.tr.delete(inside, inside + 1));
    a.view.dispatch(a.view.state.tr.split(inside));
    a.view.dispatch(a.view.state.tr.insertText("x", inside));
    a.view.dispatch(a.view.state.tr.addMark(1, inside, schema.marks.bold!.create()));
    expect(a.view.state.doc).toBe(before);
    expect(a.sent).toEqual([]);
    const whole = a.effects(() => a.view.dispatch(a.view.state.tr.delete(2, 4)));
    expect(whole.goneLetters).toBe(FACE);
    expect(a.lines()).toEqual(["ab"]);
    a.expectMirror();
  });
});

describe("formatting items Yjs would delete on its own", () => {
  const formats = (sequence: Y.Text) => {
    let count = 0;
    for (let item = sequence._start; item !== null; item = item.right)
      if (!item.deleted && item.content instanceof Y.ContentFormat) count += 1;
    return count;
  };

  it.each([
    ["the bold first", [0, 1, 2]],
    ["the delete first", [1, 0, 2]],
    ["the typed letter first", [2, 1, 0]],
  ] as const)(
    "stay, and nobody sends a change of their own, when a word is made bold, deleted and typed in at once, %s",
    (_name, order) => {
      const people = [10, 20, 30].map((clientID) => person(note("One word here"), clientID));
      const [bolder, deleter, typist] = people as [Person, Person, Person];
      bolder.select([0, 4], [0, 8]);
      bolder.toggle("bold");
      deleter.select([0, 4], [0, 8]);
      deleter.press("Backspace");
      typist.typeAt(0, 6, "x");
      const waiting = people.map((each) => each.sent.splice(0));
      for (const from of order)
        for (const update of waiting[from]!)
          people.forEach((to, at) => {
            if (at !== from) to.receive(update);
          });
      for (const each of people) {
        expect(each.sent).toEqual([]);
        each.expectMirror();
        expect(tokensOf(each.sequence)).toEqual(tokensOf(bolder.sequence));
        expect(each.view.state.doc.toJSON()).toEqual(bolder.view.state.doc.toJSON());
        const reopened = declared(99);
        Y.applyUpdate(reopened.doc, Y.encodeStateAsUpdate(each.doc));
        expect(readBodySequence(schema, reopened.doc).toJSON()).toEqual(
          each.view.state.doc.toJSON(),
        );
        reopened.doc.destroy();
      }
      expect(bolder.lines()).toEqual(["One x here"]);
      expect(bolder.lettersMarked("bold")).toBe("x");
    },
  );

  it("are deleted by Yjs through the field the adapter clears, on a document with no adapter", () => {
    const receiveDelete = (keep: boolean) => {
      const bolder = page(note("One word here"), 10);
      const deleter = page(note("One word here"), 20);
      bolder.sequence.format(5, 4, { bold: {} });
      deleter.sequence.delete(5, 4);
      const flags: boolean[] = [];
      bolder.doc.on("afterTransaction", (transaction: Y.Transaction) =>
        flags.push(transaction._needFormattingCleanup),
      );
      const release = keep ? keepBodySequenceFormatting(bolder.sequence) : () => {};
      bolder.sent.length = 0;
      for (const update of deleter.sent) bolder.receive(update);
      release();
      return { flags, sent: bolder.sent.length, formats: formats(bolder.sequence) };
    };
    expect(receiveDelete(false)).toEqual({ flags: [true, false], sent: 1, formats: 1 });
    expect(receiveDelete(true)).toEqual({ flags: [true], sent: 0, formats: 2 });
  });
});

describe.each(["bare", "hosted"] as const)("on a %s page, a finding of the review", (shape) => {
  it("keeps a caret at the start of the paragraph after a code block through a change from elsewhere", () => {
    const baseline = noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "codeBlock", language: null }), {});
      sequence.insert(1, "code", {});
      sequence.insertEmbed(5, element("wikilink", { target: "Page", label: null }), {});
      sequence.insert(6, "rest", {});
      sequence.insertEmbed(10, boundary(), {});
      sequence.insert(11, "later", {});
    });
    const a = person(baseline, 10, shape);
    const b = person(baseline, 20, shape);
    a.select([1, 0]);
    b.typeAt(2, 5, "!");
    exchange(b, a);
    expect(a.view.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(a.view.state.selection.$from.parentOffset).toBe(0);
    a.type("x");
    expect(a.blocks()).toEqual(["codeBlock", "paragraph", "paragraph"]);
    expect(a.lines()).toEqual(["code", "xrest", "later!"]);
    a.expectMirror();
  });

  it("keeps a caret in a list item's added first paragraph through a change from elsewhere", () => {
    const baseline = noteOf(({ sequence, containers }) => {
      for (const [id, type] of [
        ["L", "bulletList"],
        ["I", "listItem"],
      ] as const)
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          containers.set(key, value);
      sequence.insertEmbed(0, boundary(), {});
      sequence.insert(1, "Top", {});
      sequence.insertEmbed(4, boundary({ type: "heading", level: 2, path: ["L", "I"] }), {});
      sequence.insert(5, "Title", {});
      sequence.insertEmbed(10, boundary(), {});
      sequence.insert(11, "later", {});
    });
    const a = person(baseline, 10, shape);
    const b = person(baseline, 20, shape);
    expect(a.lines()).toEqual(["Top", "", "Title", "later"]);
    a.select([1, 0]);
    b.typeAt(3, 5, "!");
    exchange(b, a);
    a.type("x");
    expect(a.lines()).toEqual(["Top", "x", "Title", "later!"]);
    expect(pathsOf(a)).toEqual(["", "L/I", "L/I", ""]);
    a.expectMirror();
  });
});

describe("a split inside a list item someone else stored", () => {
  it("is refused for the item's first block, which section 4 gives a new item", () => {
    const a = person(noteWithContainers(), 10);
    const before = a.view.state.doc;
    for (const [line, offset] of [
      [1, 1],
      [1, 0],
      [1, 5],
      [3, 2],
      [7, 0],
    ] as const) {
      a.select([line, offset]);
      a.press("Enter");
    }
    a.select([1, 2]);
    a.view.pasteHTML("<p>Xx</p><p>Yy</p>", new window.Event("paste") as ClipboardEvent);
    expect(a.view.state.doc).toBe(before);
    expect(a.sent).toEqual([]);
    a.expectMirror();
  });

  it("goes through for a later block of the item, which stays in the item", () => {
    const a = person(noteWithContainers(), 10);
    const [, , later] = a.boundaryIds();
    expect(a.effects(() => a.split(2, 4))).toMatchObject({ made: BOUNDARY, gone: quiet() });
    expect(a.lines().slice(1, 4)).toEqual(["first", "more", " of first"]);
    const atStart = a.effects(() => a.split(2, 0));
    expect(atStart).toMatchObject({ made: BOUNDARY, gone: quiet() });
    expect(a.boundaryLines().slice(2, 4)).toEqual([
      { id: atStart.madeBoundaries[0], text: "" },
      { id: later, text: "more" },
    ]);
    expect(pathsOf(a).slice(0, 6)).toEqual(["", "L/a", "L/a", "L/a", "L/a", "L/b"]);
    expect(a.view.state.doc.child(1).childCount).toBe(2);
    a.expectMirror();
  });
});

describe("a block deleted together with part of the text after it that it cannot hold", () => {
  it("never leaves that text without a boundary that can hold it, for any delete in a small note", () => {
    const upper: [Record<string, unknown> | null, string][] = [
      [null, ""],
      [null, "hh"],
      [{}, "One"],
      [{ type: "horizontalRule" }, ""],
      [{ type: "horizontalRule" }, "zz"],
      [{ type: "codeBlock", language: null }, "cc"],
    ];
    const blocks: [Record<string, unknown>, string][] = [
      [{ type: "horizontalRule" }, ""],
      [{ type: "mathBlock", tex: "x" }, ""],
      [{ type: "codeBlock", language: null }, "kk"],
    ];
    let deletes = 0;
    for (const [above, aboveText] of upper)
      for (const [block, own] of blocks)
        for (const path of [[], ["L", "I"]]) {
          const baseline = noteOf(({ sequence, containers }) => {
            for (const [id, type] of [
              ["L", "bulletList"],
              ["I", "listItem"],
            ] as const)
              for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
                containers.set(key, value);
            if (above) sequence.insertEmbed(0, boundary(above), {});
            sequence.insert(sequence.length, aboveText, {});
            sequence.insertEmbed(sequence.length, boundary({ ...block, path }), {});
            sequence.insert(sequence.length, own, {});
            if (own) sequence.insertEmbed(sequence.length, element("hardBreak", {}), {});
            sequence.insert(sequence.length, "abc", {});
          });
          const size = readBodySequence(schema, person(baseline, 10).doc).content.size;
          stopEveryone();
          for (let from = 0; from < size; from++)
            for (let to = from + 1; to <= size; to++) {
              const a = person(baseline, 10);
              const before = a.view.state.doc;
              const blockId = a.boundaryIds().at(-1)!;
              let deleted;
              try {
                deleted = a.view.state.tr.delete(from, to);
              } catch {
                stopEveryone();
                continue;
              }
              a.view.dispatch(deleted);
              deletes += 1;
              a.expectMirror();
              const line = a.boundaryLines().findLast((each) => each.text.endsWith("c"));
              const startsOutsideText = !before.resolve(from).parent.isTextblock;
              if (line && startsOutsideText && !a.boundaryIds().includes(blockId)) {
                const holder = elementsOf(a.sequence, "boundary").find(
                  (token) => token.id === line.id,
                );
                expect(
                  holder?.attrs,
                  `delete(${String(from)}, ${String(to)}) in ${before.toString()}`,
                ).toMatch(/"type","(paragraph|heading|codeBlock)"/u);
              }
              stopEveryone();
            }
        }
    expect(deletes).toBeGreaterThan(3000);
  });
});

type Part =
  | string
  | readonly [string, Record<string, unknown>]
  | { letters: string; marks: Record<string, unknown> };
type StoredLine = { boundary: Record<string, unknown> | null; parts: readonly Part[] };

const HARD_BREAK: Part = ["hardBreak", {}];
const WIKILINK: Part = ["wikilink", { target: "Page", label: null }];
const CODE = { type: "codeBlock", language: null };
const RULE = { type: "horizontalRule" };
const MATH = { type: "mathBlock", tex: "x" };
const RAW = { type: "rawBlock", source: "<hr>" };
const IN_ITEM = { path: ["L", "I"] };
const stored = (boundaryAttrs: Record<string, unknown> | null, ...parts: Part[]): StoredLine => ({
  boundary: boundaryAttrs,
  parts,
});

function noteOfLines(lines: readonly StoredLine[]): Uint8Array {
  return noteOf(({ sequence, containers }) => {
    for (const [id, type] of [
      ["L", "bulletList"],
      ["I", "listItem"],
      ["Q", "blockquote"],
      ["Q2", "blockquote"],
    ] as const)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        containers.set(key, value);
    for (const line of lines) {
      if (line.boundary) sequence.insertEmbed(sequence.length, boundary(line.boundary), {});
      for (const part of line.parts)
        if (typeof part === "string") sequence.insert(sequence.length, part, {});
        else if ("letters" in part) sequence.insert(sequence.length, part.letters, part.marks);
        else sequence.insertEmbed(sequence.length, element(part[0], part[1]), {});
    }
  });
}

describe.each(["bare", "hosted"] as const)(
  "on a %s page, a finding of the second review",
  (shape) => {
    it("keeps the text after code in its own paragraph when the item that started it is deleted", () => {
      const a = person(
        noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd", WIKILINK, "ef")]),
        10,
        shape,
      );
      expect(a.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph(hardBreak, "cd", wikilink, "ef"))',
      );
      const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(5, 6)));
      expect(a.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("cd", wikilink, "ef"))',
      );
      expect(effects.goneLetters).toBe("");
      expect(effects.madeLetters).toBe("");
      expect(effects.gone.items).toBe(1);
      expect(effects.madeBoundaries).toHaveLength(1);
      a.expectMirror();
    });

    it("keeps three shown blocks when a list item's code block becomes a paragraph, and the letter typed with it", () => {
      const a = person(
        noteOfLines([stored({ ...CODE, ...IN_ITEM }, "ab", HARD_BREAK, "cd"), stored({}, "ef")]),
        10,
        shape,
      );
      expect(a.view.state.doc.toString()).toBe(
        'doc(bulletList(listItem(paragraph, codeBlock("ab"), paragraph(hardBreak, "cd"))), paragraph("ef"))',
      );
      a.select([1, 0]);
      const retyped = a.view.state.tr;
      setBlockType(schema.nodes.paragraph!)(a.view.state, (transaction) => {
        for (const step of transaction.steps) retyped.step(step);
      });
      retyped.insertText("!", retyped.doc.content.size - 1);
      const effects = a.effects(() => a.view.dispatch(retyped));
      expect(a.view.state.doc.toString()).toBe(
        'doc(bulletList(listItem(paragraph, paragraph("ab"), paragraph(hardBreak, "cd"))), paragraph("ef!"))',
      );
      expect(effects.madeLetters).toBe("!");
      expect(effects.goneLetters).toBe("");
      expect(pathsOf(a)).toEqual(["L/I", "L/I", "L/I", ""]);
      a.expectMirror();
    });

    it("gives the rest of the text after a deleted rule its own boundary, and deletes the rule's", () => {
      const a = person(noteOfLines([stored(RULE, "abc")]), 10, shape);
      const [rule] = a.boundaryIds();
      const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(0, 4)));
      expect(a.view.state.doc.toString()).toBe('doc(paragraph("c"))');
      expect(effects.goneBoundaries).toEqual([rule]);
      expect(effects.madeBoundaries).toHaveLength(1);
      expect(effects.goneLetters).toBe("ab");
      expect(effects.madeLetters).toBe("");
      expect(a.boundaryLines()).toEqual([{ id: effects.madeBoundaries[0], text: "c" }]);
      a.expectMirror();
    });

    it("does not bring a deleted rule back when someone else changes it at the same moment", () => {
      const a = person(noteOfLines([stored(RULE, "abc")]), 10, shape);
      const b = person(noteOfLines([stored(RULE, "abc")]), 20, shape);
      a.view.dispatch(a.view.state.tr.delete(0, 4));
      b.view.dispatch(b.view.state.tr.setSelection(NodeSelection.create(b.view.state.doc, 0)));
      b.put("mathBlock", { tex: "x" });
      expect(b.blocks()).toEqual(["mathBlock", "paragraph"]);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe('doc(paragraph("c"))');
      }
    });

    it("keeps a line's own boundary when the block above it is deleted with part of the line", () => {
      const a = person(note("abc", "def"), 10, shape);
      const [upper, lower] = a.boundaryIds();
      const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(0, 7)));
      expect(a.lines()).toEqual(["ef"]);
      expect(effects.goneBoundaries).toEqual([upper]);
      expect(effects.madeBoundaries).toEqual([]);
      expect(a.boundaryLines()).toEqual([{ id: lower, text: "ef" }]);
      a.expectMirror();
    });

    it("gives an anchor at the start of a block with no boundary of its own that stays in that block", () => {
      const a = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 10, shape);
      const b = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 20, shape);
      expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab"), paragraph(hardBreak, "cd"))');
      const atStart = bodySequenceAnchor(a.view.state, 5)!;
      const atCodeEnd = bodySequenceAnchor(a.view.state, 3)!;
      expect(bodySequenceAnchorPosition(a.view.state, atStart)).toBe(5);
      expect(bodySequenceAnchorPosition(a.view.state, atCodeEnd)).toBe(3);
      expect(bodySequenceAnchorPosition(b.view.state, atStart)).toBe(5);
      b.typeAt(0, 2, "z");
      exchange(b, a);
      expect(a.lines()).toEqual(["abz", "cd"]);
      expect(bodySequenceAnchorPosition(a.view.state, atStart)).toBe(6);

      const item = () =>
        noteOfLines([
          stored({}, "Top"),
          stored({ type: "heading", level: 2, ...IN_ITEM }, "Title"),
        ]);
      const c = person(item(), 30, shape);
      const d = person(item(), 40, shape);
      expect(c.lines()).toEqual(["Top", "", "Title"]);
      const added = c.view.state.doc.child(0).nodeSize + 3;
      expect(c.view.state.doc.resolve(added).parent.content.size).toBe(0);
      const inAdded = bodySequenceAnchor(c.view.state, added)!;
      const atTopEnd = bodySequenceAnchor(c.view.state, 4)!;
      expect(bodySequenceAnchorPosition(c.view.state, inAdded)).toBe(added);
      expect(bodySequenceAnchorPosition(d.view.state, inAdded)).toBe(added);
      expect(bodySequenceAnchorPosition(c.view.state, atTopEnd)).toBe(4);
    });
  },
);

const ORACLE_NOTES: [string, StoredLine[]][] = [
  ["two paragraphs", [stored({}, "ab"), stored({}, "cd")]],
  [
    "a heading, an empty line and a paragraph",
    [stored({ type: "heading", level: 2 }, "ab"), stored({}), stored({}, "cd")],
  ],
  ["text before the first boundary, then a paragraph", [stored(null, "hh"), stored({}, "ab")]],
  ["code, an inline item, text", [stored(CODE, "ab", HARD_BREAK, "cd")]],
  ["code, an item, text, an item, text", [stored(CODE, "ab", HARD_BREAK, "cd", WIKILINK, "ef")]],
  ["empty code, an item, text", [stored(CODE, HARD_BREAK, "cd")]],
  [
    "a paragraph, code with an item and text, a paragraph",
    [stored({}, "ab"), stored(CODE, "cd", WIKILINK, "ef"), stored({}, "gh")],
  ],
  ["a rule with text", [stored(RULE, "abc")]],
  ["a math block with text", [stored(MATH, "abc")]],
  ["a raw block with an item and text", [stored(RAW, WIKILINK, "ab")]],
  [
    "a paragraph, a rule with text, a paragraph",
    [stored({}, "ab"), stored(RULE, "cd"), stored({}, "ef")],
  ],
  ["two rules, the second with text", [stored(RULE), stored(RULE, "abc")]],
  ["code, then a rule with text", [stored(CODE, "ab"), stored(RULE, "cd")]],
  [
    "a list item whose first block is a heading",
    [stored({}, "ab"), stored({ type: "heading", level: 2, ...IN_ITEM }, "cd"), stored({}, "ef")],
  ],
  [
    "a list item whose first block is code with an item and text",
    [stored({ ...CODE, ...IN_ITEM }, "ab", HARD_BREAK, "cd"), stored({}, "ef")],
  ],
  [
    "a list item whose first block is a rule with text",
    [stored({}, "ab"), stored({ ...RULE, ...IN_ITEM }, "cd")],
  ],
  [
    "a list item with a paragraph and a rule with text",
    [stored(IN_ITEM, "ab"), stored({ ...RULE, ...IN_ITEM }, "cd"), stored({}, "ef")],
  ],
  [
    "a list item with two paragraphs, then a paragraph",
    [stored(IN_ITEM, "ab"), stored(IN_ITEM, "cd"), stored({}, "ef")],
  ],
  [
    "a quote with a rule and text, then a paragraph",
    [stored({ ...RULE, path: ["Q"] }, "ab"), stored({}, "cd")],
  ],
  [
    "a quote with code, an item and text",
    [stored({}, "ab"), stored({ ...CODE, path: ["Q"] }, "cd", HARD_BREAK, "ef")],
  ],
  [
    "code, then a quoted list item whose first block is an empty heading",
    [
      stored(CODE, "ab"),
      stored({ type: "heading", level: 2, path: ["Q", "L", "I"] }),
      stored({}, "cd"),
    ],
  ],
  [
    "code whose letters carry stored formatting, then a paragraph",
    [stored(CODE, "a", { letters: "bc", marks: { bold: {} } }), stored({}, "de")],
  ],
  [
    "a quote that ends with a rule and text, then a quote of its own",
    [stored({ ...RULE, path: ["Q"] }, "ab"), stored({ path: ["Q2"] }, "cd")],
  ],
];

const ADDED_BLOCK_NOTES = [...ORACLE_NOTES];

const SWEPT_ABOVE: [string, StoredLine | null][] = [
  ["nothing", null],
  ["text before the first boundary", stored(null, "hh")],
  ["a paragraph", stored({}, "One")],
  ["a rule", stored(RULE)],
  ["a rule with text", stored(RULE, "zz")],
  ["code", stored(CODE, "cc")],
];
const SWEPT_BLOCKS: [string, Record<string, unknown>, Part[]][] = [
  ["a rule with text", RULE, ["abc"]],
  ["a math block with text", MATH, ["abc"]],
  ["code, an item and text", CODE, ["kk", HARD_BREAK, "abc"]],
];
for (const [aboveName, above] of SWEPT_ABOVE)
  for (const [blockName, block, parts] of SWEPT_BLOCKS)
    for (const inItem of [false, true])
      ORACLE_NOTES.push([
        `${aboveName}, then ${blockName}${inItem ? " in a list item" : ""}`,
        [...(above ? [above] : []), stored(inItem ? { ...block, ...IN_ITEM } : block, ...parts)],
      ]);

const ORACLE_COUNTS = {
  outcomes: {
    applied: 6719,
    "filtered by keepsContainers": 2055,
    "not offered": 587,
    "range error": 0,
  },
  undone: 6289,
  given: 1652,
  excepted: {
    "a mark on an inline item": 467,
    "formatting stored under a code block's letters": 9,
  },
};

const ORACLE_KINDS: [string, Record<string, unknown> | undefined][] = [
  ["paragraph", undefined],
  ["heading", { level: 1 }],
  ["heading", { level: 3 }],
  ["codeBlock", undefined],
];

type MarkDifference = {
  onItem: boolean;
  wasUnderCode: boolean;
  computedHasMarks: boolean;
  readHasMarks: boolean;
};

function markDifferences(
  before: ProseMirrorNode,
  applied: Transaction,
  read: ProseMirrorNode,
): MarkDifference[] | null {
  const computed = applied.doc;
  if (withoutMarks(computed) !== withoutMarks(read)) return null;
  const toBefore = applied.mapping.invert();
  const found: MarkDifference[] = [];
  read.descendants((node, pos) => {
    if (!node.isInline) return true;
    for (let at = 0; at < node.nodeSize; at++) {
      const other = computed.nodeAt(pos + at)!;
      if (Mark.sameSet(node.marks, other.marks)) continue;
      found.push({
        onItem: !node.isText,
        wasUnderCode: before.resolve(toBefore.map(pos + at, 1)).parent.type.spec.code === true,
        computedHasMarks: other.marks.length > 0,
        readHasMarks: node.marks.length > 0,
      });
    }
    return false;
  });
  return found;
}

const ORACLE_EXCEPTIONS: {
  name: string;
  why: string;
  explains: (difference: MarkDifference) => boolean;
}[] = [
  {
    name: "formatting stored under a code block's letters",
    why: "A code block's letters keep the formatting items stored around them, which no reader shows while the block is code. ProseMirror's code block holds no marks, so its document has none on those letters once they leave the code block; the note reads the stored ones again.",
    explains: (difference) =>
      !difference.onItem && difference.wasUnderCode && !difference.computedHasMarks,
  },
  {
    name: "a mark on an inline item",
    why: "ProseMirror puts a mark on an inline item that stands in a marked range. The format gives marks to letters only, so the note reads the item with none.",
    explains: (difference) => difference.onItem && !difference.readHasMarks,
  },
];

/**
 * Each block with no boundary of its own: its path, the ids of the items it shows, in order, and
 * for a block that shows nothing, as a list item's added paragraph does, the id of the item its
 * boundary would stand in front of.
 */
function linesWithNoBoundary(a: Person): { path: string; items: string[]; next?: string }[] {
  const reading = createBodyReader(schema, a.sequence, a.containers).reading();
  const tokens = tokensOf(a.sequence);
  const lines: { path: string; items: string[]; next?: string }[] = [];
  reading.blocks.forEach((block, at) => {
    if (boundaryAt(reading, at) >= 0) return;
    const items = block.shown.flatMap((piece) => {
      const first = reading.bases[at]! + piece.index;
      const size = "text" in piece ? piece.text.length : 1;
      return Array.from({ length: size }, (_, unit) => tokens[first + unit]!.id);
    });
    const next =
      items.length === 0 && reading.lines[at]?.element ? tokens[reading.bases[at]!] : null;
    lines.push({
      path: JSON.stringify(reading.paths[at]),
      items,
      ...(next ? { next: next.id } : {}),
    });
  });
  return lines;
}

const attrsOfBoundary = (token: { attrs: string }) =>
  Object.fromEntries(JSON.parse(token.attrs) as [string, unknown][]) as {
    path?: unknown;
    type?: unknown;
  };

type Outcome = "applied" | "filtered by keepsContainers" | "not offered" | "range error";
const oracle = {
  notes: 0,
  outcomes: { applied: 0, "filtered by keepsContainers": 0, "not offered": 0, "range error": 0 },
  excepted: new Map<string, number>(),
  undone: 0,
  given: 0,
};

describe("the note reads as the document ProseMirror computed", () => {
  it.each(ORACLE_NOTES)("for every step tried in %s", (_name, lines) => {
    const baseline = noteOfLines(lines);
    const start = readBodySequence(schema, person(baseline, 10).doc);
    stopEveryone();
    const size = start.content.size;
    const inText: number[] = [];
    for (let pos = 0; pos <= size; pos++)
      if (start.resolve(pos).parent.isTextblock) inText.push(pos);

    const check = (label: string, act: (a: Person) => void) => {
      const a = person(baseline, 10);
      const before = a.view.state.doc;
      const lacking = linesWithNoBoundary(a);
      let applied: Transaction | null = null;
      let filtered: Transaction | null = null;
      const dispatch = a.view.dispatch.bind(a.view);
      a.view.dispatch = (transaction) => {
        if (transaction.docChanged && !isBodySequenceChange(transaction)) {
          if (a.view.state.applyTransaction(transaction).transactions.length > 0)
            applied = transaction;
          else filtered = transaction;
        }
        dispatch(transaction);
      };
      let outcome: Outcome = "not offered";
      try {
        act(a);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        outcome = "range error";
      }
      const wrote = applied as Transaction | null;
      const refused = filtered as Transaction | null;
      if (wrote) {
        outcome = "applied";
        a.expectMirror();
        const read = readBodySequence(schema, a.doc);
        if (!read.eq(wrote.doc)) {
          const differences = markDifferences(before, wrote, read);
          const names = new Set<string>();
          const unexplained =
            differences === null ||
            differences.some((difference) => {
              const exception = ORACLE_EXCEPTIONS.find((each) => each.explains(difference));
              if (exception) names.add(exception.name);
              return !exception;
            });
          if (unexplained)
            throw new Error(
              `${label} in ${before.toString()}\n  ProseMirror computed ${wrote.doc.toString()}\n  the note reads as     ${read.toString()}`,
            );
          for (const name of names) oracle.excepted.set(name, (oracle.excepted.get(name) ?? 0) + 1);
        }
        expect(a.sent.length, label).toBeLessThanOrEqual(2);
        if (a.sent.length === 2) oracle.given += 1;
        const tokens = tokensOf(a.sequence);
        const givenFirst = a.sent.length === 2 ? boundariesMadeIn(a.sent[0]!) : [];
        for (const made of a.sent.length > 0 ? boundariesMadeIn(a.sent.at(-1)!) : []) {
          const at = tokens.findIndex((token) => token.id === made);
          const next = tokens[at + 1];
          const own = tokens[at];
          if (!next || !own || own.kind !== "boundary") continue;
          const attrs = attrsOfBoundary(own);
          let above = at - 1;
          while (tokens[above]?.kind === "boundary" && !givenFirst.includes(tokens[above]!.id))
            above -= 1;
          const wasGivenItsOwn = givenFirst.includes(tokens[above]?.id ?? "");
          const standing = new Set(tokens.map((token) => token.id));
          const isItsOwn =
            !wasGivenItsOwn &&
            lacking.some((line) => {
              if (line.path !== JSON.stringify(attrs.path)) return false;
              if (line.next !== undefined)
                return line.next === next.id && attrs.type === "paragraph";
              return line.items.find((id) => standing.has(id)) === next.id;
            });
          if (isItsOwn)
            throw new Error(
              `${label} in ${before.toString()}: the recorded change wrote the boundary of a line that had none`,
            );
        }
        if (a.undo()) {
          a.expectMirror();
          const undone = readBodySequence(schema, a.doc);
          if (!undone.eq(before))
            throw new Error(
              `${label} in ${before.toString()}\n  after its undo the note reads as ${undone.toString()}`,
            );
          oracle.undone += 1;
        }
      } else if (refused) {
        const docs = [...refused.docs, refused.doc];
        const byContainers = refused.steps.some(
          (step, at) => !keepsContainers(step, docs[at]!, docs[at + 1]!, () => false),
        );
        if (!byContainers)
          throw new Error(`${label} in ${before.toString()} was refused for no listed reason`);
        outcome = "filtered by keepsContainers";
      }
      oracle.outcomes[outcome] += 1;
      stopEveryone();
    };
    const select = (a: Person, from: number, to = from) =>
      a.view.dispatch(
        a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, from, to)),
      );

    for (let from = 0; from < size; from++)
      for (let to = from + 1; to <= size; to++)
        check(`delete(${String(from)}, ${String(to)})`, (a) =>
          a.view.dispatch(a.view.state.tr.delete(from, to)),
        );
    const places = textPlaces(start);
    const ranges: [number, number][] = places.map((place) => [place.pos, place.pos]);
    if (places.length > 1) {
      const last = places.at(-1)!;
      ranges.push([places[0]!.pos, last.pos + last.size]);
      ranges.push([places[0]!.pos, places[1]!.pos + places[1]!.size]);
    }
    for (const [from, to] of ranges)
      for (const [kind, attrs] of ORACLE_KINDS)
        check(`${kind}${JSON.stringify(attrs ?? {})} over ${String(from)}-${String(to)}`, (a) => {
          select(a, from, to);
          a.retype(kind, attrs);
        });
    for (const pos of inText) {
      check(`Enter at ${String(pos)}`, (a) => {
        select(a, pos);
        a.press("Enter");
      });
      check(`a letter at ${String(pos)}`, (a) =>
        a.view.dispatch(a.view.state.tr.insertText("x", pos)),
      );
      for (const to of inText)
        if (to > pos)
          check(`bold over ${String(pos)}-${String(to)}`, (a) => {
            select(a, pos, to);
            a.toggle("bold");
          });
    }
    oracle.notes += 1;
  });

  it("applies, refuses and excepts as many steps as counted", () => {
    console.log(
      `the oracle run: ${String(oracle.notes)} notes; ${Object.entries(oracle.outcomes)
        .map(([outcome, count]) => `${outcome} ${String(count)}`)
        .join(
          ", ",
        )}; undone and read as before ${String(oracle.undone)}; a line given its boundary first ${String(oracle.given)}; exceptions: ${
        [...oracle.excepted].map(([name, count]) => `${name} (${String(count)})`).join("; ") ||
        "none"
      }`,
    );
    if (oracle.notes !== ORACLE_NOTES.length) return;
    expect(oracle.outcomes).toEqual(ORACLE_COUNTS.outcomes);
    expect(oracle.undone).toBe(ORACLE_COUNTS.undone);
    expect(oracle.given).toBe(ORACLE_COUNTS.given);
    expect(Object.fromEntries(oracle.excepted)).toEqual(ORACLE_COUNTS.excepted);
  });
});

describe.each(["bare", "hosted"] as const)("one dispatch of the editor on a %s page", (shape) => {
  const replacesXWithZ = () =>
    new Plugin({
      appendTransaction(transactions, _before, state) {
        if (!transactions.some((transaction) => transaction.getMeta("replaceX") === true))
          return null;
        return state.tr.insertText("Z", 2, 3).setMeta("addToHistory", false);
      },
    });
  const typeX = (a: Person) =>
    a.view.dispatch(a.view.state.tr.insertText("X", 2).setMeta("replaceX", true));

  it("is one update and one undo step, also for what a plugin appended to it outside the history", () => {
    const a = person(note("abc"), 10, shape, [replacesXWithZ()]);
    const peer = page(note("abc"), 20);
    typeX(a);
    expect(a.lines()).toEqual(["aZbc"]);
    expect(a.sent).toHaveLength(1);
    peer.receive(a.sent[0]!);
    expect(readBodySequence(schema, peer.doc).textContent).toBe("aZbc");
    expect(a.history.undoStack).toHaveLength(1);
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["abc"]);
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(true);
    expect(a.lines()).toEqual(["aZbc"]);
    a.expectMirror();
  });

  it("is not undoable when every transaction in it is kept out of the history", () => {
    const a = person(note("abc"), 10, shape);
    a.view.dispatch(a.view.state.tr.insertText("Q", 1).setMeta("addToHistory", false));
    expect(a.lines()).toEqual(["Qabc"]);
    expect(a.sent).toHaveLength(1);
    expect(a.history.undoStack).toHaveLength(0);
    expect(a.undo()).toBe(false);
    expect(a.lines()).toEqual(["Qabc"]);
    a.expectMirror();
  });

  it("loses nothing when a change from someone else arrives while its update is sent", () => {
    const a = person(note("abc"), 10, shape, [replacesXWithZ()]);
    const b = person(note("abc"), 20, shape);
    b.typeAt(0, 0, "!");
    const fromPeer = b.sent.splice(0);
    let delivered = false;
    a.doc.on("update", () => {
      if (delivered) return;
      delivered = true;
      for (const update of fromPeer) a.receive(update);
    });
    typeX(a);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.lines()).toEqual(["!aZbc"]);
    }
    expect(tokensOf(b.sequence)).toEqual(tokensOf(a.sequence));
  });

  it("is written whole when the editor is destroyed while its update is sent", () => {
    const a = person(note("abc"), 10, shape, [replacesXWithZ()]);
    const b = person(note("abc"), 20, shape);
    let destroyed = false;
    a.doc.on("update", () => {
      if (destroyed) return;
      destroyed = true;
      a.view.destroy();
    });
    typeX(a);
    expect(readBodySequence(schema, a.doc).textContent).toBe("aZbc");
    for (const update of a.sent.splice(0)) b.receive(update);
    b.expectMirror();
    expect(b.lines()).toEqual(["aZbc"]);
  });

  it("writes nothing and takes no undo step for a step that leaves the document as it was", () => {
    const a = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 10, shape);
    a.typeAt(1, 3, "!");
    expect(a.lines()).toEqual(["ab", "cd!"]);
    const before = a.view.state.doc;
    const steps = a.history.undoStack.length;
    a.view.dispatch(a.view.state.tr.setSelection(TextSelection.create(before, 3, 5)));
    const effects = a.effects(() => expect(a.press("Delete")).toBe(true));
    expect(effects).toMatchObject({ made: quiet(), gone: quiet(), other: 0, shown: 0 });
    expect(a.view.state.doc.eq(before)).toBe(true);
    expect(a.history.undoStack).toHaveLength(steps);
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["ab", "cd"]);
    a.expectMirror();
  });
});

describe("an anchor", () => {
  it("stays in a list item's added paragraph when someone types there", () => {
    const item = () => noteOfLines([stored({ type: "heading", level: 2, ...IN_ITEM }, "Title")]);
    const a = person(item(), 10);
    const b = person(item(), 20);
    expect(a.view.state.doc.toString()).toBe(
      'doc(bulletList(listItem(paragraph, heading("Title"))))',
    );
    const anchor = bodySequenceAnchor(a.view.state, 3)!;
    expect(bodySequenceAnchorPosition(a.view.state, anchor)).toBe(3);
    a.view.dispatch(a.view.state.tr.insertText("!", 3));
    expect(a.view.state.doc.toString()).toBe(
      'doc(bulletList(listItem(paragraph("!"), heading("Title"))))',
    );
    expect(bodySequenceAnchorPosition(a.view.state, anchor)).toBe(4);
    exchange(a, b);
    expect(bodySequenceAnchorPosition(b.view.state, anchor)).toBe(4);
  });

  it("reads the association a caller gives by its sign alone", () => {
    const a = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 10);
    const resolved = (pos: number, assoc?: number) =>
      bodySequenceAnchorPosition(a.view.state, bodySequenceAnchor(a.view.state, pos, assoc)!);
    for (const assoc of [undefined, 0, 1, 2, 7]) {
      expect(resolved(3, assoc)).toBe(3);
      expect(resolved(5, assoc)).toBe(5);
    }
    expect(resolved(3, -1)).toBe(3);
    expect(resolved(5, -1)).toBe(3);
    expect(resolved(6, 1)).toBe(6);
  });
});

const LIST_NOTE: StoredLine[] = [
  stored({}, "top"),
  stored({ type: "heading", level: 2, ...IN_ITEM }, "Title"),
  stored(IN_ITEM, "tail"),
  stored({}, "end"),
];
const CODE_NOTE: StoredLine[] = [stored(CODE, "ab", HARD_BREAK, "cdxy"), stored({}, "end")];
const boundariesMadeIn = (update: Uint8Array) =>
  Y.decodeUpdate(update).structs.flatMap((struct) =>
    struct instanceof Y.Item &&
    struct.content instanceof Y.ContentType &&
    struct.content.type instanceof Y.XmlElement &&
    struct.content.type.nodeName === BLOCK_ELEMENT
      ? [`${String(struct.id.client)}:${String(struct.id.clock)}`]
      : [],
  );
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

describe.each(["bare", "hosted"] as const)(
  "on a %s page, undo and a boundary made for a line that had none",
  (shape) => {
    it.each([
      [
        "a list item's added first paragraph",
        LIST_NOTE,
        'doc(paragraph("top"), bulletList(listItem(paragraph("B"), heading("Title"), paragraph("tail"))), paragraph("end"))',
      ],
      [
        "the paragraph after a code block",
        CODE_NOTE,
        'doc(codeBlock("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
      ],
    ])(
      "keeps a peer's letter in %s when the letter typed before it is undone",
      (_name, lines, left) => {
        const a = person(noteOfLines(lines), 10, shape);
        const b = person(noteOfLines(lines), 20, shape);
        a.typeAt(1, 0, "A");
        exchange(a, b);
        b.typeAt(1, 1, "B");
        exchange(b, a);
        expect(a.lines()[1]!.startsWith("AB")).toBe(true);
        expect(a.undo()).toBe(true);
        exchange(a, b);
        for (const each of [a, b]) {
          each.expectMirror();
          expect(each.view.state.doc.toString()).toBe(left);
        }
      },
    );

    it.each([
      ["a list item's added first paragraph", LIST_NOTE],
      ["the paragraph after a code block", CODE_NOTE],
    ])(
      "reads as before after undo of a letter typed in %s, and has it back after redo",
      (_name, lines) => {
        const a = person(noteOfLines(lines), 10, shape);
        const before = a.view.state.doc.toJSON();
        const boundaries = a.boundaryIds().length;
        a.typeAt(1, 0, "A");
        expect(a.boundaryIds()).toHaveLength(boundaries + 1);
        expect(a.undo()).toBe(true);
        expect(a.view.state.doc.toJSON()).toEqual(before);
        expect(a.boundaryIds()).toHaveLength(boundaries + 1);
        a.expectMirror();
        expect(a.redo()).toBe(true);
        expect(a.lines()[1]!.startsWith("A")).toBe(true);
        a.expectMirror();
        expect(a.undo()).toBe(true);
        expect(a.undo()).toBe(false);
        expect(a.view.state.doc.toJSON()).toEqual(before);
      },
    );

    it("takes back a kind change of such a line, and leaves the line the boundary it was given", () => {
      const a = person(noteOfLines(CODE_NOTE), 10, shape);
      const before = a.view.state.doc.toJSON();
      const [code, end] = a.boundaryIds();
      a.select([1, 1]);
      const effects = a.effects(() => a.retype("heading", { level: 2 }));
      expect(a.blocks()).toEqual(["codeBlock", "h2", "paragraph"]);
      expect(a.sent).toHaveLength(2);
      expect(a.history.undoStack).toHaveLength(1);
      const [given] = effects.madeBoundaries;
      expect(boundariesMadeIn(a.sent[0]!)).toEqual([given]);
      expect(boundariesMadeIn(a.sent[1]!)).toEqual([]);
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      expect(a.boundaryIds()).toEqual([code, given, end]);
      a.expectMirror();
      expect(a.redo()).toBe(true);
      expect(a.blocks()).toEqual(["codeBlock", "h2", "paragraph"]);
      expect(a.boundaryIds()).toEqual([code, given, end]);
      a.expectMirror();
    });

    it.each([
      [
        "changes the kind of",
        (a: Person) => {
          a.select([0, 1]);
          a.retype("paragraph");
        },
        'doc(paragraph("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
      ],
      [
        "ends with a new line",
        (a: Person) =>
          a.view.dispatch(
            a.view.state.tr.insert(
              a.view.state.doc.child(0).nodeSize,
              schema.nodes.paragraph!.create(),
            ),
          ),
        'doc(codeBlock("ab"), paragraph, paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
      ],
      [
        "deletes",
        (a: Person) =>
          a.view.dispatch(a.view.state.tr.delete(0, a.view.state.doc.child(0).nodeSize)),
        'doc(paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
      ],
    ])(
      "gives the paragraph after a code block its boundary before a change that %s the code block, so a peer's letter stays in it through the undo",
      (_name, act, changed) => {
        const a = person(noteOfLines(CODE_NOTE), 10, shape);
        const b = person(noteOfLines(CODE_NOTE), 20, shape);
        act(a);
        expect(a.sent).toHaveLength(2);
        expect(a.history.undoStack).toHaveLength(1);
        const [given] = boundariesMadeIn(a.sent[0]!);
        expect(a.boundaryLines().find((line) => line.id === given)?.text).toBe("cdxy");
        exchange(a, b);
        b.typeAt(b.lines().indexOf("cdxy"), 0, "B");
        exchange(b, a);
        expect(a.view.state.doc.toString()).toBe(changed);
        expect(a.undo()).toBe(true);
        exchange(a, b);
        for (const each of [a, b]) {
          each.expectMirror();
          expect(each.view.state.doc.toString()).toBe(
            'doc(codeBlock("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
          );
          expect(each.boundaryIds()).toHaveLength(3);
          expect(each.boundaryIds()).toContain(given);
        }
      },
    );

    it.each([
      [
        "makes the code block a paragraph and types at that paragraph's start",
        (b: Person) => {
          b.select([0, 1]);
          b.retype("paragraph");
          b.typeAt(1, 0, "B");
        },
        'doc(paragraph("ab"), paragraph(hardBreak, "Bcdxy"), paragraph("end"))',
      ],
      [
        "makes that paragraph a heading",
        (b: Person) => {
          b.select([1, 1]);
          b.retype("heading", { level: 2 });
        },
        'doc(codeBlock("ab"), heading(hardBreak, "cdxy"), paragraph("end"))',
      ],
    ])(
      "gives the paragraph after a code block its boundary before its leading item is deleted, so undo leaves it a line when someone else %s",
      (_name, act, undone) => {
        const a = person(noteOfLines(CODE_NOTE), 10, shape);
        const b = person(noteOfLines(CODE_NOTE), 20, shape);
        const hardBreak = a.view.state.doc.child(0).nodeSize + 1;
        a.view.dispatch(a.view.state.tr.delete(hardBreak, hardBreak + 1));
        expect(a.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("cdxy"), paragraph("end"))',
        );
        expect(a.sent).toHaveLength(2);
        expect(boundariesMadeIn(a.sent[0]!)).toHaveLength(1);
        expect(boundariesMadeIn(a.sent[1]!)).toEqual([]);
        exchange(a, b);
        act(b);
        exchange(b, a);
        expect(a.undo()).toBe(true);
        exchange(a, b);
        for (const each of [a, b]) {
          each.expectMirror();
          expect(each.view.state.doc.toString()).toBe(undone);
        }
      },
    );

    it("keeps a peer's letter in the paragraph after a code block when that paragraph's kind change is undone, and when it is redone", () => {
      const a = person(noteOfLines(CODE_NOTE), 10, shape);
      const b = person(noteOfLines(CODE_NOTE), 20, shape);
      a.select([1, 1]);
      a.retype("heading", { level: 2 });
      exchange(a, b);
      b.typeAt(1, 0, "B");
      exchange(b, a);
      expect(a.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
        );
      }
      expect(a.redo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), heading("B", hardBreak, "cdxy"), paragraph("end"))',
        );
      }
    });

    it("keeps a peer's letter in that paragraph after its boundary was deleted and undo brought it back", () => {
      const a = person(noteOfLines(CODE_NOTE), 10, shape);
      const b = person(noteOfLines(CODE_NOTE), 20, shape);
      a.typeAt(1, 0, "A");
      a.view.dispatch(a.view.state.tr.setSelection(new AllSelection(a.view.state.doc)));
      expect(a.press("Backspace")).toBe(true);
      expect(a.view.state.doc.textContent).toBe("");
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("A", hardBreak, "cdxy"), paragraph("end"))',
      );
      exchange(a, b);
      b.typeAt(1, 1, "B");
      exchange(b, a);
      expect(a.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
        );
      }
      expect(a.redo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("AB", hardBreak, "cdxy"), paragraph("end"))',
        );
      }
    });

    it("keeps a letter there when someone with a history of their own on the same document joined the line away and undid that", () => {
      const base = page(noteOfLines(CODE_NOTE), 10, shape);
      const a = editorOn(base, shape);
      const b = editorOn(base, shape);
      a.typeAt(1, 0, "A");
      const withA = a.view.state.doc.toString();
      expect(withA).toBe(
        'doc(codeBlock("ab"), paragraph("A", hardBreak, "cdxy"), paragraph("end"))',
      );
      b.join(1);
      expect(b.blocks()).toEqual(["codeBlock", "paragraph"]);
      expect(b.undo()).toBe(true);
      expect(b.view.state.doc.toString()).toBe(withA);
      b.typeAt(1, 1, "B");
      expect(a.undo()).toBe(true);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("B", hardBreak, "cdxy"), paragraph("end"))',
        );
      }
    });

    it("reads a peer's letter as a paragraph of its own, B / hh / ab, when Enter at the start of text before the first boundary is undone", () => {
      const head = [stored(null, "hh"), stored({}, "ab")];
      const a = person(noteOfLines(head), 10, shape);
      const b = person(noteOfLines(head), 20, shape);
      const [ab] = a.boundaryIds();
      a.select([0, 0]);
      expect(a.press("Enter")).toBe(true);
      expect(a.sent).toHaveLength(2);
      const [split, given] = a.boundaryIds();
      expect(boundariesMadeIn(a.sent[0]!)).toEqual([given]);
      expect(boundariesMadeIn(a.sent[1]!)).toEqual([split]);
      expect(a.boundaryLines()).toEqual([
        { id: split, text: "" },
        { id: given, text: "hh" },
        { id: ab, text: "ab" },
      ]);
      exchange(a, b);
      b.typeAt(0, 0, "B");
      exchange(b, a);
      expect(a.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual(["B", "hh", "ab"]);
        expect(each.boundaryLines()).toEqual([
          { id: null, text: "B" },
          { id: given, text: "hh" },
          { id: ab, text: "ab" },
        ]);
      }
    });

    it("reads as before when a kind change that drops an image and a letter typed in the line after it are both undone", () => {
      const image: Part = ["image", { src: "/a.png", alt: "A", title: null }];
      const a = person(noteOfLines([stored({}, "a", image, "b"), stored({}, "z")]), 10, shape);
      const before = a.view.state.doc.toJSON();
      expect(a.view.state.doc.toString()).toBe('doc(paragraph("a", image, "b"), paragraph("z"))');
      a.select([0, 1]);
      a.retype("codeBlock");
      expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab"), paragraph("z"))');
      a.expectMirror();
      a.typeAt(1, 0, "X");
      expect(a.undo()).toBe(true);
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      a.expectMirror();
    });

    it("reads as before when a kind change of a code block and a letter typed at the start of the paragraph after it are both undone", () => {
      const image: Part = ["image", { src: "/a.png", alt: "A", title: null }];
      const a = person(noteOfLines([stored(CODE, "a", image, "b")]), 10, shape);
      const before = a.view.state.doc.toJSON();
      expect(a.view.state.doc.toString()).toBe('doc(codeBlock("a"), paragraph(image, "b"))');
      a.select([0, 1]);
      a.retype("paragraph");
      expect(a.view.state.doc.toString()).toBe('doc(paragraph("a"), paragraph(image, "b"))');
      a.expectMirror();
      a.typeAt(1, 0, "X");
      expect(a.undo()).toBe(true);
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      a.expectMirror();
    });

    it("puts a peer's letter below a rule that undo brings back, ab / rule / B / cd, with nothing lost or doubled (a known behaviour of Yjs)", () => {
      const lines = [stored({}, "ab"), stored(RULE, "cd")];
      const a = person(noteOfLines(lines), 10, shape);
      const b = person(noteOfLines(lines), 20, shape);
      expect(a.view.state.doc.toString()).toBe(
        'doc(paragraph("ab"), horizontalRule, paragraph("cd"))',
      );
      a.select([2, 0]);
      expect(a.press("Backspace")).toBe(true);
      exchange(a, b);
      expect(b.view.state.doc.toString()).toBe('doc(paragraph("ab"), paragraph("cd"))');
      b.typeAt(0, 2, "B");
      exchange(b, a);
      expect(a.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(paragraph("ab"), horizontalRule, paragraph("B"), paragraph("cd"))',
        );
      }
      expect(a.redo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe('doc(paragraph("abB"), paragraph("cd"))');
      }
    });

    it("takes back the split and keeps the line's own boundary for Enter at the start of the paragraph after a code block", () => {
      const a = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 10, shape);
      const before = a.view.state.doc.toJSON();
      a.select([1, 0]);
      expect(a.press("Enter")).toBe(true);
      expect(a.blocks()).toEqual(["codeBlock", "paragraph", "paragraph"]);
      expect(a.boundaryIds()).toHaveLength(3);
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      expect(a.boundaryIds()).toHaveLength(2);
      a.expectMirror();
    });
  },
);

describe.each(["bare", "hosted"] as const)(
  "on a %s page, a dispatch while Yjs tells of a transaction",
  (shape) => {
    it("is refused, so a change taken from a peer in the update callback cannot bisect a letter", () => {
      const start = `a${String.fromCodePoint(0x1f600)}bc`;
      const a = person(note(start), 10, shape);
      const b = person(note(start), 20, shape);
      b.typeAt(0, 0, "!");
      const fromPeer = b.sent.splice(0);
      let delivered = false;
      a.doc.on("update", () => {
        if (delivered) return;
        delivered = true;
        for (const update of fromPeer) a.receive(update);
        a.view.dispatch(a.view.state.tr.insertText("Y", 5));
      });
      a.view.dispatch(a.view.state.tr.insertText("X", 2));
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual([`!aX${String.fromCodePoint(0x1f600)}bc`]);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
      a.typeAt(0, 3, "Y");
      expect(a.lines()).toEqual([`!aXY${String.fromCodePoint(0x1f600)}bc`]);
      a.expectMirror();
    });

    it("is refused from afterTransaction, so no peer reads a state the writer never showed", () => {
      const a = person(note("abc"), 10, shape);
      const peer = page(note("abc"), 20);
      let replaced = false;
      a.doc.on("afterTransaction", () => {
        if (replaced) return;
        replaced = true;
        a.view.dispatch(a.view.state.tr.insertText("Z", 2, 3));
      });
      a.view.dispatch(a.view.state.tr.insertText("X", 2));
      const seen = a.sent.map((update) => {
        peer.receive(update);
        return readBodySequence(schema, peer.doc).textContent;
      });
      expect(replaced).toBe(true);
      expect(seen).toEqual(["aXbc"]);
      expect(a.lines()).toEqual(["aXbc"]);
      a.expectMirror();
    });

    it("refuses an undo asked for from Yjs's update callback or inside an open Yjs transaction, so the redo is not lost", () => {
      const a = person(note("ab"), 10, shape);
      let fromUpdate: boolean | null = null;
      a.doc.on("update", () => {
        fromUpdate ??= a.undo();
      });
      a.typeAt(0, 1, "X");
      expect(fromUpdate).toBe(false);
      expect(a.lines()).toEqual(["aXb"]);
      let inside = true;
      a.doc.transact(() => {
        inside = a.undo();
      });
      expect(inside).toBe(false);
      expect(a.lines()).toEqual(["aXb"]);
      expect(a.undo()).toBe(true);
      expect(a.lines()).toEqual(["ab"]);
      let redoInside = true;
      a.doc.transact(() => {
        redoInside = a.redo();
      });
      expect(redoInside).toBe(false);
      expect(a.redo()).toBe(true);
      expect(a.lines()).toEqual(["aXb"]);
      a.expectMirror();
    });

    it("writes what a plugin dispatches from its own view update with the edit that caused it", () => {
      let added = false;
      const addsYAtEnd = new Plugin({
        view: () => ({
          update(view) {
            if (added || !view.state.doc.textContent.includes("X")) return;
            added = true;
            view.dispatch(
              view.state.tr
                .insertText("Y", view.state.doc.content.size - 1)
                .setMeta("addToHistory", false),
            );
          },
        }),
      });
      const a = person(note("abc"), 10, shape, [], [addsYAtEnd]);
      a.view.dispatch(a.view.state.tr.insertText("X", 2));
      expect(a.lines()).toEqual(["aXbcY"]);
      expect(a.sent).toHaveLength(1);
      expect(a.history.undoStack).toHaveLength(1);
      a.expectMirror();
      expect(a.undo()).toBe(true);
      expect(a.lines()).toEqual(["abc"]);
      expect(a.undo()).toBe(false);
    });
  },
);

const EMOJI = String.fromCodePoint(0x1f600);

function placeOfText(doc: ProseMirrorNode, text: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.isText && node.text!.includes(text))
      found = pos + node.text!.indexOf(text);
    return found < 0;
  });
  if (found < 0) throw new Error(`no ${text} in ${doc.toString()}`);
  return found;
}

describe.each(["bare", "hosted"] as const)(
  "on a %s page, a change the editor has not shown yet",
  (shape) => {
    it("shows two changes of a peer at once, and applies nothing a plugin adds while they are shown", () => {
      let tried = 0;
      const addsYBeforeTheEmoji = new Plugin({
        appendTransaction(transactions, _before, state) {
          const text = state.doc.textContent;
          if (!transactions.some(isBodySequenceChange) || !text.includes("X")) return null;
          tried += 1;
          return state.tr.insertText("Y", placeOfText(state.doc, EMOJI));
        },
      });
      const lines = ["top", `!a${EMOJI}bc`];
      const a = person(note(...lines), 10, shape, [addsYBeforeTheEmoji]);
      const b = person(note(...lines), 20, shape);
      b.typeAt(0, 0, "X");
      const mark = placeOfText(b.view.state.doc, "!");
      b.view.dispatch(b.view.state.tr.delete(mark, mark + 1));
      const fromPeer = b.sent.splice(0);
      expect(fromPeer).toHaveLength(2);
      let delivered = false;
      a.doc.on("update", () => {
        if (delivered) return;
        delivered = true;
        for (const update of fromPeer) a.receive(update);
      });
      const shownBefore = a.shown.count;
      a.typeAt(0, 3, "q");
      expect(tried).toBe(1);
      expect(a.shown.count - shownBefore).toBe(1);
      expect(a.sent).toHaveLength(1);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual(["Xtopq", `a${EMOJI}bc`]);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
    });

    it("refuses the next key press after a listener of the host threw from Yjs's update callback, so nothing is typed that nobody else gets", () => {
      const a = person(note("abc"), 10, shape);
      const b = person(note("abc"), 20, shape);
      let thrown = false;
      a.doc.on("update", () => {
        if (thrown) return;
        thrown = true;
        throw new Error("the host's listener");
      });
      a.select([0, 0]);
      expect(() => a.type("A")).toThrow("the host's listener");
      expect(a.lines()).toEqual(["Aabc"]);
      exchange(a, b);
      a.typeAt(0, 1, "B");
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual(["Aabc"]);
      }
      expect(a.undo()).toBe(false);
      expect(a.lines()).toEqual(["Aabc"]);
    });

    it("writes nothing when a peer's change lands in the very transaction an edit was to be written in", () => {
      const start = `a${EMOJI}bc`;
      const a = person(note(start), 10, shape);
      const b = person(note(start), 20, shape);
      b.typeAt(0, 0, "!");
      const fromPeer = b.sent.splice(0);
      let delivered = false;
      a.doc.on("beforeTransaction", () => {
        if (delivered) return;
        delivered = true;
        for (const update of fromPeer) a.receive(update);
      });
      a.view.dispatch(a.view.state.tr.insertText("Y", 4));
      expect(delivered).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual([`!${start}`]);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
    });

    it("writes no boundary when a peer's change lands in the transaction that was to give a line its boundary", () => {
      const lines = [stored(CODE, `x${EMOJI}`, HARD_BREAK, "cd")];
      const a = person(noteOfLines(lines), 10, shape);
      const b = person(noteOfLines(lines), 20, shape);
      b.typeAt(0, 0, "!");
      const fromPeer = b.sent.splice(0);
      a.select([1, 0]);
      let delivered = false;
      a.doc.on("beforeTransaction", () => {
        if (delivered) return;
        delivered = true;
        for (const update of fromPeer) a.receive(update);
      });
      a.type("A");
      expect(delivered).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          `doc(codeBlock("!x${EMOJI}"), paragraph(hardBreak, "cd"))`,
        );
        expect(each.boundaryIds()).toHaveLength(1);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
    });

    it("does not run in circles when a plugin adds to every showing of the note and the host's guard runs no change", () => {
      const addsAMark = new Plugin({
        appendTransaction(_transactions, _before, state) {
          const text = state.doc.textContent;
          return text.includes("x") && !text.includes("!") ? state.tr.insertText("!", 1) : null;
        },
      });
      const base = page(note("abc"), 10, shape);
      const a = editorOn(base, shape, [addsAMark], [], { edit: () => false });
      const b = person(note("abc"), 20, shape);
      b.typeAt(0, 0, "x");
      exchange(b, a);
      expect(a.lines()).toEqual(["xabc"]);
      expect(a.sent).toEqual([]);
      a.expectMirror();
    });

    it("does not run in circles when a plugin puts a mark the format does not keep on every image", () => {
      const marksImages = new Plugin({
        appendTransaction(_transactions, _before, state) {
          let at = -1;
          state.doc.descendants((node, pos) => {
            if (at < 0 && node.type.name === "image" && node.marks.length === 0) at = pos;
          });
          return at < 0 ? null : state.tr.addNodeMark(at, schema.marks.bold!.create());
        },
      });
      const a = person(note("abc"), 10, shape, [marksImages]);
      a.select([0, 1]);
      a.put("image", { src: "/a.png", alt: "A", title: null });
      expect(a.view.state.doc.toString()).toBe('doc(paragraph("a", image, "bc"))');
      expect(a.view.state.doc.child(0).child(1).marks).toEqual([]);
      a.expectMirror();
    });

    it("writes nothing from an editor that shows another editor's change to the same document, so no peer reads half a change", () => {
      const replacesXWithY = new Plugin({
        appendTransaction(transactions, _before, state) {
          if (!transactions.some(isBodySequenceChange)) return null;
          if (!state.doc.textContent.includes("X")) return null;
          const at = placeOfText(state.doc, "X");
          return state.tr.insertText("Y", at, at + 1);
        },
      });
      const base = page(note("abc"), 10, shape);
      const a = editorOn(base, shape);
      const b = editorOn(base, shape, [replacesXWithY]);
      const third = page(note("abc"), 30);
      a.typeAt(0, 1, "X");
      const seen = base.sent.splice(0).map((update) => {
        third.receive(update);
        return readBodySequence(schema, third.doc).textContent;
      });
      expect(seen).toEqual(["aXbc"]);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual(["aXbc"]);
      }
    });

    it("shows a peer's change although a listener registered before the editor's threw in afterTransaction, so the next key press cuts no letter", () => {
      const start = `a${EMOJI}bc`;
      const base = page(note(start), 10, shape);
      let armed = false;
      base.doc.on("afterTransaction", () => {
        if (!armed) return;
        armed = false;
        throw new Error("the host's listener");
      });
      const a = editorOn(base, shape);
      const b = person(note(start), 20, shape);
      b.typeAt(0, 0, "!");
      armed = true;
      expect(() => exchange(b, a)).toThrow("the host's listener");
      expect(a.lines()).toEqual([`!${start}`]);
      a.view.dispatch(
        a.view.state.tr.insertText("X", placeOfText(a.view.state.doc, EMOJI) + EMOJI.length),
      );
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual([`!a${EMOJI}Xbc`]);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
    });

    it("drops a dispatch when a peer's change arrives between the boundary it gives a line and its own change", () => {
      const head = [stored(null, `h${EMOJI}h`), stored({}, "ab")];
      const a = person(noteOfLines(head), 10, shape);
      const b = person(noteOfLines(head), 20, shape);
      b.typeAt(0, 1, "!");
      const fromPeer = b.sent.splice(0);
      let delivered = false;
      a.doc.on("update", () => {
        if (delivered) return;
        delivered = true;
        for (const update of fromPeer) a.receive(update);
      });
      a.select([0, 0]);
      a.press("Enter");
      expect(delivered).toBe(true);
      expect(a.lines()).toEqual([`h!${EMOJI}h`, "ab"]);
      expect(a.sent).toHaveLength(1);
      expect(a.history.undoStack).toHaveLength(0);
      a.expectMirror();
      a.select([0, 0]);
      a.press("Enter");
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.lines()).toEqual(["", `h!${EMOJI}h`, "ab"]);
        expect(loneSurrogate.test(each.sequence.toString())).toBe(false);
      }
    });

    it("shows the note as it stands when the host's guard does not run the change", () => {
      const base = page(note("abc"), 10, shape);
      let allowed = false;
      const a = editorOn(base, shape, [], [], {
        edit(change) {
          if (allowed) base.doc.transact(change);
          return allowed;
        },
      });
      a.typeAt(0, 1, "X");
      expect(a.lines()).toEqual(["abc"]);
      expect(a.sent).toEqual([]);
      a.expectMirror();
      allowed = true;
      a.typeAt(0, 1, "X");
      expect(a.lines()).toEqual(["aXbc"]);
      expect(a.sent).toHaveLength(1);
      a.expectMirror();
    });

    it("refuses a dispatch made inside a Yjs transaction the host opened around it", () => {
      const a = person(note("abc"), 10, shape);
      a.select([0, 1]);
      a.doc.transact(() => a.type("X"));
      expect(a.lines()).toEqual(["abc"]);
      expect(a.sent).toEqual([]);
      a.expectMirror();
    });
  },
);

describe.each(["bare", "hosted"] as const)("on a %s page, two editors on one document", (shape) => {
  it("keeps their histories apart when each has its own: neither undoes the other's letter", () => {
    const base = page(note("ab"), 10, shape);
    const a = editorOn(base, shape);
    const b = editorOn(base, shape);
    a.typeAt(0, 1, "A");
    b.typeAt(0, 2, "B");
    expect(a.lines()).toEqual(["aABb"]);
    expect(a.undo()).toBe(true);
    expect(b.lines()).toEqual(["aBb"]);
    expect(a.undo()).toBe(false);
    expect(b.undo()).toBe(true);
    expect(a.lines()).toEqual(["ab"]);
    expect(b.undo()).toBe(false);
    expect(a.redo()).toBe(true);
    expect(b.redo()).toBe(true);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.lines()).toEqual(["aABb"]);
    }
  });

  it("shares undo when both are given one history, as two panes on one note are", () => {
    const base = page(note("ab"), 10, shape);
    const history = createBodySequenceHistory(base.doc, { captureTimeout: 0 });
    onStop(() => history.destroy());
    const a = editorOn(base, shape, [], [], { history });
    const b = editorOn(base, shape, [], [], { history });
    a.typeAt(0, 1, "A");
    b.typeAt(0, 2, "B");
    expect(history.undoStack).toHaveLength(2);
    expect(a.undo()).toBe(true);
    for (const each of [a, b]) expect(each.lines()).toEqual(["aAb"]);
    expect(b.undo()).toBe(true);
    for (const each of [a, b]) expect(each.lines()).toEqual(["ab"]);
    expect(a.undo()).toBe(false);
    expect(b.redo()).toBe(true);
    expect(a.redo()).toBe(true);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.lines()).toEqual(["aABb"]);
    }
  });

  it("takes no history that createBodySequenceHistory did not make", () => {
    const base = page(note("ab"), 10, shape);
    const history = new Y.UndoManager(base.sequence);
    onStop(() => history.destroy());
    expect(() => editorOn(base, shape, [], [], { history })).toThrow("createBodySequenceHistory");
  });
});

describe.each(["bare", "hosted"] as const)(
  "on a %s page, two people who give one line its boundary at the same moment (a known behaviour)",
  (shape) => {
    it("leave a paragraph of its own for one of two letters typed at the start of the paragraph after a code block, and an empty paragraph once both are undone", () => {
      const lines = [stored(CODE, "ab", HARD_BREAK, "cd")];
      const a = person(noteOfLines(lines), 10, shape);
      const b = person(noteOfLines(lines), 20, shape);
      a.typeAt(1, 0, "A");
      b.typeAt(1, 0, "B");
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph("A"), paragraph("B", hardBreak, "cd"))',
        );
      }
      expect(a.undo()).toBe(true);
      expect(b.undo()).toBe(true);
      exchange(a, b);
      for (const each of [a, b]) {
        each.expectMirror();
        expect(each.view.state.doc.toString()).toBe(
          'doc(codeBlock("ab"), paragraph, paragraph(hardBreak, "cd"))',
        );
      }
    });

    it("gives no boundary that the same change deletes: Backspace at the start of the paragraph after a code block joins it in one change", () => {
      const a = person(noteOfLines([stored(CODE, "ab", HARD_BREAK, "cd")]), 10, shape);
      const before = a.view.state.doc.toJSON();
      a.select([1, 0]);
      expect(a.press("Backspace")).toBe(true);
      expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab\\ncd"))');
      expect(a.sent).toHaveLength(1);
      expect(a.boundaryIds()).toHaveLength(1);
      a.expectMirror();
      expect(a.undo()).toBe(true);
      expect(a.view.state.doc.toJSON()).toEqual(before);
      expect(a.boundaryIds()).toHaveLength(1);
      a.expectMirror();
    });

    it.each([
      [
        "a stored paragraph",
        [stored(CODE, "ab"), stored({}, HARD_BREAK, "cd")],
        'doc(paragraph("ab"), paragraph(hardBreak, hardBreak, "cd"))',
      ],
      [
        "the paragraph after the code block",
        [stored(CODE, "ab", HARD_BREAK, "cd")],
        'doc(paragraph("ab", hardBreak, hardBreak, "cd"))',
      ],
    ])(
      "double a line break when one joins %s that starts with it into the code block, the other makes the code block a paragraph, and the first undoes",
      (_name, lines, undone) => {
        const a = person(noteOfLines(lines), 10, shape);
        const b = person(noteOfLines(lines), 20, shape);
        a.select([1, 0]);
        expect(a.press("Backspace")).toBe(true);
        expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab\\ncd"))');
        exchange(a, b);
        b.select([0, 1]);
        b.retype("paragraph");
        expect(b.view.state.doc.toString()).toBe('doc(paragraph("ab", hardBreak, "cd"))');
        exchange(b, a);
        expect(a.undo()).toBe(true);
        exchange(a, b);
        for (const each of [a, b]) {
          each.expectMirror();
          expect(each.view.state.doc.toString()).toBe(undone);
        }
      },
    );

    it.each([
      ["a code block", CODE, 'doc(codeBlock("ab"), heading, heading(hardBreak, "cd"))'],
      ["a rule", RULE, 'doc(horizontalRule, heading, heading("ab", hardBreak, "cd"))'],
    ])(
      "leave an empty heading beside the text when both make the paragraph after %s a heading",
      (_name, kind, both) => {
        const lines = [stored(kind, "ab", HARD_BREAK, "cd")];
        const a = person(noteOfLines(lines), 10, shape);
        const b = person(noteOfLines(lines), 20, shape);
        for (const each of [a, b]) {
          each.select([1, 1]);
          each.retype("heading", { level: 2 });
        }
        exchange(a, b);
        for (const each of [a, b]) {
          each.expectMirror();
          expect(each.view.state.doc.toString()).toBe(both);
        }
      },
    );
  },
);

describe("an anchor in a paragraph that has been typed in", () => {
  it("holds to what stands before it, so a block put after it does not take it", () => {
    const a = person(noteOfLines(LIST_NOTE), 10);
    const b = person(noteOfLines(LIST_NOTE), 20);
    expect(a.lines()).toEqual(["top", "", "Title", "tail", "end"]);
    const anchor = bodySequenceAnchor(a.view.state, 8)!;
    expect(bodySequenceAnchorPosition(a.view.state, anchor)).toBe(8);
    a.typeAt(1, 0, "A");
    exchange(a, b);
    expect(bodySequenceAnchorPosition(a.view.state, anchor)).toBe(9);
    expect(bodySequenceAnchorPosition(b.view.state, anchor)).toBe(9);
    b.select([2, 0]);
    expect(b.press("Enter")).toBe(true);
    exchange(b, a);
    expect(a.lines()).toEqual(["top", "A", "", "Title", "tail", "end"]);
    expect(bodySequenceAnchorPosition(a.view.state, anchor)).toBe(9);
    expect(bodySequenceAnchorPosition(b.view.state, anchor)).toBe(9);
  });
});

type PeerSweep = { tried: number; nothingWritten: number; compared: number; enterUndone: number };
const PEER_SWEEP_COUNTS: Record<HostShape, PeerSweep> = {
  bare: { tried: 220, nothingWritten: 31, compared: 189, enterUndone: 62 },
  hosted: { tried: 220, nothingWritten: 31, compared: 189, enterUndone: 62 },
};

describe.each(["bare", "hosted"] as const)(
  "on a %s page, a peer's letters through an undo next to a block with no boundary of its own",
  (shape) => {
    const counted: PeerSweep & { notes: number } = {
      notes: 0,
      tried: 0,
      nothingWritten: 0,
      compared: 0,
      enterUndone: 0,
    };
    const leaves = (doc: ProseMirrorNode) => {
      const found: { node: ProseMirrorNode; pos: number }[] = [];
      doc.descendants((node, pos) => {
        if (!node.isBlock) return false;
        if (!node.isTextblock && !node.isLeaf) return true;
        found.push({ node, pos });
        return false;
      });
      return found;
    };
    const placeOf = (doc: ProseMirrorNode, letter: string) => {
      const all = leaves(doc);
      const index = all.findIndex(({ node }) => node.textContent.includes(letter));
      return index < 0 ? null : { index, kind: all[index]!.node.type.name };
    };

    it.each(ADDED_BLOCK_NOTES)("in %s", (_name, lines) => {
      const baseline = noteOfLines(lines);
      const start = declared(90);
      Y.applyUpdate(start.doc, baseline);
      const reading = createBodyReader(schema, start.sequence, start.containers).reading();
      const text = reading.doc.textContent;
      for (let block = 0; block < reading.blocks.length; block++) {
        const node = reading.blocks[block]!.node;
        if (boundaryAt(reading, block) >= 0 || !node.isTextblock) continue;
        const from = reading.starts[block]! + 1;
        for (const offset of new Set([0, Math.floor(node.content.size / 2), node.content.size]))
          for (const action of ["a letter", "Enter", "bold", "an inline item"] as const) {
            counted.tried += 1;
            const label = `${action} at ${String(offset)} of block ${String(block)} in ${reading.doc.toString()}`;
            const alice = person(baseline, 10, shape);
            const bob = person(baseline, 20, shape);
            const caretAt = (each: Person, pos: number, anchor = pos) =>
              each.view.dispatch(
                each.view.state.tr.setSelection(
                  TextSelection.create(each.view.state.doc, anchor, pos),
                ),
              );
            caretAt(alice, from + offset, action === "bold" ? from : from + offset);
            if (action === "a letter") alice.type("A");
            else if (action === "Enter") alice.press("Enter");
            else if (action === "bold") alice.toggle("bold");
            else alice.put("wikilink", { target: "Other", label: null });
            if (alice.sent.length === 0) {
              counted.nothingWritten += 1;
              stopEveryone();
              continue;
            }
            counted.compared += 1;
            const split = action === "Enter" ? boundariesMadeIn(alice.sent.at(-1)!) : [];
            if (action === "Enter") expect(split, label).toHaveLength(1);
            exchange(alice, bob);
            const caret = alice.view.state.selection.to;
            const own = leaves(bob.view.state.doc).findIndex(
              ({ node: each, pos }) => caret > pos && caret <= pos + each.nodeSize - 1,
            );
            bob.view.dispatch(bob.view.state.tr.insertText("1", caret));
            const above = leaves(bob.view.state.doc)[own - 1];
            if (above?.node.isTextblock)
              bob.view.dispatch(
                bob.view.state.tr.insertText("2", above.pos + 1 + above.node.content.size),
              );
            const below = leaves(bob.view.state.doc)[own + 1];
            if (below?.node.isTextblock)
              bob.view.dispatch(bob.view.state.tr.insertText("3", below.pos + 1));
            exchange(bob, alice);
            const typed = ["1", "2", "3"].filter((letter) => placeOf(alice.view.state.doc, letter));
            const before = typed.map((letter) => placeOf(alice.view.state.doc, letter)!);
            const boundaries = alice.boundaryIds();
            const withoutTheSplit = declared(91);
            Y.applyUpdate(withoutTheSplit.doc, Y.encodeStateAsUpdate(alice.doc));
            if (action === "Enter")
              withoutTheSplit.sequence.delete(
                tokensOf(withoutTheSplit.sequence).findIndex((token) => token.id === split[0]),
                1,
              );
            const expected = readBodySequence(schema, withoutTheSplit.doc).toJSON();
            withoutTheSplit.doc.destroy();
            alice.undo();
            exchange(alice, bob);
            for (const each of [alice, bob]) each.expectMirror();
            expect(bob.view.state.doc.toJSON(), label).toEqual(alice.view.state.doc.toJSON());
            if (action === "Enter") expect(alice.view.state.doc.toJSON(), label).toEqual(expected);
            expect(alice.boundaryIds(), label).toEqual(boundaries.filter((id) => id !== split[0]));
            const now = alice.view.state.doc.textContent;
            for (const letter of typed) expect(now.split(letter), label).toHaveLength(2);
            expect(now.replaceAll(/[123]/gu, ""), label).toBe(text);
            typed.forEach((letter, order) => {
              const after = placeOf(alice.view.state.doc, letter)!;
              const was = before[order]!;
              if (after.index === was.index && after.kind === was.kind) return;
              if (action !== "Enter")
                throw new Error(
                  `${label}: Bob's ${letter} read in block ${String(was.index)} (${was.kind}) and reads in block ${String(after.index)} (${after.kind}) after the undo, in ${alice.view.state.doc.toString()}`,
                );
              counted.enterUndone += 1;
            });
            stopEveryone();
          }
      }
      start.doc.destroy();
      counted.notes += 1;
    });

    it("tries, compares and excepts as many cases as counted", () => {
      const { notes, ...counts } = counted;
      console.log(
        `the peer sweep, ${shape}: ${String(notes)} notes; tried ${String(counts.tried)}, nothing written ${String(counts.nothingWritten)}, compared ${String(counts.compared)}; a letter one block up after an undone Enter: ${String(counts.enterUndone)}`,
      );
      if (notes !== ADDED_BLOCK_NOTES.length) return;
      expect(counts).toEqual(PEER_SWEEP_COUNTS[shape]);
    });
  },
);

describe("two plain editors racing", () => {
  raceTests((baseline, at) => person(baseline, 10 * (at + 1)));
});

describe("two plain editors racing on a page that runs each change in its own Yjs transaction", () => {
  raceTests((baseline, at) => person(baseline, 10 * (at + 1), "hosted"));
});

function withoutMarks(doc: ProseMirrorNode): string {
  const plain = (node: ProseMirrorNode): string => {
    if (node.isText) return JSON.stringify(node.text);
    const inside: string[] = [];
    node.forEach((child) => {
      const last = inside.at(-1);
      if (child.isText && last?.startsWith('"'))
        inside[inside.length - 1] = JSON.stringify(JSON.parse(last) + child.text!);
      else inside.push(plain(child));
    });
    return `${node.type.name}${JSON.stringify(node.attrs)}(${inside.join(",")})`;
  };
  return plain(doc);
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const MARKS = ["bold", "italic", "strike", "code", "highlight", "underline"] as const;
const ITEMS = [
  ["hardBreak", {}],
  ["image", { src: "/a.png", alt: "a", title: null }],
  ["wikilink", { target: "Page", label: null }],
  ["mathInline", { tex: "x" }],
  ["inlineAtom", { atomId: "date", params: "", source: "{{date}}" }],
  ["escapedPunctuation", { value: "*" }],
  ["rawInline", { source: "<i>" }],
] as const;

type Run = {
  next: () => number;
  letter: () => string;
  takeBack: (letters: number) => void;
  keepLetters: boolean;
};

function editAtRandom(each: Person, { next, letter, takeBack, keepLetters }: Run): string {
  const pick = (below: number) => Math.floor(next() * below);
  const { view } = each;
  const places = textPlaces(view.state.doc);
  if (places.length === 0) return "no text block";
  const place = () => {
    const at = places[pick(places.length)]!;
    return at.pos + pick(at.size + 1);
  };
  const caret = (pos: number) =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  const range = () => {
    const [from, to] = [place(), place()].sort((a, b) => a - b) as [number, number];
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    return `${String(from)}-${String(to)}`;
  };
  const edge = (end: boolean) => {
    const at = places[pick(places.length)]!;
    caret(at.pos + (end ? at.size : 0));
    return at.pos;
  };
  const roll = next();
  if (roll < 0.24) {
    const pos = place();
    caret(pos);
    each.type(letter());
    return `type@${String(pos)}`;
  }
  if (roll < 0.36) {
    const pos = place();
    caret(pos);
    each.press("Enter");
    return `enter@${String(pos)}`;
  }
  if (roll < 0.46) {
    if (keepLetters) return `backspace@${String(edge(false))}:${String(each.press("Backspace"))}`;
    const pos = place();
    caret(pos);
    if (!each.press("Backspace") && view.state.selection.$from.parentOffset > 0)
      view.dispatch(view.state.tr.delete(pos - 1, pos));
    return `backspace@${String(pos)}`;
  }
  if (roll < 0.52) {
    if (keepLetters) return `delete@${String(edge(true))}:${String(each.press("Delete"))}`;
    const pos = place();
    caret(pos);
    const { $from } = view.state.selection;
    if (!each.press("Delete") && $from.parentOffset < $from.parent.content.size)
      view.dispatch(view.state.tr.delete(pos, pos + 1));
    return `delete@${String(pos)}`;
  }
  if (roll < 0.58 && !keepLetters) {
    const at = range();
    each.press("Backspace");
    return `cut@${at}`;
  }
  if (roll < 0.66) {
    const at = range();
    const mark = MARKS[pick(MARKS.length)]!;
    each.toggle(mark);
    return `${mark}@${at}`;
  }
  if (roll < 0.7) {
    const at = range();
    each.mark("link", { href: `https://example.com/${String(pick(3))}` });
    return `link@${at}`;
  }
  if (roll < 0.78) {
    const at = range();
    const kind = pick(6);
    if (kind === 0) each.retype("paragraph");
    else if (kind === 5) each.retype("codeBlock");
    else each.retype("heading", { level: kind });
    return `kind${String(kind)}@${at}`;
  }
  if (roll < 0.83) {
    const pos = place();
    caret(pos);
    const paragraph = (text: string) => schema.nodes.paragraph!.create(null, schema.text(text));
    const pasted = new Slice(Fragment.from([paragraph(letter()), paragraph(letter())]), 1, 1);
    const paste = view.state.tr.replaceSelection(pasted);
    const refused = view.state.applyTransaction(paste).transactions.length === 0;
    if (refused) takeBack(2);
    else view.dispatch(paste);
    return `paste@${String(pos)}${refused ? ":refused" : ""}`;
  }
  if (roll < 0.88) {
    const pos = place();
    caret(pos);
    const [name, attrs] = ITEMS[pick(ITEMS.length)]!;
    each.put(name, attrs);
    return `${name}@${String(pos)}`;
  }
  if (roll < 0.9) {
    const pos = place();
    caret(pos);
    each.put("horizontalRule");
    return `rule@${String(pos)}`;
  }
  if (keepLetters) return "nothing";
  if (roll < 0.96) return each.undo() ? "undo" : "no undo";
  return each.redo() ? "redo" : "no redo";
}

const SHAPES = [
  ["Q", "blockquote"],
  ["C", "callout"],
  ["L", "bulletList"],
  ["O", "orderedList"],
  ["N", "taskList"],
  ["T", "table"],
  ["I", "listItem"],
  ["K", "taskItem"],
  ["R", "tableRow"],
  ["D", "tableCell"],
  ["H", "tableHeader"],
] as const;
const PATHS = [
  [],
  [],
  ["Q"],
  ["C"],
  ["L", "I"],
  ["L", "I2"],
  ["O", "I"],
  ["N", "K"],
  ["T", "R", "D"],
  ["T", "R", "H"],
  ["Q", "L", "I"],
  ["L", "I", "N", "K"],
  ["L"],
  ["missing"],
];
const KINDS = [
  { type: "paragraph" },
  { type: "paragraph" },
  { type: "heading", level: 2 },
  { type: "codeBlock", language: null },
  { type: "horizontalRule" },
  { type: "mathBlock", tex: "x" },
  { type: "rawBlock", source: "<hr>" },
];

function formattingBefore(sequence: Y.Text, index: number): Record<string, unknown> {
  const formatting = new Map<string, unknown>();
  let left = index;
  for (let item = sequence._start; item !== null && left > 0; item = item.right) {
    if (item.deleted) continue;
    if (!(item.content instanceof Y.ContentFormat)) left -= item.length;
    else if (item.content.value === null) formatting.delete(item.content.key);
    else formatting.set(item.content.key, item.content.value);
  }
  return Object.fromEntries(formatting);
}

function writeAtRandom(each: Page, { next, letter, keepLetters }: Run): string {
  const pick = (below: number) => Math.floor(next() * below);
  const { sequence, containers } = each;
  const length = sequence.length;
  const at = pick(length + 1);
  const roll = next();
  const elements = (wanted: "boundary" | "item") => {
    const found: { element: Y.XmlElement; index: number }[] = [];
    let index = 0;
    for (let item = sequence._start; item !== null; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const content = item.content;
      if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
        if ((content.type.nodeName === "block") === (wanted === "boundary"))
          found.push({ element: content.type, index });
      index += item.length;
    }
    return found;
  };
  const record = (path: readonly string[]) => {
    for (const id of path) {
      const shape = SHAPES.find(([name]) => id.startsWith(name));
      if (!shape || containers.has(id)) continue;
      for (const [key, value] of recordsOfContainer(schema, { id, type: shape[1], attrs: {} }))
        containers.set(key, value);
    }
  };
  each.doc.transact(() => {
    if (roll < 0.22) sequence.insert(at, letter(), formattingBefore(sequence, at));
    else if (roll < 0.28) sequence.insert(at, letter(), { [MARKS[pick(MARKS.length)]!]: {} });
    else if (roll < 0.46) {
      const path = PATHS[pick(PATHS.length)]!;
      record(path);
      const attrs = { ...KINDS[pick(KINDS.length)]!, path };
      sequence.insertEmbed(at, element("block", attrs), formattingBefore(sequence, at));
    } else if (roll < 0.52) {
      const [name, attrs] = ITEMS[pick(ITEMS.length)]!;
      sequence.insertEmbed(at, element(name, attrs), formattingBefore(sequence, at));
    } else if (roll < 0.64 && length > 0) {
      if (!keepLetters) sequence.delete(pick(length), 1 + pick(Math.min(3, length)));
      else {
        const found = [...elements("boundary"), ...elements("item")];
        if (found.length > 0) sequence.delete(found[pick(found.length)]!.index, 1);
      }
    } else if (roll < 0.72 && length > 0)
      sequence.format(pick(length), 1 + pick(4), {
        [MARKS[pick(MARKS.length)]!]: next() < 0.6 ? {} : null,
      });
    else if (roll < 0.82) {
      const found = elements("boundary");
      if (found.length === 0) return;
      const { element: block } = found[pick(found.length)]!;
      const way = pick(3);
      if (way === 0) {
        const kind = KINDS[pick(KINDS.length)]!;
        for (const [key, value] of Object.entries(kind)) block.setAttribute(key, value as string);
      } else if (way === 1) {
        const path = PATHS[pick(PATHS.length)]!;
        record(path);
        block.setAttribute("path", path as unknown as string);
      } else block.setAttribute("level", pick(8) as unknown as string);
    } else if (roll < 0.9) {
      const way = pick(5);
      if (way === 0 && containers.has("K")) containers.set("K.checked", next() < 0.5);
      else if (way === 1 && containers.has("L"))
        containers.set("L", next() < 0.5 ? "orderedList" : "taskList");
      else if (way === 2 && containers.has("C"))
        containers.set("C.title", `title ${String(pick(9))}`);
      else if (way === 3 && containers.has("Q")) containers.set("Q", "callout");
      else if (containers.has("O")) containers.set("O.start", pick(5));
    } else if (roll < 0.94) {
      const way = pick(5);
      if (way === 0) sequence.insertEmbed(at, element("unknownThing", { a: 1 }), {});
      else if (way === 1) sequence.insertEmbed(at, { embedded: "value" }, {});
      else if (way === 2)
        sequence.insertEmbed(at, element("block", { type: 7, path: "L", level: "x" }), {});
      else if (way === 3 && length > 0) sequence.format(pick(length), 2, { bold: true });
      else if (length > 0) sequence.format(pick(length), 2, { "bold--x": {} });
    } else containers.set(`Z${String(pick(3))}.title`, "no such container");
  });
  return `writeAtRandom:${roll.toFixed(2)}@${String(at)}`;
}

const SEEDS = Number(process.env.BODY_SEQUENCE_EDITOR_SEEDS ?? 40);
const STEPS = 60;
const LINE_FEED = String.fromCharCode(10);
const FIRST_TYPED = String.fromCharCode(0x4e00);

const mixed = (): Uint8Array =>
  noteOf(({ sequence, containers }) => {
    for (const id of ["L", "I", "I2", "Q"]) {
      const type = SHAPES.find(([name]) => id.startsWith(name))![1];
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        containers.set(key, value);
    }
    const line = (path: string[], text: string) => {
      sequence.insertEmbed(sequence.length, boundary({ path }), {});
      sequence.insert(sequence.length, text, {});
    };
    line([], "abcd");
    line(["L", "I"], "efgh");
    line(["L", "I2"], "ijkl");
    line(["Q"], "mnop");
    line([], "qrst");
  });

describe.each([
  ["a note of three lines", () => note("abcd", "efgh", "ijkl")],
  ["a note with no boundary", () => Y.encodeStateAsUpdate(new Y.Doc())],
  ["a note with a list and a quote", mixed],
])("random changes to %s by three editors and one writer with no editor", (_name, baseline) => {
  it.each([
    ["with deletions, undo and redo", false],
    ["with no letter deleted", true],
  ])(
    "show every editor exactly what the sequence reads as, %s",
    (_mode, keepLetters) => {
      let corrected = 0;
      let actions = 0;
      const reshaped: string[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        const next = random(seed * 7919 + (keepLetters ? 1 : 0));
        let typed = 0;
        const letter = () => String.fromCharCode(0x4e00 + typed++);
        const takeBack = (letters: number) => {
          typed -= letters;
        };
        const run: Run = { next, letter, takeBack, keepLetters };
        const editors = [
          person(baseline(), 10),
          person(baseline(), 20, "hosted"),
          person(baseline(), 30),
        ];
        const writer = page(baseline(), 40);
        const log: string[] = [];
        const settled = () => {
          const read = readBodySequence(schema, writer.doc);
          read.check();
          for (const each of editors) {
            each.expectMirror();
            expect(tokensOf(each.sequence)).toEqual(tokensOf(writer.sequence));
            expect(each.containers.toJSON()).toEqual(writer.containers.toJSON());
            expect(each.view.state.doc.toJSON()).toEqual(read.toJSON());
          }
        };
        try {
          for (let step = 0; step < STEPS; step++) {
            const who = Math.floor(next() * 4);
            if (who === 3) log.push(`3:${writeAtRandom(writer, run)}`);
            else {
              const each = editors[who]!;
              const before = each.shown.count;
              let meant = each.view.state.doc;
              const dispatch = each.view.dispatch.bind(each.view);
              each.view.dispatch = (transaction) => {
                const own = transaction.docChanged && !isBodySequenceChange(transaction);
                if (own && each.view.state.applyTransaction(transaction).transactions.length > 0)
                  meant = transaction.doc;
                dispatch(transaction);
              };
              let did = "";
              const effects = each.effects(() => {
                did = editAtRandom(each, run);
              });
              each.view.dispatch = dispatch;
              log.push(`${String(who)}:${did}`);
              actions += 1;
              if (each.shown.count > before) corrected += 1;
              if (!did.endsWith("undo") && !did.endsWith("redo")) {
                expect(effects.made.letters).toBe(effects.madeLetters.length);
                if (keepLetters) expect(effects.goneLetters.replaceAll(LINE_FEED, "")).toBe("");
                if (withoutMarks(meant) !== withoutMarks(each.view.state.doc)) reshaped.push(did);
              }
              each.expectMirror();
            }
            if (next() < 0.3) {
              const merged = next() < 0.4;
              log.push(merged ? "||" : "|");
              if (merged) reconnect(...editors, writer);
              else exchange(...editors, writer);
              settled();
            }
          }
          exchange(...editors, writer);
          settled();
          if (keepLetters) {
            const letters = tokensOf(writer.sequence)
              .flatMap((token) => (token.kind === "letter" ? [token.text] : []))
              .filter((text) => text >= FIRST_TYPED)
              .sort();
            expect(letters).toEqual(
              Array.from({ length: typed }, (_, at) => String.fromCharCode(0x4e00 + at)),
            );
          }
        } catch (error) {
          throw new Error(
            `seed ${String(seed)}: ${log.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        stopEveryone();
      }
      expect(reshaped).toEqual([]);
      console.log(
        `${String(SEEDS)} runs of ${String(STEPS)} changes: after ${String(corrected)} of ${String(actions)} editor actions the editor was changed to show the sequence, each time in marks alone`,
      );
    },
    600_000,
  );
});
