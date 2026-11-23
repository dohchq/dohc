// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import {
  bodySequenceAnchor,
  bodySequenceAnchorPosition,
  bodySequencePlugin,
  createBodySequenceHistory,
  isBodySequenceChange,
  keepBodySequenceFormatting,
} from "./bodySequenceEditor.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import {
  boundary,
  declared,
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
  withEditor,
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
    expect(a.boundaryIds()).toEqual([]);
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
    expect(retyped.made).toEqual({ ...quiet(), boundaries: 1, attributes: 3 });
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

  it("writes what another plugin appends, when the editor mounts and after a change from elsewhere", () => {
    const lastLineEmpty = new Plugin({
      appendTransaction(_transactions, _before, state) {
        if (state.doc.lastChild!.content.size === 0) return null;
        return state.tr.insert(state.doc.content.size, schema.nodes.paragraph!.create());
      },
    });
    const base = page(note(...LINES), 10);
    const mount = window.document.createElement("div");
    const history = createBodySequenceHistory(base.doc);
    const view = new EditorView(mount, {
      state: EditorState.create({
        schema,
        plugins: [bodySequencePlugin({ ...base, history }), lastLineEmpty],
      }),
    });
    onStop(() => view.destroy());
    const a = withEditor({ ...base, view, history, shown: { count: 0 } });
    a.expectMirror();
    expect(a.lines()).toEqual([...LINES, ""]);
    const b = person(note(...LINES), 20);
    exchange(a, b);
    b.typeAt(3, 0, "F");
    exchange(b, a);
    exchange(a, b);
    a.expectMirror();
    b.expectMirror();
    expect(a.lines()).toEqual([...LINES, "F", ""]);
    expect(b.lines()).toEqual(a.lines());
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

  it("keeps what a plugin appended outside the history when the person's change is undone", () => {
    const appendsY = new Plugin({
      appendTransaction(transactions, _before, state) {
        if (!transactions.some((transaction) => transaction.getMeta("appendY") === true))
          return null;
        const lower = state.doc.child(0).nodeSize + 1;
        return state.tr.insertText("Y", lower).setMeta("addToHistory", false);
      },
    });
    const a = person(note("abc", "def"), 10, shape, [appendsY]);
    const b = person(note("abc", "def"), 20, shape);
    a.view.dispatch(a.view.state.tr.insertText("X", 2).setMeta("appendY", true));
    expect(a.lines()).toEqual(["aXbc", "Ydef"]);
    a.expectMirror();
    exchange(a, b);
    expect(b.lines()).toEqual(["aXbc", "Ydef"]);
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["abc", "Ydef"]);
    expect(a.undo()).toBe(false);
    expect(a.redo()).toBe(true);
    expect(a.lines()).toEqual(["aXbc", "Ydef"]);
    a.expectMirror();
    exchange(a, b);
    b.expectMirror();
    expect(b.lines()).toEqual(["aXbc", "Ydef"]);
    expect(b.sent).toEqual([]);
  });

  it("keeps a tracked change in the history when it follows an untracked one in the same dispatch", () => {
    const appendsY = new Plugin({
      appendTransaction(transactions, _before, state) {
        if (!transactions.some((transaction) => transaction.getMeta("appendY") === true))
          return null;
        return state.tr.insertText("Y", state.doc.child(0).nodeSize + 1);
      },
    });
    const a = person(note("abc", "def"), 10, shape, [appendsY]);
    a.view.dispatch(
      a.view.state.tr.insertText("X", 2).setMeta("appendY", true).setMeta("addToHistory", false),
    );
    expect(a.lines()).toEqual(["aXbc", "Ydef"]);
    expect(a.undo()).toBe(true);
    expect(a.lines()).toEqual(["aXbc", "def"]);
    expect(a.undo()).toBe(false);
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
  const types = (a: Person) =>
    elementsOf(a.sequence, "boundary").map(
      (token) =>
        (JSON.parse(token.attrs) as [string, unknown][]).find(([key]) => key === "type")![1],
    );

  it("keeps the rule's boundary for the rest of that text, as a paragraph's", () => {
    const a = person(
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary({ type: "horizontalRule" }), {});
        sequence.insert(1, "abc", {});
      }),
      10,
    );
    const [rule] = a.boundaryIds();
    expect(a.blocks()).toEqual(["horizontalRule", "paragraph"]);
    const effects = a.effects(() => a.view.dispatch(a.view.state.tr.delete(0, 4)));
    expect(a.blocks()).toEqual(["paragraph"]);
    expect(effects.goneLetters).toBe("ab");
    expect(effects.madeLetters).toBe("");
    expect(effects.goneBoundaries).toEqual([]);
    expect(a.boundaryLines()).toEqual([{ id: rule, text: "c" }]);
    expect(types(a)).toEqual(["paragraph"]);
    a.expectMirror();
  });

  it("does the same below another rule, and below a line", () => {
    const below = (upper: Record<string, unknown>, text: string) =>
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, boundary(upper), {});
        sequence.insert(1, text, {});
        sequence.insertEmbed(sequence.length, boundary({ type: "horizontalRule" }), {});
        sequence.insert(sequence.length, "abc", {});
      });
    const a = person(below({ type: "horizontalRule" }, ""), 10);
    const [, lower] = a.boundaryIds();
    a.view.dispatch(a.view.state.tr.delete(1, 5));
    expect(a.blocks()).toEqual(["horizontalRule", "paragraph"]);
    expect(a.boundaryLines().at(-1)).toEqual({ id: lower, text: "c" });
    expect(types(a)).toEqual(["horizontalRule", "paragraph"]);
    a.expectMirror();

    const b = person(below({}, "One"), 20);
    const [, rule] = b.boundaryIds();
    const from = b.view.state.doc.child(0).nodeSize;
    b.view.dispatch(b.view.state.tr.delete(from, from + 4));
    expect(b.lines()).toEqual(["One", "c"]);
    expect(b.boundaryLines().at(-1)).toEqual({ id: rule, text: "c" });
    expect(types(b)).toEqual(["paragraph", "paragraph"]);
    b.expectMirror();
  });

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
