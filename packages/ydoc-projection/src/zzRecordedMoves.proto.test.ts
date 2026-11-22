// PROTOTYPE for #4038's design check. Not for merge.
//
// Idea: an editor that joins or splits a line writes a record into the document in the same
// change: which character ids it deleted (source), which ids hold the copy, and what it had seen
// of each client that has text in the line. Every page then settles the note from the records:
//   1. Where two records copied the same character, the record with the greater key wins, and
//      everything copied from the others is deleted. Deletes repeat safely, so any page may do it.
//   2. A page whose own characters went with a line that a record moved, and that the record's
//      author had not seen, types them again beside the surviving copy and records that too.
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";

const REMOTE = Symbol("remote");
const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Id = string;
const id = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;
type Span = [client: number, clock: number, length: number];
interface MoveRecord {
  kind: "line" | "putBack";
  /** The line the text was taken from. */
  line?: Id;
  source: Span[];
  copy: Span[];
  seen: [client: number, clock: number][];
  /** For a line with no text to copy: the character its text would have stood beside. */
  beside?: [charId: Id, after: boolean];
}
const chars = (spans: Span[]): Id[] =>
  spans.flatMap(([client, clock, length]) =>
    Array.from({ length }, (_, at) => id(client, clock + at)),
  );
const keyOrder = (left: string, right: string) => {
  const [lc, lk] = left.split(":").map(Number) as [number, number];
  const [rc, rk] = right.split(":").map(Number) as [number, number];
  return lc - rc || lk - rk;
};

function itemOf(doc: Y.Doc, charId: Id): { item: Y.Item; offset: number } | null {
  const [client, clock] = charId.split(":").map(Number) as [number, number];
  const structs = doc.store.clients.get(client) ?? [];
  const last = structs.at(-1);
  if (!last || clock >= last.id.clock + last.length) return null;
  const struct = structs[Y.findIndexSS(structs, clock)];
  return struct instanceof Y.Item ? { item: struct, offset: clock - struct.id.clock } : null;
}
const shownBefore = (item: Y.Item) => {
  let count = 0;
  for (let left = item.left; left !== null; left = left.left)
    if (!left.deleted && left.countable) count += left.length;
  return count;
};
const stands = (doc: Y.Doc, charId: Id) => {
  const found = itemOf(doc, charId);
  if (!found || found.item.deleted) return null;
  const line = found.item.parent;
  return line instanceof Y.XmlText && line._item && !line._item.deleted ? found : null;
};

function graph(doc: Y.Doc) {
  const copies = new Map<Id, { key: string; copy: Id }[]>();
  const lineMoves: { key: string; record: MoveRecord }[] = [];
  for (const [key, value] of doc.getMap<MoveRecord>("moves")) {
    const from = chars(value.source),
      to = chars(value.copy);
    from.forEach((source, at) => {
      const list = copies.get(source) ?? [];
      list.push({ key, copy: to[at]! });
      copies.set(source, list);
    });
    if (value.kind === "line") lineMoves.push({ key, record: value });
  }
  const winner = (source: Id) =>
    copies.get(source)?.reduce((best, next) => (keyOrder(next.key, best.key) > 0 ? next : best));
  const survivor = (charId: Id): Id => {
    for (let at = charId; ;) {
      const next = winner(at);
      if (!next) return at;
      at = next.copy;
    }
  };
  const doomed = new Set<Id>();
  const doom = (charId: Id) => {
    if (doomed.has(charId)) return;
    doomed.add(charId);
    for (const { copy } of copies.get(charId) ?? []) doom(copy);
  };
  for (const [source, list] of copies) {
    const best = winner(source)!;
    for (const entry of list) if (entry !== best) doom(entry.copy);
  }
  return { copies, lineMoves, survivor, doomed };
}

type Mode = "records" | "none";

