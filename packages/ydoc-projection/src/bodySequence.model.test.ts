import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const REMOTE = Symbol("remote");
const LOCAL = Symbol("local");
const FIELD = "sequence";
const BLOCK = "block";

function boundary(attrs: Record<string, unknown>) {
  const element = new Y.XmlElement(BLOCK);
  for (const [key, value] of Object.entries(attrs))
    element.setAttribute(key, value as unknown as string);
  return element;
}

type Id = string;
const idOf = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;

type Token =
  | { kind: "char"; id: Id; text: string; marks: string }
  | { kind: "boundary" | "atom"; id: Id; attrs: string };

function read(text: Y.Text): Token[] {
  const tokens: Token[] = [];
  const marks = new Map<string, unknown>();
  for (let item = text._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) {
      if (typeof content.value === "object" && content.value !== null)
        marks.set(content.key, content.value);
      else marks.delete(content.key);
    } else if (content instanceof Y.ContentString) {
      const on = [...marks.keys()].sort().join(",");
      for (let at = 0; at < content.str.length; at++)
        tokens.push({
          kind: "char",
          id: idOf(item.id.client, item.id.clock + at),
          text: content.str[at]!,
          marks: on,
        });
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      const attrs = content.type.getAttributes() as Record<string, unknown>;
      tokens.push({
        kind: content.type.nodeName === BLOCK ? "boundary" : "atom",
        id: idOf(item.id.client, item.id.clock),
        attrs: JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))),
      });
    }
  }
  return tokens;
}

function linesOf(tokens: Token[]): string[] {
  const lines: string[] = [];
  for (const token of tokens) {
    const text = token.kind === "char" ? token.text : "";
    if (token.kind === "boundary") lines.push("");
    else if (lines.length === 0) lines.push(text);
    else lines[lines.length - 1] += text;
  }
  return lines;
}

type Effects = {
  insertedChars: Id[];
  deletedChars: Id[];
  insertedBoundaries: Id[];
  deletedBoundaries: Id[];
  marks: boolean;
  known: Set<Id>;
};

class Oracle {
  readonly rootOf = new Map<Id, Id>();
  readonly typed = new Set<Id>();
  readonly everDeletedChars = new Set<Id>();
  readonly insertedChars = new Set<Id>();
  readonly deletedChars = new Set<Id>();
  readonly insertedBoundaries = new Set<Id>();
  readonly deletedBoundaries = new Set<Id>();
  readonly snapshots: Id[][] = [];
  implicitFirstLine = 0;
  root(id: Id): Id {
    for (let at = id; ;) {
      const next = this.rootOf.get(at);
      if (next === undefined) return at;
      at = next;
    }
  }
}

const docs: Y.Doc[] = [];
// Yjs joins changes made within its capture window into one undo step. A stopped clock makes the
// steps depend only on where the model ends one.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.useRealTimers();
});

