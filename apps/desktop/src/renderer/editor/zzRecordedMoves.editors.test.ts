// @vitest-environment jsdom
// PROTOTYPE for #4038's design check: recorded moves with the real share-page editor. Not for merge.
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { getDohcYDocBodyFragment, markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";

const REMOTE = Symbol("remote");
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

type Id = string;
const id = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;
type Span = [client: number, clock: number, length: number];
interface MoveRecord {
  kind: "line" | "putBack";
  line?: Id;
  source: Span[];
  copy: Span[];
  seen: [client: number, clock: number][];
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
  for (let type = found.item.parent as Y.AbstractType<unknown> | null; type;) {
    if (!type._item) return found;
    if (type._item.deleted) return null;
    type = type._item.parent as Y.AbstractType<unknown> | null;
  }
  return found;
};
function graph(doc: Y.Doc) {
  const copies = new Map<Id, { key: string; copy: Id }[]>();
  const lineMoves: MoveRecord[] = [];
  for (const [key, value] of doc.getMap<MoveRecord>("moves")) {
    const from = chars(value.source),
      to = chars(value.copy);
    from.forEach((source, at) => {
      const list = copies.get(source) ?? [];
      list.push({ key, copy: to[at]! });
      copies.set(source, list);
    });
    if (value.kind === "line") lineMoves.push(value);
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
interface Lost {
  charId: Id;
  text: string;
  line: Id;
  left: Id[];
  right: Id[];
}

function sharePage(baseline: Uint8Array, mode: Mode) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  const told: string[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const moves = doc.getMap<MoveRecord>("moves");
  const lineId = (line: Y.XmlText): Id => id(line._item!.id.client, line._item!.id.clock);
  const record = (value: MoveRecord) =>
    moves.set(id(doc.clientID, Y.getState(doc.store, doc.clientID)), value);

  /** Inside this page's own change: a record for each line whose deleted text the change wrote again. */
  function recordOwnMoves(transaction: Y.Transaction) {
    const before = (struct: Y.Item) =>
      struct.id.clock < (transaction.beforeState.get(struct.id.client) ?? 0);
    const deletedNow = new Set<Y.Item>();
    const lines = new Set<Y.XmlText>();
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item) || !before(struct)) return;
      deletedNow.add(struct);
      if (struct.content instanceof Y.ContentString && struct.parent instanceof Y.XmlText)
        lines.add(struct.parent);
    });
    if (lines.size === 0) return;
    const writes = new Map<Y.XmlText, { text: string; spans: Span[] }>();
    const structs = doc.store.clients.get(doc.clientID) ?? [];
    const from = transaction.beforeState.get(doc.clientID) ?? 0;
    for (let index = structs.length - 1; index >= 0 && structs[index]!.id.clock >= from; index--) {
      const item = structs[index]!;
      if (
        !(item instanceof Y.Item) ||
        !(item.content instanceof Y.ContentString) ||
        !(item.parent instanceof Y.XmlText)
      )
        continue;
      const write = writes.get(item.parent) ?? { text: "", spans: [] };
      write.text = item.content.str + write.text;
      write.spans.unshift([item.id.client, item.id.clock, item.length]);
      writes.set(item.parent, write);
    }
    for (const line of lines) {
      const source: Span[] = [];
      let text = "";
      const clients = new Set<number>();
      for (let item = line._start; item !== null; item = item.right) {
        clients.add(item.id.client);
        if (deletedNow.has(item) && item.content instanceof Y.ContentString) {
          source.push([item.id.client, item.id.clock, item.length]);
          text += item.content.str;
        }
      }
      if (text === "") continue;
      let copy: Span[] | null = null,
        places = 0;
      for (const [target, write] of writes) {
        if (target === line) continue;
        for (let at = write.text.indexOf(text); at >= 0; at = write.text.indexOf(text, at + 1)) {
          places++;
          const all = chars(write.spans).slice(at, at + text.length);
          copy = all.map((charId) => {
            const [client, clock] = charId.split(":").map(Number) as [number, number];
            return [client, clock, 1] as Span;
          });
        }
      }
      if (places !== 1 || copy === null) continue;
      record({
        kind: "line",
        line: lineId(line),
        source,
        copy,
        seen: [...clients].map((client) => [client, Y.getState(doc.store, client)]),
      });
    }
  }

  let lost: Lost[] = [];
  let waiting: Lost[] = [];
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
      const ids = (item: Y.Item) =>
        Array.from({ length: item.length }, (_, at) => id(item.id.client, item.id.clock + at));
      const left: Id[] = [],
        right: Id[] = [];
      for (let item = struct.left; item !== null; item = item.left)
        if (item.content instanceof Y.ContentString) left.push(...ids(item).reverse());
      for (let item = struct.right; item !== null; item = item.right)
        if (item.content instanceof Y.ContentString) right.push(...ids(item));
      const own = ids(struct);
      for (let at = 0; at < struct.length; at++)
        lost.push({
          charId: own[at]!,
          text: struct.content.str[at]!,
          line: lineId(struct.parent),
          left: [...own.slice(0, at).reverse(), ...left],
          right: [...own.slice(at + 1), ...right],
        });
    });
  });

  function settle() {
    const taken = [...waiting, ...lost];
    lost = [];
    waiting = [];
    if (mode !== "records") return;
    doc.transact(() => {
      const first = graph(doc);
      const groups: { anchor: Id; after: boolean; of: Lost[] }[] = [];
      for (const one of taken) {
        if (first.copies.has(one.charId) || first.doomed.has(one.charId)) continue;
        const [client, clock] = one.charId.split(":").map(Number) as [number, number];
        const unseenBy = first.lineMoves.filter(
          (move) =>
            move.line === one.line &&
            clock >= (move.seen.find(([seen]) => seen === client)?.[1] ?? 0),
        );
        const before = one.left.find((neighbour) => first.copies.has(neighbour));
        const anchor = before ?? one.right.find((neighbour) => first.copies.has(neighbour));
        if (unseenBy.length === 0 || anchor === undefined) {
          told.push(one.text);
          continue;
        }
        const last = groups.at(-1);
        const [lastClient, lastClock] = (last?.of.at(-1)?.charId ?? "0:-9")
          .split(":")
          .map(Number) as [number, number];
        if (last && last.anchor === anchor && lastClient === client && lastClock + 1 === clock)
          last.of.push(one);
        else groups.push({ anchor, after: before !== undefined, of: [one] });
      }
      for (const group of groups) {
        const place = stands(doc, first.survivor(group.anchor));
        if (!place) {
          waiting.push(...group.of);
          continue;
        }
        const text = group.of.map((one) => one.text).join("");
        const clock = Y.getState(doc.store, doc.clientID);
        (place.item.parent as Y.XmlText).insert(
          shownBefore(place.item) + place.offset + (group.after ? 1 : 0),
          text,
        );
        const [client, start] = group.of[0]!.charId.split(":").map(Number) as [number, number];
        record({
          kind: "putBack",
          source: [[client, start, text.length]],
          copy: [[doc.clientID, clock, text.length]],
          seen: [],
        });
      }
      for (const charId of graph(doc).doomed) {
        const place = stands(doc, charId);
        if (place)
          (place.item.parent as Y.XmlText).delete(shownBefore(place.item) + place.offset, 1);
      }
    });
  }

  const mount = window.document.createElement("div");
  window.document.body.append(mount);
  let view: EditorView | undefined;
  const updateState = EditorView.prototype.updateState;
  EditorView.prototype.updateState = function (this: EditorView, state) {
    view = this;
    return updateState.call(this, state);
  };
  const editor = mountLiveBodyEditor(mount, {
    body: getDohcYDocBodyFragment(doc),
    label: "Shared file editor",
    canEdit: () => true,
    edit(change) {
      doc.transact((transaction) => {
        change();
        if (mode === "records") recordOwnMoves(transaction);
      });
      return true;
    },
  });
  EditorView.prototype.updateState = updateState;
  stops.push(() => {
    editor.destroy();
    mount.remove();
    doc.destroy();
  });
  return {
    doc,
    view: view!,
    told,
    stillWaiting: () => waiting.map((one) => one.text).join(""),
    take: () => Y.mergeUpdates(sent.splice(0)),
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update, REMOTE);
      settle();
    },
  };
}
type Person = ReturnType<typeof sharePage>;