function page(baseline: Uint8Array, mode: Mode = "records") {
  const doc = new Y.Doc();
  docs.push(doc);
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  const told: string[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const body = doc.getXmlFragment("body");
  const moves = doc.getMap<MoveRecord>("moves");
  const text = (line: number) => (body.get(line) as Y.XmlElement).get(0) as Y.XmlText;
  const liveSpans = (line: Y.XmlText, from = 0): Span[] => {
    const spans: Span[] = [];
    let at = 0;
    for (let item = line._start; item !== null; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
      const skip = Math.max(0, from - at);
      if (skip < item.length)
        spans.push([item.id.client, item.id.clock + skip, item.length - skip]);
      at += item.length;
    }
    return spans;
  };
  const seenOf = (line: Y.XmlText): MoveRecord["seen"] => {
    const clients = new Set<number>();
    for (let item = line._start; item !== null; item = item.right) clients.add(item.id.client);
    return [...clients].map((client) => [client, Y.getState(doc.store, client)]);
  };
  const record = (value: MoveRecord) => {
    if (mode === "records") moves.set(id(doc.clientID, Y.getState(doc.store, doc.clientID)), value);
  };
  const lineId = (line: Y.XmlText): Id => id(line._item!.id.client, line._item!.id.clock);
  const edge = (line: Y.XmlText, which: "first" | "last"): Id | undefined => {
    const all = chars(liveSpans(line));
    return which === "first" ? all[0] : all.at(-1);
  };

  // What a change from elsewhere took of this page's own text, read before Yjs drops it.
  let lost: { charId: Id; text: string; line: Id; left: Id[]; right: Id[] }[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.origin !== REMOTE || mode !== "records") return;
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (
        !(struct instanceof Y.Item) ||
        struct.id.client !== doc.clientID ||
        !(struct.content instanceof Y.ContentString) ||
        !(struct.parent instanceof Y.XmlText) ||
        struct.id.clock >= (transaction.beforeState.get(struct.id.client) ?? 0)
      )
        return;
      const line = struct.parent;
      const neighbours = (start: Y.Item | null, step: (item: Y.Item) => Y.Item | null) => {
        const ids: Id[] = [];
        for (let item = start; item !== null; item = step(item))
          if (item.content instanceof Y.ContentString) {
            const all = Array.from({ length: item.length }, (_, at) =>
              id(item.id.client, item.id.clock + at),
            );
            ids.push(...(step === goLeft ? all.reverse() : all));
          }
        return ids;
      };
      const goLeft = (item: Y.Item) => item.left,
        goRight = (item: Y.Item) => item.right;
      for (let at = 0; at < struct.length; at++)
        lost.push({
          charId: id(struct.id.client, struct.id.clock + at),
          text: struct.content.str[at]!,
          line: lineId(line),
          left: neighbours(struct.left, goLeft),
          right: neighbours(struct.right, goRight),
        });
    });
  });

  // Text whose place is not in the note yet: its neighbour's author has still to put that back.
  let waiting: typeof lost = [];
  function settle() {
    if (mode !== "records") {
      lost = [];
      return;
    }
    const taken = [...waiting, ...lost];
    lost = [];
    waiting = [];
    doc.transact(() => {
      const first = graph(doc);
      // Rule 2: this page's own characters that went with a moved line, unseen by its mover.
      const groups: { anchor: Id; after: boolean; ids: Id[]; text: string; of: typeof lost }[] = [];
      for (const one of taken) {
        const { charId, text: letter, line, left, right } = one;
        if (first.copies.has(charId) || first.doomed.has(charId)) continue;
        const [client, clock] = charId.split(":").map(Number) as [number, number];
        const unseenBy = first.lineMoves.filter(
          ({ record: move }) =>
            move.line === line && clock >= (move.seen.find(([seen]) => seen === client)?.[1] ?? 0),
        );
        if (unseenBy.length === 0) {
          told.push(letter);
          continue;
        }
        let before = left.find((neighbour) => first.copies.has(neighbour));
        const behind = right.find((neighbour) => first.copies.has(neighbour));
        let anchor = before ?? behind;
        if (anchor === undefined) {
          const beside = unseenBy.find(({ record: move }) => move.beside)?.record.beside;
          if (beside) {
            anchor = beside[0];
            before = beside[1] ? beside[0] : undefined;
          }
        }
        if (anchor === undefined) {
          told.push(letter);
          continue;
        }
        const last = groups.at(-1);
        const [lastClient, lastClock] = (last?.ids.at(-1) ?? "0:-9").split(":").map(Number) as [
          number,
          number,
        ];
        if (last && last.anchor === anchor && lastClient === client && lastClock + 1 === clock) {
          last.ids.push(charId);
          last.text += letter;
          last.of.push(one);
        } else
          groups.push({
            anchor,
            after: before !== undefined,
            ids: [charId],
            text: letter,
            of: [one],
          });
      }
      for (const group of groups) {
        const place = stands(doc, first.survivor(group.anchor));
        if (!place) {
          waiting.push(...group.of);
          continue;
        }
        const clock = Y.getState(doc.store, doc.clientID);
        (place.item.parent as Y.XmlText).insert(
          shownBefore(place.item) + place.offset + (group.after ? 1 : 0),
          group.text,
        );
        const [client, start] = group.ids[0]!.split(":").map(Number) as [number, number];
        record({
          kind: "putBack",
          source: [[client, start, group.ids.length]],
          copy: [[doc.clientID, clock, group.text.length]],
          seen: [],
        });
      }
      // Rule 1: everything copied by a record that lost goes.
      for (const charId of graph(doc).doomed) {
        const place = stands(doc, charId);
        if (place)
          (place.item.parent as Y.XmlText).delete(shownBefore(place.item) + place.offset, 1);
      }
    });
  }

  return {
    doc,
    told,
    stillWaiting: () => waiting.map((one) => one.text).join(""),
    sent,
    lines: () => body.toArray().map((line) => (line as Y.XmlElement).toArray().join("")),
    length: (line: number) => text(line).length,
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update, REMOTE);
      settle();
    },
    join(line: number) {
      doc.transact(() => {
        const above = text(line - 1),
          here = text(line);
        if (above.length === 0) {
          const first = edge(here, "first");
          record({
            kind: "line",
            line: lineId(above),
            source: [],
            copy: [],
            seen: seenOf(above),
            ...(first ? { beside: [first, false] as [Id, boolean] } : {}),
          });
          return body.delete(line - 1, 1);
        }
        const source = liveSpans(here),
          seen = seenOf(here);
        const last = edge(above, "last")!;
        const clock = Y.getState(doc.store, doc.clientID);
        const moved = here.toString();
        above.insert(above.length, moved);
        const from = lineId(here);
        body.delete(line, 1);
        record({
          kind: "line",
          line: from,
          source,
          copy: moved ? [[doc.clientID, clock, moved.length]] : [],
          seen,
          ...(moved ? {} : { beside: [last, true] as [Id, boolean] }),
        });
      });
    },
    split(line: number, at: number) {
      doc.transact(() => {
        const here = text(line);
        const source = liveSpans(here, at),
          seen = seenOf(here);
        const tail = here.toString().slice(at);
        here.delete(at, tail.length);
        const next = new Y.XmlElement("paragraph");
        const fresh = new Y.XmlText(tail);
        next.insert(0, [fresh]);
        body.insert(line + 1, [next]);
        const first = fresh._start;
        if (first)
          record({
            kind: "line",
            line: lineId(here),
            source,
            copy: [[first.id.client, first.id.clock, tail.length]],
            seen,
          });
      });
    },
    type: (line: number, at: number, typed: string) => text(line).insert(at, typed),
  };
}
type Page = ReturnType<typeof page>;