function person(
  baseline: Uint8Array,
  clientID: number,
  oracle: Oracle,
  gc = true,
  steps: "each change" | "grouped" = "each change",
) {
  const doc = new Y.Doc({ gc });
  docs.push(doc);
  doc.clientID = clientID;
  Y.applyUpdate(doc, baseline, REMOTE);
  const text = doc.getText(FIELD);
  const manager = new Y.UndoManager(text, {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 60_000,
    ignoreRemoteMapChanges: true,
  });
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const undoMirror: Effects[] = [];
  let redoMirror: Effects[] = [];

  const tokens = () => read(text);
  const visible = (kind: Token["kind"], from: Token[]) =>
    new Set(from.filter((token) => token.kind === kind).map((token) => token.id));
  const minus = (left: Set<Id>, right: Set<Id>) => [...left].filter((id) => !right.has(id));
  const marksOf = (from: Token[]) =>
    new Map(from.flatMap((token) => (token.kind === "char" ? [[token.id, token.marks]] : [])));

  const learnCopies = () => {
    for (const structs of doc.store.clients.values())
      for (const struct of structs) {
        if (!(struct instanceof Y.Item) || struct.redone === null) continue;
        for (let at = 0; at < struct.length; at++)
          oracle.rootOf.set(
            idOf(struct.redone.client, struct.redone.clock + at),
            oracle.root(idOf(struct.id.client, struct.id.clock + at)),
          );
      }
  };

  const noVisibleCharBetween = (left: Id, right: Id) => {
    let inside = false;
    for (let item = text._start; item !== null; item = item.right) {
      const ids = Array.from({ length: item.length }, (_, at) =>
        idOf(item.id.client, item.id.clock + at),
      );
      const edge = ids.includes(left) || ids.includes(right);
      if (edge && inside) return true;
      if (edge) inside = true;
      else if (inside && !item.deleted && item.content instanceof Y.ContentString) return false;
    }
    return false;
  };

  const sourceOf = (copy: Id): Id | null => {
    for (const structs of doc.store.clients.values())
      for (const struct of structs)
        if (
          struct instanceof Y.Item &&
          struct.redone !== null &&
          idOf(struct.redone.client, struct.redone.clock) === copy
        )
          return idOf(struct.id.client, struct.id.clock);
    return null;
  };

  const raw = () => {
    const out: string[] = [];
    for (let item = text._start; item !== null; item = item.right) {
      const c = item.content;
      const what =
        c instanceof Y.ContentFormat
          ? `F(${c.key}=${JSON.stringify(c.value)})`
          : c instanceof Y.ContentString
            ? JSON.stringify(c.str)
            : c instanceof Y.ContentType
              ? "[B]"
              : "(gone)";
      out.push(
        `${item.deleted ? "~" : ""}${what}@${String(item.id.client)}:${String(item.id.clock)}`,
      );
    }
    return out.join(" ");
  };
  const observe = (
    act: () => void,
    mayMark: () => boolean,
    sawThen: () => (id: Id) => boolean = () => () => true,
  ): Effects => {
    const before = tokens();
    const rawBefore = process.env.BODY_SEQUENCE_DEBUG ? raw() : "";
    act();
    const after = tokens();
    const marks = mayMark();
    const effects: Effects = {
      insertedChars: minus(visible("char", after), visible("char", before)),
      deletedChars: minus(visible("char", before), visible("char", after)),
      insertedBoundaries: minus(visible("boundary", after), visible("boundary", before)),
      deletedBoundaries: minus(visible("boundary", before), visible("boundary", after)),
      marks,
      known: visible("char", before),
    };
    if (!marks) {
      const was = marksOf(before);
      const saw = sawThen();
      for (const [id, now] of marksOf(after))
        if (was.has(id) && was.get(id) !== now && saw(id))
          throw new Error(
            `a change that is not a mark changed the marks of ${id}
BEFORE ${rawBefore}
AFTER  ${raw()}`,
          );
    }
    for (const id of effects.deletedChars) oracle.everDeletedChars.add(oracle.root(id));
    for (const id of effects.insertedChars) oracle.insertedChars.add(id);
    for (const id of effects.deletedChars) oracle.deletedChars.add(id);
    for (const id of effects.insertedBoundaries) oracle.insertedBoundaries.add(id);
    for (const id of effects.deletedBoundaries) oracle.deletedBoundaries.add(id);
    oracle.snapshots.push(after.map((token) => token.id));
    if (after.length > 0 && after[0]!.kind === "char") oracle.implicitFirstLine++;
    return effects;
  };

  const local = (
    act: () => void,
    expected: { chars?: number; boundaries?: number; marks?: boolean },
  ): Effects => {
    if (steps === "each change") manager.stopCapturing();
    const depth = manager.undoStack.length;
    const effects = observe(
      () => doc.transact(act, LOCAL),
      () => expected.marks ?? false,
    );
    const chars = effects.insertedChars.length - effects.deletedChars.length;
    const boundaries = effects.insertedBoundaries.length - effects.deletedBoundaries.length;
    if (chars !== (expected.chars ?? 0) || boundaries !== (expected.boundaries ?? 0))
      throw new Error(
        `expected ${JSON.stringify(expected)} and saw ${String(chars)} letters and ${String(boundaries)} boundaries`,
      );
    if ((expected.boundaries ?? 0) >= 0 && effects.deletedBoundaries.length > 0)
      throw new Error("a change that deletes no boundary deleted one");
    if ((expected.boundaries ?? 0) <= 0 && effects.insertedBoundaries.length > 0)
      throw new Error("a change that adds no boundary added one");
    if ((expected.chars ?? 0) >= 0 && effects.deletedChars.length > 0)
      throw new Error("a change that deletes no letters deleted letters");
    if ((expected.chars ?? 0) <= 0 && effects.insertedChars.length > 0)
      throw new Error("a change that types no letters added letters");
    for (const id of effects.insertedChars) oracle.typed.add(id);
    const top = undoMirror.at(-1);
    if (manager.undoStack.length > depth) undoMirror.push(effects);
    else if (top && manager.undoStack.length === depth) {
      top.insertedChars.push(...effects.insertedChars);
      top.deletedChars.push(...effects.deletedChars);
      top.insertedBoundaries.push(...effects.insertedBoundaries);
      top.deletedBoundaries.push(...effects.deletedBoundaries);
      top.marks ||= effects.marks;
      top.known = new Set([...top.known].filter((id) => effects.known.has(id)));
    }
    if (manager.redoStack.length === 0) redoMirror = [];
    return effects;
  };

  const attrsAt = (index: number) => {
    const marks = new Map<string, unknown>();
    let passed = 0;
    for (let item = text._start; item !== null && passed < index; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentFormat) {
        if (item.content.value === null) marks.delete(item.content.key);
        else marks.set(item.content.key, item.content.value);
      } else if (item.countable) passed += item.length;
    }
    return Object.fromEntries(marks);
  };

  const back = (which: "undo" | "redo") => {
    const from = which === "undo" ? undoMirror : redoMirror;
    const to = which === "undo" ? redoMirror : undoMirror;
    const stack = () => (which === "undo" ? manager.undoStack : manager.redoStack);
    const other = () => (which === "undo" ? manager.redoStack : manager.undoStack);
    const depth = stack().length;
    const otherDepth = other().length;
    let popped: Effects[] = [];
    const effects = observe(
      () => {
        if (which === "undo") manager.undo();
        else manager.redo();
        popped = from.splice(stack().length, depth - stack().length);
      },
      () => popped.some((entry) => entry.marks),
      () => (id) => popped.every((entry) => entry.known.has(id)),
    );
    learnCopies();
    const roots = (ids: Id[]) => ids.map((id) => oracle.root(id));
    const mayDeleteChars = new Set(popped.flatMap((entry) => roots(entry.insertedChars)));
    const mayAddChars = new Set(popped.flatMap((entry) => roots(entry.deletedChars)));
    const mayDeleteBoundaries = new Set(popped.flatMap((entry) => roots(entry.insertedBoundaries)));
    const mayAddBoundaries = new Set(popped.flatMap((entry) => roots(entry.deletedBoundaries)));
    const noMoreThan = (ids: Id[], deleted: Id[]) => {
      const left = new Map<Id, number>();
      for (const id of roots(deleted)) left.set(id, (left.get(id) ?? 0) + 1);
      return roots(ids).every((id) => {
        left.set(id, (left.get(id) ?? 0) - 1);
        return left.get(id)! >= 0;
      });
    };
    const once = (ids: Id[], kind: "deletedChars" | "deletedBoundaries") =>
      noMoreThan(
        ids,
        popped.flatMap((entry) => entry[kind]),
      );
    const within = (ids: Id[], allowed: Set<Id>) => roots(ids).every((id) => allowed.has(id));
    if (!within(effects.deletedChars, mayDeleteChars))
      throw new Error(`${which} deleted letters that its change did not type`);
    if (!within(effects.insertedChars, mayAddChars) || !once(effects.insertedChars, "deletedChars"))
      throw new Error(`${which} added letters that its change did not delete`);
    if (!within(effects.deletedBoundaries, mayDeleteBoundaries))
      throw new Error(`${which} deleted a boundary that its change did not add`);
    if (
      !within(effects.insertedBoundaries, mayAddBoundaries) ||
      !once(effects.insertedBoundaries, "deletedBoundaries")
    )
      throw new Error(`${which} added a boundary that its change did not delete`);
    for (const copy of effects.insertedBoundaries) {
      const source = sourceOf(copy);
      if (source === null || !noVisibleCharBetween(source, copy))
        throw new Error(`${which} put a boundary back away from where it was`);
    }
    if (other().length > otherDepth) to.push(effects);
    return effects;
  };

  const boundaryIndexes = () =>
    tokens().flatMap((token, index) => (token.kind === "boundary" ? [index] : []));
  const lineStart = (line: number) => {
    const all = tokens();
    const implicit = all.length > 0 && all[0]!.kind === "char" ? 1 : 0;
    if (implicit === 1 && line === 0) return 0;
    const index = boundaryIndexes()[line - implicit];
    if (index === undefined) throw new Error(`no line ${String(line)}`);
    return index + 1;
  };

  return {
    doc,
    text,
    sent,
    tokens,
    lines: () => linesOf(tokens()),
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update, REMOTE);
    },
    typeAt(index: number, letters: string) {
      return local(() => text.insert(index, letters), { chars: letters.length });
    },
    deleteCharsAt(index: number, length: number) {
      return local(() => text.delete(index, length), { chars: -length, marks: true });
    },
    splitAt(index: number, attrs: Record<string, unknown> = { type: "paragraph" }) {
      return local(() => text.insertEmbed(index, boundary(attrs), attrsAt(index)), {
        boundaries: 1,
      });
    },
    joinAt(index: number) {
      if (tokens()[index]?.kind !== "boundary") throw new Error("not a boundary");
      return local(() => text.delete(index, 1), { boundaries: -1 });
    },
    retypeAt(index: number, attrs: Record<string, unknown>) {
      const token = tokens()[index];
      if (!token || token.kind === "char") throw new Error("not an element");
      return local(() => {
        let at = 0;
        for (let item = text._start; item !== null; item = item.right) {
          if (item.deleted || !item.countable) continue;
          if (at === index && item.content instanceof Y.ContentType) {
            const element = item.content.type as Y.XmlElement;
            for (const [key, value] of Object.entries(attrs))
              element.setAttribute(key, value as unknown as string);
            return;
          }
          at += item.length;
        }
      }, {});
    },
    markAt(index: number, length: number, mark: string) {
      return local(() => text.format(index, length, { [mark]: {} }), { marks: true });
    },
    newStep: () => manager.stopCapturing(),
    undo: () => back("undo"),
    redo: () => back("redo"),
    canUndo: () => manager.undoStack.length > 0,
    canRedo: () => manager.redoStack.length > 0,
    type(line: number, offset: number, letters: string) {
      return this.typeAt(lineStart(line) + offset, letters);
    },
    split(line: number, offset: number) {
      return this.splitAt(lineStart(line) + offset);
    },
    join(line: number) {
      return this.joinAt(lineStart(line) - 1);
    },
    removeLine(line: number) {
      const start = lineStart(line);
      const length = linesOf(tokens())[line]!.length;
      this.deleteCharsAt(start, length);
      return this.joinAt(start - 1);
    },
  };
}
type Person = ReturnType<typeof person>;

