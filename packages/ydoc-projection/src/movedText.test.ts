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
    length: (line: number) => text(line).length,
    take: () => Y.mergeUpdates(sent.splice(0)),
    sent,
    receive(update: Uint8Array) {
      const removed = applyUpdateFindingRemovedText(
        doc,
        update,
        REMOTE,
        () => Y.decodeUpdate(update).ds,
        (item) => item.id.client === doc.clientID,
        follows ? moved : undefined,
      );
      moved.repair(doc, follows);
      if (removed) told.push(removed.text);
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

it("keeps one copy when two people join the same line, on every page", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b, watcher] = [page(baseline), page(baseline), page(baseline)];
  a.join(1);
  b.join(1);
  settle(a, b, watcher);
  for (const each of [a, b, watcher]) expect(each.lines()).toEqual(["OneTwo", "Three"]);
});

it.each([
  [100, 101, 102],
  [102, 101, 100],
  [101, 102, 100],
])("keeps the text once when three people split the same line (clients %i, %i, %i)", (...ids) => {
  const baseline = note("abcd", "ef");
  const pages = ids.map((id) => {
    const each = page(baseline);
    each.doc.clientID = id;
    return each;
  });
  const [a, b, c] = pages as [Page, Page, Page];
  a.split(0, 1);
  b.split(0, 1);
  c.split(0, 2);
  settle(a, b, c);
  for (const each of pages) {
    expect(each.lines()).toEqual(a.lines());
    expect(each.lines().join("")).toBe("abcdef");
    expect(each.told).toEqual([]);
  }
});

it("keeps one copy and both people's typing when each types into the line they joined", () => {
  const baseline = note("A", "BC", "D");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  a.type(0, 2, "X");
  b.join(1);
  b.type(0, 2, "Y");
  settle(a, b);
  for (const each of [a, b]) {
    expect(each.lines()).toEqual(a.lines());
    expect(each.lines()[0]!.replace(/[XY]/gu, "")).toBe("ABC");
    expect(each.lines()[0]!.replace(/[ABC]/gu, "").split("").sort()).toEqual(["X", "Y"]);
  }
});

it("still follows a join made 100 moves ago", () => {
  const baseline = note("A", "B", "C", "D");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.join(1);
  for (let pair = 0; pair < 50; pair++) {
    a.split(1, 1);
    a.join(2);
  }
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["AB", "C", "D"]);
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
  for (const each of [a, b]) {
    expect(each.lines()).toEqual(a.lines());
    expect(each.lines().join("")).toBe("OneTwo twoThree");
  }
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

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

// Everyone makes one random join, split or typed letter in the same three lines at the same
// moment, four times over. Text that goes with a line someone deleted counts as kept when its
// author is told. Two people must end with every letter once. With more, a letter may still
// stand twice, but none may go: a page must never delete the last copy.
it.each([2, 3, 4])("never loses a letter when %i people join and split at once", (people) => {
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
      for (const [index, each] of pages.entries()) {
        const line = Math.floor(next() * each.lines().length);
        const roll = next();
        const at = Math.floor(next() * (each.length(line) + 1));
        if (roll < 0.45 && line > 0) each.join(line);
        else if (roll < 0.9) each.split(line, at);
        else each.type(line, at, "WXYZ"[index]!);
      }
      settle(...pages);
      const shown = pages[0]!.lines().join("/");
      const kept = shown + pages.flatMap((each) => each.told).join("");
      const counts = [...letters].map((letter) => kept.split(letter).length - 1);
      if (
        pages.some((each) => each.lines().join("/") !== shown) ||
        counts.some((count) => count === 0 || (people === 2 && count > 1))
      )
        wrong.push(`seed ${String(seed)}, round ${String(round)}: ${shown}`);
    }
    for (const each of docs.splice(0)) each.destroy();
  }
  expect(wrong).toEqual([]);
});

it.each([
  [100, 101],
  [101, 100],
])(
  "keeps the text when both split a line and one joins it again, each change arriving on its own (clients %i, %i)",
  (first, second) => {
    const baseline = note("abc", "d");
    const [a, b] = [page(baseline), page(baseline)];
    a.doc.clientID = first;
    b.doc.clientID = second;
    a.split(0, 1);
    a.join(1);
    b.split(0, 1);
    while (a.sent.length + b.sent.length > 0)
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        const update = from.sent.shift();
        if (update) to.receive(update);
      }
    for (const each of [a, b]) {
      expect(each.lines()).toEqual(a.lines());
      expect(each.lines().join("")).toBe("abcd");
    }
  },
);

// As above, but everyone makes one or two changes a turn. They travel each on its own, in a
// random order between people, or as one change a person. A copy can then be moved on before
// the others have seen it.
it.each([
  [2, "one by one"],
  [3, "one by one"],
  [2, "together"],
  [3, "together"],
] as const)("never loses a letter when %i people's changes arrive %s", (people, arrive) => {
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
    for (let round = 0; round < 3; round++) {
      for (const each of pages)
        for (let changes = 1 + Math.floor(next() * 2); changes > 0; changes--) {
          const line = Math.floor(next() * each.lines().length);
          if (next() < 0.5 && line > 0) each.join(line);
          else each.split(line, Math.floor(next() * (each.length(line) + 1)));
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
        [...letters].some((letter) => !kept.includes(letter))
      )
        wrong.push(`seed ${String(seed)}, round ${String(round)}: ${shown}`);
    }
    for (const each of docs.splice(0)) each.destroy();
  }
  expect(wrong).toEqual([]);
});