function note(...lines: string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap("moves");
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

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

type Arrive = "one by one" | "together" | "after a reconnect";

function run(seed: number, people: number, arrive: Arrive, mode: Mode, rounds: number) {
  const next = random(seed);
  const baseline = note("abcd", "efgh", "ijkl");
  const pages = Array.from({ length: people }, (_, index) => {
    const each = page(baseline, mode);
    each.doc.clientID = 100 + Math.floor(next() * 1000) * 10 + index;
    return each;
  });
  const typed: string[] = [];
  const log: string[] = [];
  let agree = true;
  for (let round = 0; round < rounds; round++) {
    for (const [index, each] of pages.entries())
      for (let changes = 1 + Math.floor(next() * 2); changes > 0; changes--) {
        const line = Math.floor(next() * each.lines().length);
        const roll = next();
        const at = Math.floor(next() * (each.length(line) + 1));
        if (roll < 0.4 && line > 0) {
          each.join(line);
          log.push(`${String(index)}:join${String(line)}`);
        } else if (roll < 0.75) {
          each.split(line, at);
          log.push(`${String(index)}:split${String(line)}@${String(at)}`);
        } else {
          typed.push(String.fromCharCode(0x391 + typed.length));
          each.type(line, at, typed.at(-1)!);
          log.push(`${String(index)}:type${String(line)}@${String(at)}`);
        }
      }
    log.push("|");
    if (arrive === "together")
      for (const each of pages) each.sent.push(Y.mergeUpdates(each.sent.splice(0)));
    for (let sends = 0; ; sends++) {
      if (sends === 4000) return { shown: "LOOP", agree: false, typed, told: [], log };
      if (arrive === "after a reconnect") {
        // Everyone drops their queue and exchanges whole states, as a reconnect does.
        for (const each of pages) each.sent.length = 0;
        let moved = false;
        for (const from of pages)
          for (const to of pages) {
            if (from === to) continue;
            const diff = Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc));
            const before = Y.encodeStateAsUpdate(to.doc);
            to.receive(diff);
            if (Y.encodeStateAsUpdate(to.doc).length !== before.length) moved = true;
          }
        if (!moved && pages.every((each) => each.sent.length === 0)) break;
        continue;
      }
      const waiting = pages.filter((each) => each.sent.length > 0);
      if (waiting.length === 0) break;
      const from = waiting[Math.floor(next() * waiting.length)]!;
      const update = from.sent.shift()!;
      for (const to of pages) if (to !== from) to.receive(update);
    }
    const shown = pages[0]!.lines().join("/");
    if (pages.some((each) => each.lines().join("/") !== shown)) agree = false;
  }
  const result = {
    shown: pages[0]!.lines().join("/"),
    agree,
    typed,
    told: pages.flatMap((each) => [...each.told, each.stillWaiting()]),
    log,
  };
  for (const each of docs.splice(0)) each.destroy();
  return result;
}