function note(...lines: string[]): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const text = doc.getText(FIELD);
  for (const line of lines) {
    text.insertEmbed(text.length, boundary({ type: "paragraph" }), {});
    text.insert(text.length, line, {});
  }
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

type Arrive = "one by one" | "merged" | "after a reconnect";
const ARRIVALS: Arrive[] = ["one by one", "merged", "after a reconnect"];

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function deliver(people: Person[], arrive: Arrive, next: () => number) {
  if (arrive === "after a reconnect") {
    for (const each of people) each.sent.length = 0;
    for (let pass = 0; pass < 3; pass++)
      for (const from of people)
        for (const to of people)
          if (from !== to) to.receive(Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
    return;
  }
  if (arrive === "merged")
    for (const each of people)
      if (each.sent.length > 0) each.sent.push(Y.mergeUpdates(each.sent.splice(0)));
  for (;;) {
    const waiting = people.filter((each) => each.sent.length > 0);
    if (waiting.length === 0) return;
    const from = waiting[Math.floor(next() * waiting.length)]!;
    const update = from.sent.shift()!;
    for (const to of people) if (to !== from) to.receive(update);
  }
}

function agreed(people: Person[]): Token[] {
  const first = people[0]!.tokens();
  for (const each of people) {
    expect(each.tokens()).toEqual(first);
    const reopened = new Y.Doc();
    const text = reopened.getText(FIELD);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(each.doc));
    const read_ = read(text);
    reopened.destroy();
    expect(read_).toEqual(first);
  }
  return first;
}