const empty = (update: Uint8Array) => {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
};
function exchange(first: Person, second: Person) {
  for (let round = 0; round < 12; round++) {
    const one = first.take(),
      two = second.take();
    if (empty(one) && empty(two)) return;
    if (!empty(one)) second.receive(one);
    if (!empty(two)) first.receive(two);
  }
  throw new Error("the pages kept rewriting the note");
}
function baselineOf(note: string) {
  const seed = markdownToYDoc(note);
  seed.getMap("moves");
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return baseline;
}
function caretIn(person: Person, text: string, offset: number) {
  const { view } = person;
  let start = -1;
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return start < 0;
    if (start < 0 && node.textContent === text) start = pos + 1;
    return false;
  });
  if (start < 0) throw new Error(`no line reads "${text}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + offset)));
}
function press(person: Person, key: string) {
  const { view } = person;
  const event = new window.KeyboardEvent("keydown", { key });
  view.someProp("handleKeyDown", (handle) => handle(view, event));
}
const joinsUp = (text: string) => (person: Person) => {
  caretIn(person, text, 0);
  press(person, "Backspace");
};
const splitsAt = (text: string, offset: number) => (person: Person) => {
  caretIn(person, text, offset);
  press(person, "Enter");
};
const typesAt = (text: string, offset: number, typed: string) => (person: Person) => {
  caretIn(person, text, offset);
  person.view.dispatch(person.view.state.tr.insertText(typed));
};
const run = (markdown: string) =>
  markdown.replace(/^- \[.\] /gmu, "").replace(/&#32;|&nbsp;|\s+/gu, "");

const LINES = "One one\n\nTwo two two\n\nThree\n";
const TASKS = "- [ ] alpha\n- [ ] bravo\n- [ ] charlie\n- [ ] delta\n";
const races: [string, string, (p: Person) => void, (p: Person) => void, string][] = [
  ["both join the same line", LINES, joinsUp("Two two two"), joinsUp("Two two two"), ""],
  ["a join and a split of one line", LINES, joinsUp("Two two two"), splitsAt("Two two two", 3), ""],
  [
    "both split one line in two places",
    LINES,
    splitsAt("Two two two", 3),
    splitsAt("Two two two", 7),
    "",
  ],
  ["joins of neighbouring lines", LINES, joinsUp("Two two two"), joinsUp("Three"), ""],
  [
    "a join and typing at the end",
    LINES,
    joinsUp("Two two two"),
    typesAt("Two two two", 11, "TYPED"),
    "TYPED",
  ],
  [
    "a join and typing in the middle",
    LINES,
    joinsUp("Two two two"),
    typesAt("Two two two", 4, "TYPED"),
    "TYPED",
  ],
  ["joins of neighbouring to-dos", TASKS, joinsUp("bravo"), joinsUp("charlie"), ""],
];

it.each(races.flatMap((race) => ([0, 1] as const).map((order) => [...race, order] as const)))(
  "%s (order %#)",
  (_name, note, one, two, typed, order) => {
    const baseline = baselineOf(note);
    const a = sharePage(baseline, "records"),
      b = sharePage(baseline, "records");
    one(a);
    two(b);
    if (order === 0) exchange(a, b);
    else exchange(b, a);
    const shown = yDocToMarkdown(a.doc);
    expect(yDocToMarkdown(b.doc)).toBe(shown);
    expect([...run(shown)].sort().join("")).toBe([...run(note), ...typed].sort().join(""));
    if (typed) expect(shown.split(typed)).toHaveLength(2);
    expect([...a.told, ...b.told, a.stillWaiting(), b.stillWaiting()].join("")).toBe("");
  },
);

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
function lineTexts(person: Person) {
  const texts: string[] = [];
  person.view.state.doc.descendants((node) => {
    if (!node.isTextblock) return true;
    texts.push(node.textContent);
    return false;
  });
  return texts;
}

const BASE = ["one two three", "four five six", "seven eight nine", "ten eleven twelve"];

it.each([1, 3])(
  "random joins, splits and typing by two people, up to %i changes a turn",
  (most) => {
    const tally = {
      none: { fine: 0, twice: 0, gone: 0, told: 0, differ: 0, threw: 0 },
      records: { fine: 0, twice: 0, gone: 0, told: 0, differ: 0, threw: 0 },
    };
    const examples: string[] = [];
    for (let seed = 1; seed <= 400; seed++)
      for (const mode of ["none", "records"] as const) {
        const next = random(seed);
        const baseline = baselineOf(`${BASE.join("\n\n")}\n`);
        const a = sharePage(baseline, mode),
          b = sharePage(baseline, mode);
        const typed: string[] = [];
        let kind: keyof typeof tally.none = "fine";
        let shown = "";
        try {
          for (let round = 0; round < 6 && kind === "fine"; round++) {
            for (const person of [a, b])
              for (let n = 1 + Math.floor(next() * most); n > 0; n--) {
                const texts = lineTexts(person);
                const index = Math.floor(next() * texts.length);
                const text = texts[index]!;
                const roll = next();
                if (roll < 0.35 && index > 0) joinsUp(text)(person);
                else if (roll < 0.7) splitsAt(text, Math.floor(next() * (text.length + 1)))(person);
                else {
                  typed.push(String.fromCharCode(0x391 + typed.length));
                  typesAt(text, Math.floor(next() * (text.length + 1)), typed.at(-1)!)(person);
                }
              }
            if (next() < 0.5) exchange(a, b);
            else exchange(b, a);
            shown = yDocToMarkdown(a.doc);
            const letters = run(shown);
            const toldAll = [...a.told, ...b.told].join("");
            const want = [...run(BASE.join("")), ...typed];
            const count = (letter: string) => letters.split(letter).length - 1;
            const wanted = (letter: string) => want.filter((other) => other === letter).length;
            const unique = [...new Set(want)];
            kind =
              yDocToMarkdown(b.doc) !== shown
                ? "differ"
                : unique.some(
                      (letter) => count(letter) < wanted(letter) && !toldAll.includes(letter),
                    )
                  ? "gone"
                  : unique.some((letter) => count(letter) > wanted(letter))
                    ? "twice"
                    : unique.some((letter) => count(letter) < wanted(letter))
                      ? "told"
                      : "fine";
          }
        } catch (error) {
          kind = "threw";
          shown = String(error).slice(0, 120);
        }
        tally[mode][kind]++;
        if (mode === "records" && kind !== "fine" && examples.length < 4)
          examples.push(`${kind} seed ${String(seed)}: ${JSON.stringify(shown)}`);
        for (const stop of stops.splice(0).reverse()) stop();
      }
    console.log(
      `RESULT real share-page editor, two people, up to ${String(most)} changes a turn, 400 seeds x 6 rounds\n  today:   ${JSON.stringify(tally.none)}\n  records: ${JSON.stringify(tally.records)}\n${examples.join("\n")}`,
    );
    expect(true).toBe(true);
  },
  600_000,
);
