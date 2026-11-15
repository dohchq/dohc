import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { getDohcProseMirrorSchema } from "./import-export.js";
import { applyUpdateFindingRemovedText, INLINE_NODES, quoteRemovedText } from "./removedText.js";

const REMOTE = Symbol("remote");

function person(): Y.Doc {
  return new Y.Doc();
}

/** The update one change makes, the way a page sends it. */
function change(doc: Y.Doc, edit: (body: Y.XmlFragment) => void): Uint8Array {
  const updates: Uint8Array[] = [];
  const record = (update: Uint8Array) => updates.push(update);
  doc.on("update", record);
  try {
    doc.transact(() => edit(getDohcYDocBodyFragment(doc)));
  } finally {
    doc.off("update", record);
  }
  return Y.mergeUpdates(updates);
}

function exchange(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function paragraph(text: string): Y.XmlElement {
  const line = new Y.XmlElement("paragraph");
  line.insert(0, [new Y.XmlText(text)]);
  return line;
}

function piece(body: Y.XmlFragment, line: number): Y.XmlText {
  return (body.get(line) as Y.XmlElement).get(0) as Y.XmlText;
}

const own = (doc: Y.Doc) => (item: Y.Item) => item.id.client === doc.clientID;
const anyone = () => true;

function receive(doc: Y.Doc, update: Uint8Array, keep: (item: Y.Item) => boolean = own(doc)) {
  return applyUpdateFindingRemovedText(doc, update, REMOTE, () => Y.decodeUpdate(update).ds, keep);
}

/** Two people with the same lines. */
function pair(...lines: string[]): [Y.Doc, Y.Doc] {
  return pairWith(new Y.Doc(), lines);
}

/** The same, where the first keeps deleted content, as the engine does. */
function pairKeepingDeleted(...lines: string[]): [Y.Doc, Y.Doc] {
  return pairWith(new Y.Doc({ gc: false }), lines);
}

function pairWith(ana: Y.Doc, lines: string[]): [Y.Doc, Y.Doc] {
  const ben = person();
  change(ana, (body) => body.insert(0, lines.map(paragraph)));
  exchange(ana, ben);
  return [ana, ben];
}

describe("text a merged change removes without having seen it", () => {
  it("reports what a person typed into a paragraph someone else deleted (#3983)", () => {
    const [ana, ben] = pair("Hello", "Next");
    change(ana, (body) => piece(body, 0).insert(5, " and more"));
    const deleted = change(ben, (body) => body.delete(0, 1));

    const removed = receive(ana, deleted);

    expect(removed?.text).toBe(" and more");
    expect([...removed!.clients]).toEqual([ana.clientID]);
    expect(getDohcYDocBodyFragment(ana).length).toBe(1);
  });

  it("reports typing that arrives inside a paragraph already deleted, where deleted content is kept", () => {
    const [ana, ben] = pairKeepingDeleted("Hello");
    const typed = change(ben, (body) => piece(body, 0).insert(0, "Ben: "));
    change(ana, (body) => body.delete(0, 1));

    expect(receive(ana, typed, own(ana))).toBeNull();
    const [carol, dan] = pairKeepingDeleted("Hello");
    const later = change(dan, (body) => piece(body, 0).insert(0, "Dan: "));
    change(carol, (body) => body.delete(0, 1));
    expect(receive(carol, later, anyone)?.text).toBe("Dan: ");
  });

  it("cannot see typing that arrives inside a paragraph a page already dropped", () => {
    // A page collects a deleted line's content, so later typing into it arrives as nothing.
    const [ana, ben] = pair("Hello");
    const typed = change(ben, (body) => piece(body, 0).insert(0, "Ben: "));
    change(ana, (body) => body.delete(0, 1));

    expect(receive(ana, typed, anyone)).toBeNull();
  });

  it("reports nothing for a delete made after seeing the text", () => {
    const [ana, ben] = pair("Hello");
    change(ana, (body) => piece(body, 0).insert(5, " there"));
    exchange(ana, ben);
    const deleted = change(ben, (body) => body.delete(0, 1));

    expect(receive(ana, deleted, anyone)).toBeNull();
  });

  it("reads a delete list whose ranges arrive out of order", () => {
    const [ana, ben] = pair("Hello", "Keep", "World");
    const deleted = change(ben, (body) => {
      body.delete(2, 1);
      body.delete(0, 1);
    });
    const named = Y.decodeUpdate(deleted).ds;
    for (const ranges of named.clients.values()) ranges.reverse();

    expect(applyUpdateFindingRemovedText(ana, deleted, REMOTE, () => named, anyone)).toBeNull();
  });

  it("reports nothing when two people type into one piece and one deletes words", () => {
    const [ana, ben] = pair("Hello world");
    change(ana, (body) => piece(body, 0).insert(11, "!"));
    const deleted = change(ben, (body) => piece(body, 0).delete(5, 6));

    expect(receive(ana, deleted, anyone)).toBeNull();
    expect(piece(getDohcYDocBodyFragment(ana), 0).toString()).toBe("Hello!");
  });

  it("reports nothing for formatting, an empty piece, or a line deleted with nothing new in it", () => {
    const [ana, ben] = pair("Hello", "", "Bye");
    change(ana, (body) => (body.get(1) as Y.XmlElement).insert(0, [new Y.XmlText("")]));
    const formatted = change(ben, (body) => piece(body, 0).format(0, 5, { bold: {} }));
    const cleared = change(ben, (body) => body.delete(1, 2));

    expect(receive(ana, formatted, anyone)).toBeNull();
    expect(receive(ana, cleared, anyone)).toBeNull();
  });

  it("reports only the typing the deleter missed, when the deleter saw the start of it", () => {
    const [ana, ben] = pair("");
    change(ana, (body) => piece(body, 0).insert(0, "ab"));
    exchange(ana, ben);
    change(ana, (body) => piece(body, 0).insert(2, "c"));
    const deleted = change(ben, (body) => body.delete(0, 1));

    expect(receive(ana, deleted)?.text).toBe("c");
  });

  it("reports the moved text when a join races another join (B into A, C into B)", () => {
    const [ana, ben] = pair("A", "B", "C");
    // Ana joins B into A: B's text is written into A and line B is deleted.
    const anaJoin = change(ana, (body) => {
      piece(body, 0).insert(1, "B");
      body.delete(1, 1);
    });
    // Ben joins C into B at the same time.
    change(ben, (body) => {
      piece(body, 1).insert(1, "C");
      body.delete(2, 1);
    });

    const removed = receive(ben, anaJoin);

    expect(removed?.text).toBe("C");
  });

  it("does not report a delete that waited for the text it names", () => {
    const [ana, ben] = pair("Hello");
    const carol = person();
    exchange(ana, carol);
    const typed = change(carol, (body) => piece(body, 0).insert(5, "!"));
    Y.applyUpdate(ben, typed);
    const deleted = change(ben, (body) => piece(body, 0).delete(5, 1));

    // Ana gets the delete first; it waits until Carol's text arrives.
    expect(receive(ana, deleted, anyone)).toBeNull();
    expect(receive(ana, typed, anyone)).toBeNull();
    expect(piece(getDohcYDocBodyFragment(ana), 0).toString()).toBe("Hello");
  });

  it("keeps note order across lines and quotes inline items as Markdown", () => {
    const [ana, ben] = pair("One", "Two");
    change(ana, (body) => {
      piece(body, 0).insert(3, " first");
      const image = new Y.XmlElement("image");
      image.setAttribute("src", "cat.png");
      image.setAttribute("alt", "A cat");
      (body.get(1) as Y.XmlElement).insert(1, [image, new Y.XmlElement("hardBreak")]);
      (body.get(1) as Y.XmlElement).insert(3, [new Y.XmlText("second")]);
    });
    const deleted = change(ben, (body) => body.delete(0, 2));

    expect(receive(ana, deleted)?.text).toBe(" first\n![A cat](cat.png)\nsecond");
  });

  it("keeps note order for typing added at a line's start, one character at a time", () => {
    const [ana, ben] = pair("");
    for (const character of "cba") change(ana, (body) => piece(body, 0).insert(0, character));
    const deleted = change(ben, (body) => body.delete(0, 1));

    expect(receive(ana, deleted)?.text).toBe("abc");
  });

  it("quotes a text embed as the note writes it and reports nothing for embeds the note leaves out", () => {
    const [ana, ben] = pair("", "");
    change(ana, (body) => {
      piece(body, 0).insertEmbed(0, { kind: "widget" });
      (body.get(1) as Y.XmlElement).insert(1, [new Y.XmlElement("escapedPunctuation")]);
    });
    expect(
      receive(
        ana,
        change(ben, (body) => body.delete(0, 2)),
      ),
    ).toBeNull();

    const [carol, dan] = pair("");
    change(carol, (body) => piece(body, 0).insertEmbed(0, "kept"));
    expect(
      receive(
        carol,
        change(dan, (body) => body.delete(0, 1)),
      )?.text,
    ).toBe("kept");
  });

  it("reports nothing for a change that deletes nothing", () => {
    const [ana, ben] = pair("Hello");
    const typed = change(ben, (body) => piece(body, 0).insert(0, "Hi. "));

    expect(receive(ana, typed, anyone)).toBeNull();
  });
});

it("knows every inline node the editor can write", () => {
  const inline = Object.values(getDohcProseMirrorSchema().nodes)
    .filter((node) => node.isInline && node.name !== "text")
    .map((node) => node.name);

  expect([...INLINE_NODES].sort()).toEqual(inline.sort());
});

describe("quoting removed text", () => {
  it("quotes short text whole", () => {
    expect(quoteRemovedText("A short line.")).toEqual({ quoted: "A short line.", more: 0 });
  });

  it("caps a long passage and counts what is left", () => {
    const long = "word ".repeat(300).trim();
    const quote = quoteRemovedText(long);

    expect(quote.quoted.length).toBeLessThanOrEqual(281);
    expect(quote.quoted.endsWith("…")).toBe(true);
    expect(quote.more).toBe(long.length - (quote.quoted.length - 1));
  });

  it("caps at six lines", () => {
    const quote = quoteRemovedText(["1", "2", "3", "4", "5", "6", "7", "8"].join("\n"));

    expect(quote.quoted).toBe("1\n2\n3\n4\n5\n6…");
    expect(quote.more).toBe(4);
  });
});