function holds(oracle: Oracle, final: Token[]) {
  const letters = new Set(final.filter((token) => token.kind === "char").map((token) => token.id));
  for (const id of oracle.insertedChars)
    if (!oracle.deletedChars.has(id) && !letters.has(id))
      throw new Error("a letter no change deleted is gone");
  for (const id of letters)
    if (oracle.deletedChars.has(id) || !oracle.insertedChars.has(id))
      throw new Error("a letter stands that no change left standing");
  const shown = final
    .filter((token) => token.kind === "char")
    .map((token) => oracle.root(token.id));
  const times = new Map<Id, number>();
  for (const id of shown) times.set(id, (times.get(id) ?? 0) + 1);
  for (const id of oracle.typed) {
    if (oracle.everDeletedChars.has(oracle.root(id))) continue;
    if (times.get(id) !== 1)
      throw new Error(
        `a letter nobody deleted stands ${String(times.get(id) ?? 0)} times in the note`,
      );
  }
  const boundaries = new Set(
    final.filter((token) => token.kind === "boundary").map((token) => token.id),
  );
  for (const id of boundaries)
    if (!oracle.insertedBoundaries.has(id))
      throw new Error("a boundary stands that no change added");
  for (const id of oracle.insertedBoundaries)
    if (!oracle.deletedBoundaries.has(id) && !boundaries.has(id))
      throw new Error("a boundary nobody deleted is gone");
  for (const id of boundaries)
    if (oracle.deletedBoundaries.has(id)) throw new Error("a deleted boundary still stands");
  const place = new Map(final.map((token, index) => [token.id, index]));
  for (const snapshot of oracle.snapshots) {
    let last = -1;
    for (const id of snapshot) {
      const at = place.get(id);
      if (at === undefined) continue;
      if (at < last) throw new Error("two things changed order");
      last = at;
    }
  }
}