const SETUPS: [number, Arrive, number][] = [
  [2, "one by one", 1],
  [2, "together", 1],
  [2, "one by one", 4],
  [3, "one by one", 3],
  [3, "together", 3],
  [4, "one by one", 3],
  [4, "together", 3],
  [2, "after a reconnect", 3],
  [3, "after a reconnect", 3],
];

it.each(SETUPS)(
  "%i people, changes arrive %s, %i rounds",
  (people, arrive, rounds) => {
    const tally = {
      none: { fine: 0, twice: 0, gone: 0, told: 0, differ: 0 },
      records: { fine: 0, twice: 0, gone: 0, told: 0, differ: 0 },
    };
    const examples: string[] = [];
    const SEEDS = 1500;
    for (let seed = 1; seed <= SEEDS; seed++)
      for (const mode of ["none", "records"] as const) {
        const result = run(seed, people, arrive, mode, rounds);
        const letters = [..."abcdefghijkl", ...result.typed];
        const count = (letter: string) => result.shown.split(letter).length - 1;
        const kind = !result.agree
          ? "differ"
          : letters.some((letter) => count(letter) === 0 && !result.told.join("").includes(letter))
            ? "gone"
            : letters.some((letter) => count(letter) > 1)
              ? "twice"
              : letters.some((letter) => count(letter) === 0)
                ? "told"
                : "fine";
        tally[mode][kind]++;
        if (mode === "records" && kind !== "fine" && examples.length < 3)
          examples.push(
            `${kind} seed ${String(seed)}: ${result.log.join(" ")} => ${result.shown} told ${result.told.join("")}`,
          );
      }
    console.log(
      `RESULT ${String(people)} people, ${arrive}, ${String(rounds)} rounds, ${String(SEEDS)} seeds\n  today:   ${JSON.stringify(tally.none)}\n  records: ${JSON.stringify(tally.records)}\n${examples.join("\n")}`,
    );
    expect(true).toBe(true);
  },
  600_000,
);
