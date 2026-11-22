import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { MovedText } from "./movedText.js";
import { applyUpdateFindingRemovedText } from "./removedText.js";

const REMOTE = Symbol("remote");
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

/** A page on the note: it follows moved text, and collects what it sends and what it is told. */
function page(baseline: Uint8Array, follows = true) {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, baseline, REMOTE);
  const moved = new MovedText();
  const sent: Uint8Array[] = [];
  const told: string[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.origin !== REMOTE) moved.note(transaction);
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const body = doc.getXmlFragment("body");
  const text = (line: number) => (body.get(line) as Y.XmlElement).get(0) as Y.XmlText;
  return {
    doc,
    told,
    lines: () => body.toArray().map((line) => (line as Y.XmlElement).toArray().join("")),
    take: () => Y.mergeUpdates(sent.splice(0)),
    receive(update: Uint8Array) {
      const removed = applyUpdateFindingRemovedText(
        doc,
        update,
        REMOTE,
        () => Y.decodeUpdate(update).ds,
        (item) => item.id.client === doc.clientID,
        follows ? moved : undefined,
      );
      if (removed) told.push(removed.text);
    },
    /** Joins a line to the one above, the way both editors write it. */
    join(line: number) {
      doc.transact(() => {
        text(line - 1).insert(text(line - 1).length, text(line).toString());
        body.delete(line, 1);
      });
    },
    /** Splits a line, the way both editors write it. */
    split(line: number, at: number) {
      doc.transact(() => {
        const tail = text(line).toString().slice(at);
        text(line).delete(at, tail.length);
        const next = new Y.XmlElement("paragraph");
        next.insert(0, [new Y.XmlText(tail)]);
        body.insert(line + 1, [next]);
      });
    },
    type: (line: number, at: number, typed: string) => text(line).insert(at, typed),
    deleteLine: (line: number) => body.delete(line, 1),
  };
}
type Page = ReturnType<typeof page>;

function note(...lines: string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.getXmlFragment("body").insert(
    0,
    lines.map((line) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(line)]);
      return paragraph;
    }),
  );
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

const empty = (update: Uint8Array) => {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
};

/** Everyone's changes reach everyone else, in the order given, until nobody has more to send. */
function settle(...pages: Page[]) {
  for (let round = 0; round < 6; round++) {
    const updates = pages.map((from) => [from, from.take()] as const);
    if (updates.every(([, update]) => empty(update))) return;
    for (const [from, update] of updates)
      if (!empty(update)) for (const to of pages) if (to !== from) to.receive(update);
  }
  throw new Error("the pages kept rewriting the note");
}

it("keeps one copy when two people join the same line, on every page", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b, watcher] = [page(baseline), page(baseline), page(baseline)];
  a.join(1);
  b.join(1);
  settle(a, b, watcher);
  for (const each of [a, b, watcher]) expect(each.lines()).toEqual(["OneTwo", "Three"]);
});

it("puts a person's typing back into a line someone else joined away", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.type(1, 1, "TYPED");
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTTYPEDwo", "Three"]);
  expect(b.told).toEqual([]);
});

it("keeps the join and the split when one person joins a line and the other splits it", () => {
  const baseline = note("One", "Two two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.split(1, 3);
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTwo", " two", "Three"]);
});

it("still tells a person whose typing went with a line someone else deleted", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.deleteLine(1);
  b.type(1, 3, " TYPED");
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["One", "Three"]);
  expect(b.told).toEqual([" TYPED"]);
});

it("keeps both when two people type the same word in the same place", () => {
  const baseline = note("One", "Two");
  const [a, b] = [page(baseline), page(baseline)];
  a.type(0, 3, "Two");
  b.type(0, 3, "Two");
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTwoTwo", "Two"]);
});

// A page that opened after the first join has not read what it moved. It must leave the two
// copies alone: a page that guessed could delete the copy the others keep.
it("changes nothing on a page that did not see the first of two joins", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline, false), page(baseline, false)];
  a.join(1);
  b.join(1);
  const first = a.take();
  const late = page(Y.mergeUpdates([baseline, first]));
  late.receive(b.take());
  expect(late.lines()).toEqual(["OneTwoTwo", "Three"]);
  expect(empty(late.take())).toBe(true);
});