function team(
  count: number,
  baseline: Uint8Array,
  gc = true,
  steps: "each change" | "grouped" = "each change",
) {
  const oracle = new Oracle();
  const base = new Y.Doc();
  Y.applyUpdate(base, baseline);
  for (const token of read(base.getText(FIELD))) {
    if (token.kind === "char") {
      oracle.typed.add(token.id);
      oracle.insertedChars.add(token.id);
    } else if (token.kind === "boundary") oracle.insertedBoundaries.add(token.id);
  }
  base.destroy();
  const people = Array.from({ length: count }, (_, index) =>
    person(baseline, 10 * (index + 1), oracle, gc, steps),
  );
  return { oracle, people };
}

const COUNTS = [2, 3, 4];
const setups = COUNTS.flatMap((count) => ARRIVALS.map((arrive) => [count, arrive] as const));

describe.each(setups)("%i people, changes arriving %s", (count, arrive) => {
  const settle = (people: Person[], oracle: Oracle) => {
    deliver(people, arrive, random(7));
    const final = agreed(people);
    holds(oracle, final);
    return linesOf(final);
  };
  const undoAll = (people: Person[], oracle: Oracle) => {
    for (const each of people) while (each.canUndo()) each.undo();
    return settle(people, oracle);
  };

  it("keeps a line once when everyone joins it to the line above", () => {
    const { oracle, people } = team(count, note("One one", "Two two two", "Three"));
    for (const each of people) each.join(1);
    expect(settle(people, oracle)).toEqual(["One oneTwo two two", "Three"]);
    people[0]!.undo();
    expect(settle(people, oracle)).toEqual(["One one", "Two two two", "Three"]);
    for (const each of people.slice(1)) each.undo();
    const lines = settle(people, oracle);
    expect(lines.filter((line) => line !== "")).toEqual(["One one", "Two two two", "Three"]);
    expect(lines.filter((line) => line === "")).toHaveLength(count - 1);
  });

  it("keeps a line once when one joins it and another splits it", () => {
    const { oracle, people } = team(count, note("One one", "Two two two", "Three"));
    people[0]!.join(1);
    people[1]!.split(1, 4);
    expect(settle(people, oracle)).toEqual(["One oneTwo ", "two two", "Three"]);
    expect(undoAll(people, oracle)).toEqual(["One one", "Two two two", "Three"]);
  });

  it("leaves an empty line and no doubled text when everyone splits a line at one place", () => {
    const { oracle, people } = team(count, note("One one", "Two two two"));
    for (const each of people) each.split(1, 4);
    const lines = settle(people, oracle);
    expect(lines.filter((line) => line !== "")).toEqual(["One one", "Two ", "two two"]);
    expect(lines.filter((line) => line === "")).toHaveLength(count - 1);
    expect(undoAll(people, oracle)).toEqual(["One one", "Two two two"]);
  });

  it("keeps every line when neighbouring lines are joined", () => {
    const { oracle, people } = team(count, note("One one", "Two two two", "Three"));
    people[0]!.join(1);
    people[1]!.join(2);
    expect(settle(people, oracle)).toEqual(["One oneTwo two twoThree"]);
    expect(undoAll(people, oracle)).toEqual(["One one", "Two two two", "Three"]);
  });

  it("keeps what one person types in a line another joins away", () => {
    const { oracle, people } = team(count, note("One one", "Two two two", "Three"));
    people[0]!.join(1);
    people[1]!.type(1, 11, " more");
    people.at(-1)!.type(1, 0, ">");
    expect(settle(people, oracle)).toEqual(["One one>Two two two more", "Three"]);
    people[0]!.undo();
    expect(settle(people, oracle)).toEqual(["One one", ">Two two two more", "Three"]);
  });

  it("keeps c when one joins it and splits it out, one joins it, and one deletes b", () => {
    const { oracle, people } = team(Math.max(count, 3), note("a", "b", "c"));
    people[0]!.join(2);
    people[0]!.split(1, 1);
    people[1]!.join(2);
    people[2]!.removeLine(1);
    expect(settle(people, oracle).join("")).toBe("ac");
    expect(people[0]!.lines().at(-1)).toBe("c");
  });

  it("reads abXc when both join bc up and one types between b and c first", () => {
    const { oracle, people } = team(count, note("a", "bc"));
    people[0]!.join(1);
    people[1]!.join(1);
    people[1]!.type(0, 2, "X");
    expect(settle(people, oracle)).toEqual(["abXc"]);
    people[1]!.undo();
    expect(settle(people, oracle)).toEqual(["abc"]);
    people[1]!.undo();
    expect(settle(people, oracle)).toEqual(["a", "bc"]);
  });

  it("reads ppkkll when one joins ll into kk and leaves, and another joins both into pp", () => {
    const { oracle, people } = team(count, note("pp", "kk", "ll"));
    people[0]!.join(2);
    const left = people[0]!.sent.splice(0);
    people[1]!.join(1);
    people[1]!.join(1);
    const rest = people.slice(1);
    for (const each of rest) for (const update of left) each.receive(update);
    deliver(rest, arrive, random(3));
    const final = agreed(rest);
    holds(oracle, final);
    expect(linesOf(final)).toEqual(["ppkkll"]);
    people[1]!.undo();
    people[1]!.undo();
    deliver(rest, arrive, random(3));
    expect(linesOf(agreed(rest))).toEqual(["pp", "kk", "ll"]);
  });

  it("agrees after a line's kind is changed, the line is joined away, and both are undone as one step", () => {
    for (const gc of [true, false]) {
      const { oracle, people } = team(count, note("one", "two"), gc, "grouped");
      const [first] = people;
      first!.retypeAt(4, { type: "heading", level: 2 });
      first!.newStep();
      first!.retypeAt(4, { type: "paragraph" });
      first!.joinAt(4);
      deliver(people, arrive, random(7));
      expect(linesOf(agreed(people))).toEqual(["onetwo"]);
      first!.undo();
      deliver(people, arrive, random(7));
      const restored = agreed(people);
      holds(oracle, restored);
      expect(restored.map((token) => (token.kind === "boundary" ? token.attrs : ""))).toContain(
        '[["level",2],["type","heading"]]',
      );
      first!.retypeAt(4, { type: "codeBlock" });
      deliver(people, arrive, random(7));
      expect(
        agreed(people)
          .filter((token) => token.kind === "boundary")
          .at(-1),
      ).toMatchObject({
        attrs: '[["level",2],["type","codeBlock"]]',
      });
    }
  });

  it("brings an inline item back whole when its delete is undone after someone changed it", () => {
    const base = new Y.Doc();
    base.clientID = 1;
    const text = base.getText(FIELD);
    text.insertEmbed(0, boundary({ type: "paragraph" }), {});
    text.insert(1, "x", {});
    const math = new Y.XmlElement("mathInline");
    math.setAttribute("tex", "E=mc^2");
    text.insertEmbed(2, math, {});
    const { people } = team(count, Y.encodeStateAsUpdate(base));
    base.destroy();
    people[0]!.doc.transact(() => people[0]!.text.delete(2, 1), LOCAL);
    people[1]!.retypeAt(2, { tex: "E=mc^2 + p^2c^2" });
    deliver(people, arrive, random(7));
    people[0]!.undo();
    deliver(people, arrive, random(7));
    expect(agreed(people).at(-1)).toEqual(
      expect.objectContaining({ kind: "atom", attrs: '[["tex","E=mc^2"]]' }),
    );
  });

  it("keeps marks where they were through a split and a join", () => {
    const { oracle, people } = team(count, note("One one", "Two two two"));
    people[0]!.markAt(3, 10, "bold");
    people[1]!.split(1, 4);
    people[1]!.join(1);
    people.at(-1)!.type(0, 5, "X");
    settle(people, oracle);
    const bold = people[0]!
      .tokens()
      .filter((token) => token.kind === "char" && token.marks === "bold")
      .map((token) => (token.kind === "char" ? token.text : ""))
      .join("");
    expect(bold).toBe("e oXneTwo ");
  });
});

