import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { MovedText } from "./movedText.js";
import { applyUpdateFindingRemovedText } from "./removedText.js";

const REMOTE = Symbol("remote");
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Follows = "puts words back" | "may not edit" | "as before this change";

/** A page on the note. It collects what it sends, what it is told, and its answers to others' changes. */
function page(baseline: Uint8Array, follows: Follows = "puts words back") {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, baseline, REMOTE);
  const follower = new MovedText();
  const sent: Uint8Array[] = [];
  const told: string[] = [];
  const answers: Uint8Array[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.origin !== REMOTE) follower.note(transaction);
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
    answers,
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
        follows === "as before this change"
          ? undefined
          : { follower, mayEdit: () => follows === "puts words back" },
      );
      if (removed) told.push(removed.text);
      answers.push(...sent.slice(before));
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

it("puts a person's typed words back into a line someone else joined away", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b] = [page(baseline), page(baseline)];
  a.join(1);
  b.type(1, 1, "TYPED");
  b.type(1, 8, " END");
  settle(a, b);
  for (const each of [a, b]) expect(each.lines()).toEqual(["OneTTYPEDwo END", "Three"]);
  expect(b.told).toEqual([]);
});

it("puts each person's typed words back when two people typed in the joined line", () => {
  const baseline = note("One", "Two", "Three");
  const [a, b, c] = [page(baseline), page(baseline), page(baseline)];
  a.join(1);
  b.type(1, 0, "B");
  c.type(1, 3, "C");
  settle(a, b, c);
  for (const each of [a, b, c]) expect(each.lines()).toEqual(["OneBTwoC", "Three"]);
  expect([...b.told, ...c.told]).toEqual([]);
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

// Each case ends exactly as it does with this change switched off: the same note, and the same
// words in the same order in what the person is told.
it.each<[string, (a: Page, b: Page) => void, "one change" | "one by one"]>([
  [
    "a line the person joined themselves goes with the line it was joined into",
    (a, b) => {
      b.join(2);
      a.join(1);
    },
    "one change",
  ],
  [
    "the other person joins that same line too, after joining the one above it",
    (a, b) => {
      b.join(2);
      a.join(1);
      a.join(1);
    },
    "one by one",
  ],
  [
    "the person typed after a line they joined, and the other person joins that line too",
    (a, b) => {
      b.join(2);
      b.type(1, 2, "X");
      a.join(1);
      a.join(1);
    },
    "one change",
  ],
  [
    "the other person retypes the line's text in another order",
    (a, b) => {
      b.type(2, 2, "!");
      a.deleteLine(2);
      a.type(1, 1, "x");
      a.type(1, 1, "y");
    },
    "one change",
  ],
  [
    "the person may not edit when the join arrives",
    (a, b) => {
      b.type(1, 0, "X");
      b.type(1, 2, "Y");
      a.join(1);
    },
    "one change",
  ],
])("changes nothing when %s", (name, edits, arrive) => {
  const results = (["as before this change", "puts words back"] as const).map((follows) => {
    const baseline = note("a", "b", name.includes("retypes") ? "yx" : "c");
    const a = page(baseline);
    const b = page(baseline, name.includes("may not edit") ? "may not edit" : follows);
    a.doc.clientID = 10;
    b.doc.clientID = 20;
    edits(a, b);
    for (const update of arrive === "one change" ? [a.take()] : a.sent.splice(0)) b.receive(update);
    a.receive(b.take());
    settle(a, b);
    expect(a.lines()).toEqual(b.lines());
    return { lines: b.lines(), told: b.told };
  });
  expect(results[1]).toEqual(results[0]);
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
// as one change a person. The same run is made with this change switched off. With it on, a
// page's own answer never deletes, no letter stands twice that stood once or not at all with it
// off, and no letter is gone that was there with it off.
it.each([
  [2, "one by one"],
  [3, "one by one"],
  [4, "one by one"],
  [2, "together"],
  [3, "together"],
] as const)("is never worse than before when %i people's changes arrive %s", (people, arrive) => {
  const wrong: string[] = [];
  for (let seed = 1; seed <= 400; seed++) {
    const typed: string[] = [];
    const run = (follows: Follows) => {
      const next = random(seed);
      typed.length = 0;
      const baseline = note("abcd", "efgh", "ijkl");
      const pages = Array.from({ length: people }, (_, index) => {
        const each = page(baseline, follows);
        each.doc.clientID = 100 + Math.floor(next() * 1000) * 10 + index;
        return each;
      });
      for (const each of pages)
        for (let changes = 1 + Math.floor(next() * 2); changes > 0; changes--) {
          const line = Math.floor(next() * each.lines().length);
          const roll = next();
          const at = Math.floor(next() * (each.length(line) + 1));
          if (roll < 0.4 && line > 0) each.join(line);
          else if (roll < 0.6) each.split(line, at);
          else {
            typed.push(String.fromCharCode(0x391 + typed.length));
            each.type(line, at, typed.at(-1)!);
          }
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
      const result = {
        shown,
        agree: pages.every((each) => each.lines().join("/") === shown),
        deletes: pages.some((each) =>
          each.answers.some((answer) => Y.decodeUpdate(answer).ds.clients.size > 0),
        ),
      };
      for (const each of docs.splice(0)) each.destroy();
      return result;
    };
    const before = run("as before this change"),
      now = run("puts words back");
    const count = (shown: string, letter: string) => shown.split(letter).length - 1;
    if (
      !now.agree ||
      now.deletes ||
      [..."abcdefghijkl", ...typed].some(
        (letter) =>
          count(now.shown, letter) > Math.max(1, count(before.shown, letter)) ||
          count(now.shown, letter) < Math.min(1, count(before.shown, letter)),
      )
    )
      wrong.push(`seed ${String(seed)}: before ${before.shown}, now ${now.shown}`);
  }
  expect(wrong).toEqual([]);
});
