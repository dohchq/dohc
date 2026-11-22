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
function page(baseline: Uint8Array, mayEdit = true) {
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
    sent,
    /** Every change the page made by itself in answer to someone else's. */
    answers: [] as Uint8Array[],
    lines: () => body.toArray().map((line) => (line as Y.XmlElement).toArray().join("")),
    length: (line: number) => text(line).length,
    take: () => Y.mergeUpdates(sent.splice(0)),
    receive(update: Uint8Array) {
      const before = sent.length;
      const removed = applyUpdateFindingRemovedText(
        doc,
        update,
        REMOTE,
        () => Y.decodeUpdate(update).ds,
        (item) => item.id.client === doc.clientID,
        moved,
      );
      told.push(...(removed ? [removed.text] : []), ...moved.repair(doc, mayEdit));
      this.answers.push(...sent.slice(before));
    },
    /** Joins a line to the one above, the way both editors write it: an empty line above just goes. */
    join(line: number) {
      doc.transact(() => {
        if (text(line - 1).length === 0) return body.delete(line - 1, 1);
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

it("puts a person's typing back into a line someone else joined away", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.type(1, 1, "TYPED");
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTTYPEDwo", "Three"]);
  expect(b.told).toEqual([]);
});

it("keeps the next line when one person joins a line up and the other joins the next line to it", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.join(2);
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTwoThree"]);
  expect([...a.told, ...b.told]).toEqual([]);
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

it("tells a person whose typing it could not put back because the page may not edit", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline, false)];
  a.join(1);
  b.type(1, 3, " TYPED");
  b.receive(a.take());
  expect(b.lines()).toEqual(["OneTwo", "Three"]);
  expect(b.told).toEqual([" TYPED"]);
});

// The text of a line two people joined stays in the note twice, as before this change. Taking
// one copy out means deleting text, and a page that deletes on a guess can delete the last copy.
it("leaves both copies when two people join the same line", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.join(1);
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTwoTwo", "Three"]);
});

it("keeps the last line or tells its author when three people join neighbouring lines in one delivery", () => {
  const baseline = note("a", "b", "c");
  const [a, b, c] = [page(baseline), page(baseline), page(baseline)];
  a.join(2);
  b.join(1);
  c.join(2);
  const [fromA, fromB, fromC] = [a.take(), b.take(), c.take()];
  a.receive(Y.mergeUpdates([fromB, fromC]));
  b.receive(Y.mergeUpdates([fromA, fromC]));
  c.receive(Y.mergeUpdates([fromA, fromB]));
  settle(a, b, c);
  for (const each of [a, b, c]) expect(each.lines()).toEqual(a.lines());
  expect(a.lines().join("") + [...a.told, ...b.told, ...c.told].join("")).toContain("c");
});

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Everyone makes one or two random joins, splits or typed letters in the same three lines at
// the same moment, four times over. The changes travel each on its own in a random order, or
// as one change a person. A page's own answer to someone else's change never deletes anything,
// and no letter goes without its author being told.
it.each([
  [2, "one by one"],
  [3, "one by one"],
  [4, "one by one"],
  [2, "together"],
  [3, "together"],
] as const)(
  "never deletes and never loses a letter untold when %i people's changes arrive %s",
  (people, arrive) => {
    const letters = "abcdefghijkl";
    const wrong: string[] = [];
    for (let seed = 1; seed <= 400; seed++) {
      const next = random(seed);
      const baseline = note("abcd", "efgh", "ijkl");
      const pages = Array.from({ length: people }, (_, index) => {
        const each = page(baseline);
        each.doc.clientID = 100 + Math.floor(next() * 1000) * 10 + index;
        return each;
      });
      for (let round = 0; round < 4; round++) {
        for (const [index, each] of pages.entries())
          for (let changes = 1 + Math.floor(next() * 2); changes > 0; changes--) {
            const line = Math.floor(next() * each.lines().length);
            const roll = next();
            const at = Math.floor(next() * (each.length(line) + 1));
            if (roll < 0.45 && line > 0) each.join(line);
            else if (roll < 0.9) each.split(line, at);
            else each.type(line, at, "WXYZ"[index]!);
          }
        if (arrive === "together")
          for (const each of pages) each.sent.push(Y.mergeUpdates(each.sent.splice(0)));
        for (let sends = 0; pages.some((each) => each.sent.length > 0); sends++) {
          if (sends === 2000) throw new Error("the pages kept rewriting the note");
          const waiting = pages.filter((each) => each.sent.length > 0);
          const from = waiting[Math.floor(next() * waiting.length)]!;
          const update = from.sent.shift()!;
          for (const to of pages) if (to !== from) to.receive(update);
        }
        const shown = pages[0]!.lines().join("/");
        const kept = shown + pages.flatMap((each) => each.told).join("");
        if (
          pages.some((each) => each.lines().join("/") !== shown) ||
          [...letters].some((letter) => !kept.includes(letter)) ||
          pages.some((each) =>
            each.answers.some((answer) => Y.decodeUpdate(answer).ds.clients.size > 0),
          )
        )
          wrong.push(`seed ${String(seed)}, round ${String(round)}: ${shown}`);
      }
      for (const each of docs.splice(0)) each.destroy();
    }
    expect(wrong).toEqual([]);
  },
);