function randomRun(seed: number, count: number, arrive: Arrive, rounds: number, gc: boolean) {
  const next = random(seed);
  const pick = (below: number) => Math.floor(next() * below);
  const { oracle, people } = team(
    count,
    note("abcd", "efgh", "ijkl"),
    gc,
    process.env.BODY_SEQUENCE_STEPS === "each" ? "each change" : "grouped",
  );
  const log: string[] = [];
  let letter = 0;
  try {
    for (let round = 0; round < rounds; round++) {
      for (const [who, each] of people.entries())
        for (let changes = 1 + pick(3); changes > 0; changes--) {
          const tokens = each.tokens();
          const boundaries = tokens.flatMap((token, index) =>
            token.kind === "boundary" ? [index] : [],
          );
          const chars = tokens.flatMap((token, index) => (token.kind === "char" ? [index] : []));
          const roll = next();
          const say = (what: string) => log.push(`${String(who)}:${what}`);
          if (next() < 0.4) {
            say("step");
            each.newStep();
          }
          if (roll < 0.25) {
            const first = tokens[0]?.kind === "boundary" ? 1 : 0;
            const at = first + pick(tokens.length - first + 1);
            const text = String.fromCharCode(0x391 + (letter++ % 600));
            say(`type@${String(at)}`);
            each.typeAt(at, text);
          } else if (roll < 0.45) {
            const at = pick(tokens.length + 1);
            say(`split@${String(at)}`);
            each.splitAt(at);
          } else if (roll < 0.65 && boundaries.length > 0) {
            const at = boundaries[pick(boundaries.length)]!;
            say(`join@${String(at)}`);
            each.joinAt(at);
          } else if (roll < 0.7 && chars.length > 0) {
            const at = chars[pick(chars.length)]!;
            let length = 1;
            while (length < 3 && tokens[at + length]?.kind === "char" && next() < 0.5) length++;
            say(`delete@${String(at)}+${String(length)}`);
            each.deleteCharsAt(at, length);
          } else if (roll < 0.75 && boundaries.length > 0) {
            const at = boundaries[pick(boundaries.length)]!;
            say(`retype@${String(at)}`);
            each.retypeAt(at, {
              type: ["paragraph", "heading", "codeBlock"][pick(3)]!,
              level: pick(3),
            });
          } else if (roll < 0.8 && tokens.length > 1) {
            const at = pick(tokens.length - 1);
            const length = 1 + pick(Math.min(6, tokens.length - at));
            say(`mark@${String(at)}+${String(length)}`);
            each.markAt(at, length, next() < 0.5 ? "bold" : "italic");
          } else if (roll < 0.93 && each.canUndo()) {
            say("undo");
            each.undo();
          } else if (each.canRedo()) {
            say("redo");
            each.redo();
          }
        }
      log.push("|");
      deliver(people, arrive, next);
      holds(oracle, agreed(people));
    }
  } catch (error) {
    throw new Error(
      `seed ${String(seed)}: ${log.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const implicit = oracle.implicitFirstLine;
  for (const doc of docs.splice(0)) doc.destroy();
  return { implicit };
}

const RANDOM_SETUPS: [number, Arrive, number][] = [
  [2, "one by one", 1],
  [2, "merged", 1],
  [2, "one by one", 4],
  [2, "after a reconnect", 3],
  [3, "one by one", 3],
  [3, "merged", 3],
  [3, "after a reconnect", 3],
  [4, "one by one", 3],
  [4, "merged", 3],
  [4, "after a reconnect", 3],
];
const SEEDS = Number(process.env.BODY_SEQUENCE_SEEDS ?? 300);
const FIRST = Number(process.env.BODY_SEQUENCE_FIRST ?? 1);

it.each(RANDOM_SETUPS)(
  "random joins, splits, typing, marks and undo by %i people, arriving %s, %i rounds",
  (count, arrive, rounds) => {
    let implicit = 0;
    for (let seed = FIRST; seed <= SEEDS; seed++)
      for (const gc of [true, false])
        implicit += randomRun(seed, count, arrive, rounds, gc).implicit;
    console.log(
      `${String(count)} people, ${arrive}, ${String(rounds)} rounds, ${String(SEEDS)} seeds: text before the first boundary seen ${String(implicit)} times`,
    );
  },
  600_000,
);
