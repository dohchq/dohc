import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  leavesOfSequence,
  recordsOfContainer,
  type SequenceAttrs,
  type SequenceFrame,
} from "./bodySequenceGrammar.js";
import {
  bodyHistory,
  indentItem,
  joinLine,
  liftBlocks,
  outdentItem,
  readBody,
  setContainerAttributes,
  setContainerKind,
  setLineKind,
  splitLine,
  wrapBlocks,
  writeBody,
  type BodyWrites,
} from "./bodySequenceWriter.js";
import { piecesOfSequence, readBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

const schema = getDohcProseMirrorSchema();
const SEQUENCE = BODY_SEQUENCE_FIELD;
const CONTAINERS = BODY_CONTAINERS_FIELD;
const REMOTE = Symbol("remote");
const LOCAL = Symbol("local");
const OUTSIDE_HISTORY = Symbol("outside the history");
const LISTS = ["bulletList", "orderedList", "taskList"];
const ITEMS = ["listItem", "taskItem"];
const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  ["blockquote", "callout", ...LISTS, ...ITEMS].flatMap((type) =>
    Object.entries(schema.nodes[type]!.spec.attrs ?? {}).map(([key, spec]) => [
      key,
      (spec as { default?: unknown }).default ?? null,
    ]),
  ),
);

const DEFAULT_MAP_UNDO = "Yjs's default undo of map changes";
const NO_DELETE_FILTER = "no delete filter";
const TYPE_RECORD_ONLY = "a container made with its type record and no defaults";
const DEFAULT_FIRST = "a missing record's default written first, outside the history";
const OLD_BOUNDARY_ABOVE = "a split at offset 0 that leaves the old boundary with the empty line";
const NO_KIND_DEFAULTS = "a line's kind written without the attributes that hold their default";
const ONE_RECORD_FOR_TWINS = "a setting written to an id that is on two containers";
const KIND_DEFAULTS: SequenceAttrs = { level: 1, language: null };
type Fault =
  | typeof DEFAULT_MAP_UNDO
  | typeof NO_DELETE_FILTER
  | typeof TYPE_RECORD_ONLY
  | typeof DEFAULT_FIRST
  | typeof OLD_BOUNDARY_ABOVE
  | typeof NO_KIND_DEFAULTS
  | typeof ONE_RECORD_FOR_TWINS;

type Id = string;
const idOf = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;
const json = (value: unknown) => JSON.stringify(value);

type Held = { item: Id; value: string };
type Token =
  | { kind: "char"; id: Id; line: Id | null }
  | { kind: "boundary"; id: Id; attrs: Map<string, Held> };
type Shot = { tokens: Token[]; records: Map<string, Held> };

function heldIn(map: Map<string, Y.Item>): Map<string, Held> {
  const held = new Map<string, Held>();
  for (const [key, item] of map)
    if (!item.deleted)
      held.set(key, {
        item: idOf(item.id.client, item.id.clock + item.length - 1),
        value: json(item.content.getContent()[item.length - 1]),
      });
  return held;
}

function shoot(doc: Y.Doc): Shot {
  const tokens: Token[] = [];
  let line: Id | null = null;
  for (let item = doc.getText(SEQUENCE)._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString)
      for (let at = 0; at < content.str.length; at++)
        tokens.push({ kind: "char", id: idOf(item.id.client, item.id.clock + at), line });
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      line = idOf(item.id.client, item.id.clock);
      tokens.push({ kind: "boundary", id: line, attrs: heldIn(content.type._map) });
    }
  }
  return { tokens, records: heldIn(doc.getMap(CONTAINERS)._map) };
}

type Change = { from?: Held; to?: Held };
type Step = {
  insertedChars: Id[];
  deletedChars: Id[];
  insertedBoundaries: Id[];
  deletedBoundaries: Id[];
  moved: Id[];
  slots: Map<string, Change>;
  rounds: Map<string, [number, number]>;
  gone: Map<Id, Map<string, Held>>;
  settings: Set<string>;
};

const step = (): Step => ({
  insertedChars: [],
  deletedChars: [],
  insertedBoundaries: [],
  deletedBoundaries: [],
  moved: [],
  slots: new Map(),
  rounds: new Map(),
  gone: new Map(),
  settings: new Set(),
});

const partsOf = (slot: string) => slot.split(" ") as [string, string, string | undefined];

function effectsOf(before: Shot, after: Shot, round: number): Step {
  const effects = step();
  const changed = (
    from: Map<string, Held>,
    to: Map<string, Held>,
    name: (key: string) => string,
  ) => {
    for (const key of new Set([...from.keys(), ...to.keys()])) {
      if (from.get(key)?.item === to.get(key)?.item) continue;
      effects.slots.set(name(key), { from: from.get(key), to: to.get(key) });
      effects.rounds.set(name(key), [round, round]);
    }
  };
  const was = new Map(before.tokens.map((token) => [token.id, token]));
  const now = new Map(after.tokens.map((token) => [token.id, token]));
  for (const token of before.tokens) {
    const next = now.get(token.id);
    if (token.kind === "char") {
      if (!next) effects.deletedChars.push(token.id);
      else if (next.kind === "char" && next.line !== token.line) effects.moved.push(token.id);
    } else if (!next) {
      effects.deletedBoundaries.push(token.id);
      effects.gone.set(token.id, token.attrs);
    } else if (next.kind === "boundary")
      changed(token.attrs, next.attrs, (key) => `line ${token.id} ${key}`);
  }
  for (const token of after.tokens)
    if (!was.has(token.id))
      (token.kind === "char" ? effects.insertedChars : effects.insertedBoundaries).push(token.id);
  changed(before.records, after.records, (key) => `record ${key}`);
  return effects;
}

function join(top: Step, more: Step) {
  top.insertedChars.push(...more.insertedChars);
  top.deletedChars.push(...more.deletedChars);
  top.insertedBoundaries.push(...more.insertedBoundaries);
  top.deletedBoundaries.push(...more.deletedBoundaries);
  for (const [slot, change] of more.slots) {
    const known = top.slots.get(slot);
    top.slots.set(slot, known ? { from: known.from, to: change.to } : change);
    top.rounds.set(slot, [
      top.rounds.get(slot)?.[0] ?? more.rounds.get(slot)![0],
      more.rounds.get(slot)![1],
    ]);
  }
  for (const [id, attrs] of more.gone) top.gone.set(id, attrs);
  for (const key of more.settings) top.settings.add(key);
}

const tally = () => ({
  runs: 0,
  changes: 0,
  undos: 0,
  redos: 0,
  passedOverWhatItAddedIsGone: 0,
  passedOverItsLinesAreGone: 0,
  changedNothing: 0,
  freshIdsForATwin: 0,
  roundsWithOneIdOnTwo: 0,
  settingsChecked: 0,
  textBeforeFirstBoundary: 0,
  unnamedRecords: 0,
  records: 0,
});
type Tally = ReturnType<typeof tally>;

class Oracle {
  readonly rootOf = new Map<Id, Id>();
  readonly typed = new Set<Id>();
  readonly everDeletedChars = new Set<Id>();
  readonly insertedChars = new Set<Id>();
  readonly deletedChars = new Set<Id>();
  readonly insertedBoundaries = new Set<Id>();
  readonly deletedBoundaries = new Set<Id>();
  readonly snapshots: Id[][] = [];
  readonly writes = new Map<string, { who: number; round: number }[]>();
  readonly asMade = new Map<string, string>();
  readonly count = tally();
  round = 0;
  root(id: Id): Id {
    for (let at = id; ;) {
      const next = this.rootOf.get(at);
      if (next === undefined) return at;
      at = next;
    }
  }
  wrote(slot: string, who: number) {
    const writes = this.writes.get(slot) ?? [];
    writes.push({ who, round: this.round });
    this.writes.set(slot, writes);
  }
  others(slot: string, who: number, from: number, to = Infinity) {
    return (this.writes.get(slot) ?? []).some(
      (write) => write.who !== who && write.round >= from && write.round <= to,
    );
  }
}

function twins(doc: Y.Doc) {
  const held = new Set(readBody(schema, doc).flatMap((line) => line.path));
  return held.size - new Set([...held].map((container) => container.id)).size;
}

const docs: Y.Doc[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
  vi.useRealTimers();
});

type Expected = { chars?: number; boundaries?: number; movable?: Set<Id> };
type Claim = { value: string | undefined; round: number };

function person(baseline: Uint8Array, who: number, oracle: Oracle, gc: boolean, fault?: Fault) {
  const doc = new Y.Doc({ gc });
  docs.push(doc);
  doc.clientID = 10 * (who + 1);
  const sequence = doc.getText(SEQUENCE);
  const records = doc.getMap<unknown>(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  const broken = { trackedOrigins: new Set([LOCAL]), captureTimeout: 60_000 };
  const keepRecords = (item: Y.Item) => item.parent !== records;
  const history =
    fault === DEFAULT_MAP_UNDO
      ? new Y.UndoManager([sequence, records], { ...broken, deleteFilter: keepRecords })
      : fault === NO_DELETE_FILTER
        ? new Y.UndoManager([sequence, records], { ...broken, ignoreRemoteMapChanges: true })
        : bodyHistory(doc, LOCAL, 60_000);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  const undoMirror: Step[] = [];
  let redoMirror: Step[] = [];
  const claims = new Map<string, Claim>();
  let made = 0;
  const freshId = () => `${"wxyz"[who]!}${(made++).toString(36)}`;
  const lines = () => readBody(schema, doc);

  const seen = (before: Shot): [Step, Shot] => {
    const after = shoot(doc);
    const effects = effectsOf(before, after, oracle.round);
    for (const key of before.records.keys())
      if (!after.records.has(key)) throw new Error(`[5 records] the record ${key} was deleted`);
    for (const id of effects.deletedChars) oracle.everDeletedChars.add(oracle.root(id));
    for (const id of effects.insertedChars) oracle.insertedChars.add(id);
    for (const id of effects.deletedChars) oracle.deletedChars.add(id);
    for (const id of effects.insertedBoundaries) oracle.insertedBoundaries.add(id);
    for (const id of effects.deletedBoundaries) oracle.deletedBoundaries.add(id);
    for (const slot of effects.slots.keys()) oracle.wrote(slot, who);
    oracle.snapshots.push(after.tokens.map((token) => token.id));
    if (after.tokens[0]?.kind === "char") oracle.count.textBeforeFirstBoundary++;
    return [effects, after];
  };

  const local = (act: () => void, expected: Expected, settings: string[] = []) => {
    const depth = history.undoStack.length;
    const twinsBefore = twins(doc);
    const before = shoot(doc);
    doc.transact(act, LOCAL);
    const [effects] = seen(before);
    const chars = effects.insertedChars.length - effects.deletedChars.length;
    const boundaries = effects.insertedBoundaries.length - effects.deletedBoundaries.length;
    if (chars !== (expected.chars ?? 0) || boundaries !== (expected.boundaries ?? 0))
      throw new Error(
        `[writer] expected ${json(expected)} and saw ${String(chars)} letters and ${String(boundaries)} boundaries`,
      );
    if ((expected.chars ?? 0) >= 0 && effects.deletedChars.length > 0)
      throw new Error("[writer] a change that deletes no letters deleted letters");
    if ((expected.chars ?? 0) <= 0 && effects.insertedChars.length > 0)
      throw new Error("[writer] a change that types no letters added letters");
    if (!effects.moved.every((id) => expected.movable?.has(id)))
      throw new Error(
        "[writer] a change took letters to another line that section 4 leaves in theirs",
      );
    if (twins(doc) > twinsBefore)
      throw new Error("[writer] a change left one id on two containers");
    for (const id of effects.insertedChars) oracle.typed.add(id);
    for (const [slot, change] of effects.slots)
      claims.set(slot, { value: change.to?.value, round: oracle.round });
    for (const key of settings) effects.settings.add(key);
    const top = undoMirror.at(-1);
    if (history.undoStack.length > depth) undoMirror.push(effects);
    else if (top && history.undoStack.length === depth) join(top, effects);
    if (history.redoStack.length === 0) redoMirror = [];
    oracle.count.changes++;
    return true;
  };

  const withoutFreshIds = (plan: BodyWrites) => {
    const twin = new Map<string, string>();
    for (const [boundary, attrs] of plan.attributes) {
      const was = boundary.getAttribute("path") as unknown as string[];
      (attrs.path as string[]).forEach((id, depth) => twin.set(id, was[depth]!));
    }
    for (const [key, value] of [...plan.records]) {
      const [id, attribute] = key.split(".") as [string, string | undefined];
      const shared = twin.get(id);
      if (shared === undefined || shared === id) continue;
      plan.records.delete(key);
      const sharedKey = attribute === undefined ? shared : `${shared}.${attribute}`;
      if (json(records.get(sharedKey)) !== json(value)) plan.records.set(sharedKey, value);
    }
    plan.attributes.clear();
  };

  const write = (plan: BodyWrites | null, expected: Expected = {}, setting = false) => {
    if (!plan) return false;
    if (setting && fault === ONE_RECORD_FOR_TWINS) withoutFreshIds(plan);
    const settings: string[] = [];
    let makes = false;
    for (const [key, value] of plan.records)
      if (!records.has(key.split(".")[0]!)) {
        oracle.asMade.set(key, json(value));
        makes = true;
      } else {
        oracle.asMade.delete(key);
        settings.push(key);
      }
    if (setting && makes) oracle.count.freshIdsForATwin++;
    if (fault === TYPE_RECORD_ONLY || fault === DEFAULT_FIRST)
      for (const [key, value] of plan.records) {
        const attribute = key.split(".")[1];
        const isDefault = attribute !== undefined && json(value) === json(DEFAULTS[attribute]);
        if (isDefault && !records.has(key)) plan.records.delete(key);
      }
    const missing = [...plan.records.keys()].filter(
      (key) => key.includes(".") && !records.has(key),
    );
    if (fault === DEFAULT_FIRST && missing.length > 0) {
      const before = shoot(doc);
      doc.transact(() => {
        for (const key of missing) records.set(key, DEFAULTS[key.split(".")[1]!]);
      }, OUTSIDE_HISTORY);
      seen(before);
    }
    return local(() => writeBody(doc, plan), expected, settings);
  };

  const shown = () =>
    leavesOfSequence(schema, piecesOfSequence(sequence), records).map((leaf) =>
      leaf.path.map((frame) => json([frame.type, frame.attrs])),
    );
  const setting = (at: number, depth: number, itemsToo: boolean, plan: BodyWrites | null) => {
    const body = lines();
    const before = shown();
    if (!write(plan, {}, true)) return false;
    shown().forEach((path, index) =>
      path.forEach((frame, level) => {
        const itsOwn = body[index]!.path[depth] === body[at]!.path[depth];
        const onIt = level === depth || (itemsToo && level === depth + 1);
        if (frame !== before[index]![level] && !(itsOwn && onIt))
          throw new Error("[writer] a setting changed on a container it was not made on");
      }),
    );
    return true;
  };

  const letters = (at: number, from = 0) => {
    const groups: Id[][] = [];
    for (const token of shoot(doc).tokens)
      if (token.kind === "boundary" || groups.length === 0)
        groups.push(token.kind === "char" ? [token.id] : []);
      else groups.at(-1)!.push(token.id);
    return new Set(groups[at]!.slice(from));
  };

  const alive = (id: Id) => {
    let [client, clock] = id.split(":").map(Number) as [number, number];
    for (;;) {
      const struct = Y.getItem(doc.store, Y.createID(client, clock));
      if (!(struct instanceof Y.Item)) return false;
      if (struct.redone === null) return !struct.deleted;
      clock = struct.redone.clock + clock - struct.id.clock;
      client = struct.redone.client;
    }
  };

  const madeItsContainer = (entry: Step, key: string) => {
    const made = entry.slots.get(`record ${key.split(".")[0]!}`);
    return made !== undefined && made.from === undefined;
  };

  const nothingLeftToUndo = (entry: Step) => {
    const added = new Set([...entry.insertedChars, ...entry.insertedBoundaries]);
    return (
      [...entry.settings].every((key) => madeItsContainer(entry, key)) &&
      [...entry.deletedChars, ...entry.deletedBoundaries].every((id) => added.has(id)) &&
      ![...added].some(alive) &&
      ![...entry.slots.keys()].some((slot) => slot.startsWith("line ") && alive(partsOf(slot)[1]))
    );
  };

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

  const noVisibleCharBetween = (left: Id, right: Id) => {
    let inside = false;
    for (let item = sequence._start; item !== null; item = item.right) {
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

  const back = (which: "undo" | "redo") => {
    const from = which === "undo" ? undoMirror : redoMirror;
    const to = which === "undo" ? redoMirror : undoMirror;
    const stack = () => (which === "undo" ? history.undoStack : history.redoStack);
    const other = () => (which === "undo" ? history.redoStack : history.undoStack);
    const depth = stack().length;
    const otherDepth = other().length;
    if (from.length !== depth) throw new Error("the model lost count of the history");
    let nothingLeft = 0;
    while (nothingLeft < depth && nothingLeftToUndo(from[depth - 1 - nothingLeft]!)) nothingLeft++;
    const before = shoot(doc);
    const did = (which === "undo" ? history.undo() : history.redo()) !== null;
    const popped = from.splice(stack().length, depth - stack().length);
    const [effects, after] = seen(before);
    learnCopies();
    const passedOver = popped.length - (did ? 1 : 0);
    if (passedOver > nothingLeft)
      throw new Error(`[3 undo] ${which} passed over a step that still had something to ${which}`);
    for (const entry of popped.slice(did ? 1 : 0))
      oracle.count[
        entry.insertedChars.length + entry.insertedBoundaries.length > 0
          ? "passedOverWhatItAddedIsGone"
          : "passedOverItsLinesAreGone"
      ]++;
    oracle.count[which === "undo" ? "undos" : "redos"]++;
    const done = did ? popped[0]! : step();
    const changed = [
      effects.insertedChars,
      effects.deletedChars,
      effects.insertedBoundaries,
      effects.deletedBoundaries,
      [...effects.slots],
    ];
    if (did && changed.every((none) => none.length === 0)) oracle.count.changedNothing++;

    const roots = (ids: Id[]) => ids.map((id) => oracle.root(id));
    const within = (ids: Id[], allowed: Id[]) => {
      const set = new Set(roots(allowed));
      return roots(ids).every((id) => set.has(id));
    };
    const once = (ids: Id[], deleted: Id[]) => {
      const left = new Map<Id, number>();
      for (const id of roots(deleted)) left.set(id, (left.get(id) ?? 0) + 1);
      return roots(ids).every((id) => {
        left.set(id, (left.get(id) ?? 0) - 1);
        return left.get(id)! >= 0;
      });
    };
    if (!within(effects.deletedChars, done.insertedChars))
      throw new Error(`[3 undo] ${which} deleted letters that its step did not type`);
    if (!once(effects.insertedChars, done.deletedChars))
      throw new Error(`[3 undo] ${which} added letters that its step did not delete`);
    if (!within(effects.deletedBoundaries, done.insertedBoundaries))
      throw new Error(`[3 undo] ${which} deleted a boundary that its step did not add`);
    if (!once(effects.insertedBoundaries, done.deletedBoundaries))
      throw new Error(`[3 undo] ${which} added a boundary that its step did not delete`);

    const rooted = (slot: string) => {
      const [kind, name, key] = partsOf(slot);
      return kind === "line" ? `line ${oracle.root(name)} ${key!}` : slot;
    };
    const byRoot = new Map([...done.slots.keys()].map((slot) => [rooted(slot), slot]));
    for (const [slot, change] of effects.slots) {
      const mine = done.slots.has(slot) ? slot : byRoot.get(rooted(slot));
      if (mine === undefined)
        throw new Error(`[3 undo] ${which} changed ${slot}, which its step did not change`);
      const earlier = done.slots.get(mine)!.from?.value;
      const [first, last] = done.rounds.get(mine)!;
      if (change.to?.value !== earlier && !oracle.others(mine, who, first, last))
        throw new Error(
          `[4 settings] ${which} left ${slot} as ${String(change.to?.value)}, and it was ${String(earlier)} before the step`,
        );
      claims.set(slot, { value: change.to?.value, round: oracle.round });
    }

    for (const key of done.settings) {
      const change = done.slots.get(`record ${key}`);
      const [first, last] = done.rounds.get(`record ${key}`) ?? [0, Infinity];
      if (!change || oracle.others(`record ${key}`, who, first, last)) continue;
      if (madeItsContainer(done, key)) {
        if (effects.slots.has(`record ${key}`))
          throw new Error(`[4 settings] ${which} changed ${key}, which its own step made`);
        continue;
      }
      const unset = json(DEFAULTS[key.split(".")[1] ?? ""]);
      const earlier = change.from?.value ?? unset;
      const reads = after.records.get(key)?.value ?? unset;
      if (reads !== earlier)
        throw new Error(
          `[4 settings] ${which} left ${key} reading ${reads}, and it read ${earlier} before the step`,
        );
    }

    for (const copy of effects.insertedBoundaries) {
      const source = sourceOf(copy);
      if (source === null || !noVisibleCharBetween(source, copy))
        throw new Error(`[3 undo] ${which} put a boundary back away from where it was`);
      const lastSeen = new Map(
        [...(done.gone.get(source) ?? [])].map(([key, held]) => [key, held.value]),
      );
      const unsure = new Set<string>();
      for (const [slot, change] of done.slots) {
        const [kind, name, key] = partsOf(slot);
        if (kind !== "line" || name !== source) continue;
        if (oracle.others(slot, who, done.rounds.get(slot)![0])) unsure.add(key!);
        else if (change.from) lastSeen.set(key!, change.from.value);
        else lastSeen.delete(key!);
      }
      const restored = after.tokens.find((token) => token.id === copy);
      const now = restored?.kind === "boundary" ? restored.attrs : new Map<string, Held>();
      for (const key of new Set([...lastSeen.keys(), ...now.keys()]))
        if (!unsure.has(key) && lastSeen.get(key) !== now.get(key)?.value)
          throw new Error(
            `[3 undo] ${which} put a boundary back with ${key} ${String(now.get(key)?.value)}, and the person last saw ${String(lastSeen.get(key))}`,
          );
    }

    for (const key of done.settings)
      if (effects.slots.has(`record ${key}`)) effects.settings.add(key);
    if (other().length > otherDepth) to.push(effects);
    return did;
  };

  return {
    who,
    doc,
    records,
    sent,
    claims,
    lines,
    shot: () => shoot(doc),
    receive(update: Uint8Array) {
      Y.applyUpdate(doc, update, REMOTE);
    },
    type(at: number, offset: number, text: string) {
      const index = (lines()[at]?.start ?? 0) + offset;
      return local(() => sequence.insert(index, text), { chars: text.length });
    },
    erase(at: number, offset: number, length: number) {
      const line = lines()[at];
      const count = Math.min(length, (line?.length ?? 0) - offset);
      if (!line || count <= 0) return false;
      return local(() => sequence.delete(line.start + offset, count), { chars: -count });
    },
    split(at: number, offset: number) {
      const line = lines()[at];
      const plan = splitLine(schema, doc, at, offset, freshId);
      if (!line || !plan?.added) return false;
      const above = offset === 0 && line.length > 0;
      if (above && fault === OLD_BOUNDARY_ABOVE) plan.added.index++;
      return write(plan, { boundaries: 1, movable: above ? new Set() : letters(at, offset) });
    },
    join(at: number) {
      const lower = lines()[at];
      const plan = joinLine(schema, doc, at);
      if (!lower || !plan) return false;
      const lowerGoes = plan.removed === lower.start - 1;
      return write(plan, { boundaries: -1, movable: lowerGoes ? letters(at) : new Set() });
    },
    kind(at: number, kind: SequenceAttrs) {
      const stored = lines()[at]?.attrs ?? {};
      const written = Object.entries(kind).filter(
        ([key, value]) => key in stored || json(value) !== json(KIND_DEFAULTS[key]),
      );
      const given = fault === NO_KIND_DEFAULTS ? Object.fromEntries(written) : kind;
      return write(setLineKind(schema, doc, at, given));
    },
    wrap: (at: number, depth: number, count: number, type: string, attrs: SequenceAttrs) =>
      write(wrapBlocks(schema, doc, at, depth, count, type, attrs, freshId)),
    lift: (at: number, depth: number, count: number) =>
      write(liftBlocks(schema, doc, at, depth, count, freshId)),
    indent: (at: number, depth: number) => write(indentItem(schema, doc, at, depth, freshId)),
    outdent: (at: number, depth: number) => write(outdentItem(schema, doc, at, depth, freshId)),
    containerKind: (at: number, depth: number, type: string) =>
      setting(at, depth, true, setContainerKind(schema, doc, at, depth, type, freshId)),
    containerAttrs: (at: number, depth: number, attrs: SequenceAttrs) =>
      setting(at, depth, false, setContainerAttributes(schema, doc, at, depth, attrs, freshId)),
    newStep: () => history.stopCapturing(),
    undo: () => back("undo"),
    redo: () => back("redo"),
    canUndo: () => history.undoStack.length > 0,
    canRedo: () => history.redoStack.length > 0,
  };
}
type Person = ReturnType<typeof person>;

type Written = [text: string, kind: SequenceAttrs, path: string[]];
const PARAGRAPH = { type: "paragraph" };

function note(frames: SequenceFrame[], lines: Written[]): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const sequence = doc.getText(SEQUENCE);
  for (const frame of frames)
    for (const [key, value] of recordsOfContainer(schema, frame))
      doc.getMap(CONTAINERS).set(key, value);
  for (const [text, kind, path] of lines) {
    const boundary = new Y.XmlElement(BLOCK_ELEMENT);
    for (const [key, value] of Object.entries({ ...kind, path }))
      boundary.setAttribute(key, value as unknown as string);
    sequence.insertEmbed(sequence.length, boundary, {});
    sequence.insert(sequence.length, text, {});
  }
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

const plainNote = () =>
  note(
    [],
    ["abcd", "efgh", "ijkl"].map((text): Written => [text, PARAGRAPH, []]),
  );

const nestedNote = () =>
  note(
    [
      { id: "Q", type: "blockquote", attrs: {} },
      { id: "T", type: "taskList", attrs: {} },
      { id: "T1", type: "taskItem", attrs: {} },
      { id: "N", type: "orderedList", attrs: { start: 3 } },
      { id: "N1", type: "listItem", attrs: {} },
      { id: "T2", type: "taskItem", attrs: { checked: true } },
      { id: "C", type: "callout", attrs: { calloutType: "tip", title: "Read me", fold: "+" } },
    ],
    [
      ["ab", PARAGRAPH, []],
      ["cd", { type: "heading", level: 2 }, ["Q"]],
      ["ef", PARAGRAPH, ["Q"]],
      ["gh", PARAGRAPH, ["T", "T1"]],
      ["ij", PARAGRAPH, ["T", "T1", "N", "N1"]],
      ["kl", PARAGRAPH, ["T", "T2"]],
      ["mn", PARAGRAPH, ["C"]],
      ["op", PARAGRAPH, []],
    ],
  );

function team(count: number, baseline: Uint8Array, gc = true, fault?: Fault) {
  const oracle = new Oracle();
  const base = new Y.Doc();
  Y.applyUpdate(base, baseline);
  for (const token of shoot(base).tokens)
    if (token.kind === "char") {
      oracle.typed.add(token.id);
      oracle.insertedChars.add(token.id);
    } else oracle.insertedBoundaries.add(token.id);
  base.destroy();
  const people = Array.from({ length: count }, (_, who) =>
    person(baseline, who, oracle, gc, fault),
  );
  return { oracle, people };
}

type Arrive = "one by one" | "merged" | "after a reconnect";

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

const sorted = (held: Map<string, Held>) => [...held].sort(([a], [b]) => (a < b ? -1 : 1));

function view(doc: Y.Doc): string {
  const shot = shoot(doc);
  const read = readBodySequence(schema, doc);
  try {
    read.check();
  } catch (error) {
    throw new Error(`[1 same note] the note is not a valid document: ${String(error)}`);
  }
  return json({
    tokens: shot.tokens.map((token) =>
      token.kind === "char" ? [token.id, token.line] : [token.id, sorted(token.attrs)],
    ),
    records: sorted(shot.records),
    note: read.toJSON(),
  });
}

function agreed(people: Person[]): Shot {
  const first = view(people[0]!.doc);
  for (const each of people) {
    if (view(each.doc) !== first) throw new Error("[1 same note] two people read different notes");
    const reopened = new Y.Doc();
    reopened.getText(SEQUENCE);
    reopened.getMap(CONTAINERS);
    Y.applyUpdate(reopened, Y.encodeStateAsUpdate(each.doc));
    const again = view(reopened);
    reopened.destroy();
    if (again !== first)
      throw new Error("[1 same note] a note reopened from its full state reads differently");
  }
  return people[0]!.shot();
}

function lettersHold(oracle: Oracle, final: Token[]) {
  const letters = new Set(final.filter((token) => token.kind === "char").map((token) => token.id));
  for (const id of oracle.insertedChars)
    if (!oracle.deletedChars.has(id) && !letters.has(id))
      throw new Error("[2 letters] a letter no change deleted is gone");
  for (const id of letters)
    if (oracle.deletedChars.has(id) || !oracle.insertedChars.has(id))
      throw new Error("[2 letters] a letter stands that no change left standing");
  const times = new Map<Id, number>();
  for (const id of letters) times.set(oracle.root(id), (times.get(oracle.root(id)) ?? 0) + 1);
  for (const id of oracle.typed)
    if (!oracle.everDeletedChars.has(oracle.root(id)) && times.get(id) !== 1)
      throw new Error(
        `[2 letters] a letter nobody deleted stands ${String(times.get(id) ?? 0)} times in the note`,
      );
  const boundaries = new Set(
    final.filter((token) => token.kind === "boundary").map((token) => token.id),
  );
  for (const id of boundaries)
    if (!oracle.insertedBoundaries.has(id) || oracle.deletedBoundaries.has(id))
      throw new Error("[2 letters] a boundary stands that no change left standing");
  for (const id of oracle.insertedBoundaries)
    if (!oracle.deletedBoundaries.has(id) && !boundaries.has(id))
      throw new Error("[2 letters] a boundary nobody deleted is gone");
  const place = new Map(final.map((token, index) => [token.id, index]));
  for (const snapshot of oracle.snapshots) {
    let last = -1;
    for (const id of snapshot) {
      const at = place.get(id);
      if (at === undefined) continue;
      if (at < last) throw new Error("[2 letters] two things changed order");
      last = at;
    }
  }
}

function settingsHold(people: Person[], oracle: Oracle) {
  const doc = people[0]!.doc;
  const shot = shoot(doc);
  const records = doc.getMap(CONTAINERS);
  for (const [key, value] of oracle.asMade) {
    const attribute = key.split(".")[1];
    const reads = json(
      records.has(key) || attribute === undefined ? records.get(key) : DEFAULTS[attribute],
    );
    if (reads !== value)
      throw new Error(
        `[4 settings] ${key} was made as ${value} and reads ${reads}, and no one changed it`,
      );
  }
  const boundaries = new Map(
    shot.tokens.flatMap((token) =>
      token.kind === "boundary" ? [[token.id, token.attrs] as const] : [],
    ),
  );
  const frames = leavesOfSequence(schema, piecesOfSequence(doc.getText(SEQUENCE)), records).flatMap(
    (leaf) => leaf.path.map((frame, depth) => ({ frame, under: leaf.path[depth - 1]?.type })),
  );
  for (const each of people)
    for (const [slot, claim] of each.claims) {
      const [kind, name, key] = partsOf(slot);
      const gone = kind === "line" && !boundaries.has(name);
      if (gone || oracle.others(slot, each.who, claim.round)) {
        each.claims.delete(slot);
        continue;
      }
      const held = kind === "line" ? boundaries.get(name)!.get(key!) : shot.records.get(name);
      oracle.count.settingsChecked++;
      if (held?.value !== claim.value)
        throw new Error(
          `[4 settings] ${slot} reads ${String(held?.value)}; person ${String(each.who)} left it as ${String(claim.value)} and no one else changed it since`,
        );
      if (kind !== "record" || claim.value === undefined) continue;
      const [id, attribute] = name.split(".");
      for (const { frame, under } of frames) {
        if (frame.id !== id) continue;
        const shows =
          attribute === undefined
            ? LISTS.includes(under ?? "") || json(frame.type) === claim.value
            : !(attribute in (schema.nodes[frame.type]!.spec.attrs ?? {})) ||
              json(frame.attrs[attribute]) === claim.value;
        if (!shows)
          throw new Error(`[4 settings] the note does not show ${name} as ${claim.value}`);
      }
    }
}

function recordsKept(doc: Y.Doc) {
  doc.getMap(CONTAINERS)._map.forEach((item, key) => {
    if (item.deleted) throw new Error(`[5 records] the record ${key} is deleted`);
  });
}

function unnamedRecords(doc: Y.Doc) {
  const shot = shoot(doc);
  const named = new Set(
    shot.tokens.flatMap((token) =>
      token.kind === "boundary"
        ? (JSON.parse(token.attrs.get("path")?.value ?? "[]") as string[])
        : [],
    ),
  );
  const unnamed = [...shot.records].filter(([key]) => !named.has(key.split(".")[0]!));
  const alone = new Y.Doc();
  alone.transact(() => {
    for (const [key, held] of unnamed) alone.getMap(CONTAINERS).set(key, JSON.parse(held.value));
  });
  const unnamedBytes = Y.encodeStateAsUpdate(alone).length;
  alone.destroy();
  return { records: shot.records.size, unnamed: unnamed.length, unnamedBytes };
}

function readsAsWritten(doc: Y.Doc) {
  const records = doc.getMap(CONTAINERS);
  const lines = readBody(schema, doc);
  for (const line of lines) {
    if (!line.boundary) continue;
    if (json(line.attrs.path) !== json(line.path.map((container) => container.id)))
      throw new Error("[writer] a path does not read as it was written");
    if (typeof line.attrs.type !== "string") throw new Error("[writer] a boundary has no type");
    for (const { id, type } of line.path)
      for (const key of recordsOfContainer(schema, { id, type, attrs: {} }).keys())
        if (!records.has(key)) throw new Error(`[writer] the container ${id} has no ${key}`);
  }
  return twins(doc);
}

function settled(people: Person[], oracle: Oracle, faithful: boolean) {
  const final = agreed(people);
  lettersHold(oracle, final.tokens);
  settingsHold(people, oracle);
  for (const each of people) recordsKept(each.doc);
  if (faithful && readsAsWritten(people[0]!.doc) > 0) oracle.count.roundsWithOneIdOnTwo++;
  oracle.round++;
}

const CALLOUT_KINDS = ["note", "tip", "warning"];
const TITLES = ["", "Read me", "Danger"];
const FOLDS = ["", "+", "-"];

function change(each: Person, next: () => number, letter: () => string, log: string[], heavy = 1) {
  const pick = (below: number) => Math.floor(next() * below);
  const tried = (what: unknown[], run: () => boolean) => {
    log.push(`${String(each.who)}:${what.join(" ")}`);
    if (run()) return true;
    log.pop();
    return false;
  };
  const lines = each.lines();
  const at = pick(lines.length);
  const line = lines[at] ?? { length: 0, path: [] };
  const depth = pick(line.path.length + 1);
  const spot = (...types: string[]) => {
    const found: { at: number; depth: number; id: string; type: string }[] = [];
    const seen = new Set<unknown>();
    lines.forEach((held, index) =>
      held.path.forEach((container, level) => {
        if (seen.has(container) || !types.includes(container.type)) return;
        seen.add(container);
        found.push({ at: index, depth: level, id: container.id, type: container.type });
      }),
    );
    return found[pick(found.length)];
  };
  const typing = () => {
    const offset = pick(line.length + 1);
    return tried(["type", at, offset], () => each.type(at, offset, letter()));
  };
  const options: [number, () => boolean][] = [
    [14, typing],
    [
      4,
      () => {
        const offset = pick(line.length + 1);
        const length = 1 + pick(2);
        return tried(["erase", at, offset, length], () => each.erase(at, offset, length));
      },
    ],
    [
      11,
      () => {
        const offset = [0, line.length, pick(line.length + 1)][pick(3)]!;
        return tried(["split", at, offset], () => each.split(at, offset));
      },
    ],
    [8, () => tried(["join", at], () => each.join(at))],
    [
      11 * heavy,
      () => {
        const count = 1 + pick(3);
        const [type, attrs] = (
          [
            ["blockquote", {}],
            [
              "callout",
              { calloutType: CALLOUT_KINDS[pick(3)], title: TITLES[pick(3)], fold: FOLDS[pick(3)] },
            ],
            ["bulletList", {}],
            ["orderedList", { start: 1 + pick(5) }],
            ["taskList", {}],
          ] as [string, SequenceAttrs][]
        )[pick(5)]!;
        return tried(["wrap", at, depth, count, type, json(attrs)], () =>
          each.wrap(at, depth, count, type, attrs),
        );
      },
    ],
    [
      8 * heavy,
      () => {
        const from = 1 + pick(line.path.length);
        const count = 1 + pick(2);
        return tried(["lift", at, from, count], () => each.lift(at, from, count));
      },
    ],
    [
      6,
      () => {
        const item = spot(...ITEMS);
        return (
          item !== undefined &&
          tried(["indent", item.at, item.depth], () => each.indent(item.at, item.depth))
        );
      },
    ],
    [
      6,
      () => {
        const item = spot(...ITEMS);
        return (
          item !== undefined &&
          tried(["outdent", item.at, item.depth], () => each.outdent(item.at, item.depth))
        );
      },
    ],
    [
      6,
      () => {
        const list = spot(...LISTS);
        if (!list) return false;
        const type = LISTS.filter((kind) => kind !== list.type)[pick(2)]!;
        return tried(["list", list.at, list.depth, type], () =>
          each.containerKind(list.at, list.depth, type),
        );
      },
    ],
    [
      3,
      () => {
        const box = spot("blockquote", "callout");
        if (!box) return false;
        const type = box.type === "callout" ? "blockquote" : "callout";
        return tried(["box", box.at, box.depth, type], () =>
          each.containerKind(box.at, box.depth, type),
        );
      },
    ],
    [
      7,
      () => {
        const item = spot("taskItem");
        if (!item) return false;
        const checked = each.records.get(`${item.id}.checked`) !== true;
        return tried(["tick", item.at, item.depth, checked], () =>
          each.containerAttrs(item.at, item.depth, { checked }),
        );
      },
    ],
    [
      6,
      () => {
        const callout = spot("callout");
        if (!callout) return false;
        const attrs = [
          { title: TITLES[pick(3)] },
          { calloutType: CALLOUT_KINDS[pick(3)] },
          { fold: FOLDS[pick(3)] },
        ][pick(3)]!;
        return tried(["callout", callout.at, callout.depth, json(attrs)], () =>
          each.containerAttrs(callout.at, callout.depth, attrs),
        );
      },
    ],
    [
      3,
      () => {
        const list = spot("orderedList");
        if (!list) return false;
        const start = 1 + pick(9);
        return tried(["start", list.at, list.depth, start], () =>
          each.containerAttrs(list.at, list.depth, { start }),
        );
      },
    ],
    [
      5,
      () => {
        const kind = [
          PARAGRAPH,
          { type: "heading", level: 1 + pick(3) },
          { type: "codeBlock", language: null },
        ][pick(3)]!;
        return tried(["kind", at, json(kind)], () => each.kind(at, kind));
      },
    ],
  ];
  let roll = next() * options.reduce((sum, [weight]) => sum + weight, 0);
  const chosen = options.find(([weight]) => (roll -= weight) < 0) ?? options[0]!;
  if (!chosen[1]()) typing();
}

function act(each: Person, next: () => number, letter: () => string, log: string[], heavy = 1) {
  if (next() < 0.4) {
    log.push(`${String(each.who)}:step`);
    each.newStep();
  }
  const roll = next();
  if (roll < 0.16 && each.canUndo()) {
    log.push(`${String(each.who)}:undo`);
    each.undo();
  } else if (roll < 0.23 && each.canRedo()) {
    log.push(`${String(each.who)}:redo`);
    each.redo();
  } else change(each, next, letter, log, heavy);
}

const lettersFrom = () => {
  let typed = 0;
  return () => String.fromCharCode(0x391 + (typed++ % 600));
};

type Run = {
  seed: number;
  count: number;
  arrive: Arrive;
  rounds: number;
  busiest: number;
  gc: boolean;
  fault?: Fault;
};

function randomRun({ seed, count, arrive, rounds, busiest, gc, fault }: Run): Tally {
  const next = random(seed);
  const { oracle, people } = team(count, seed % 3 === 0 ? plainNote() : nestedNote(), gc, fault);
  const log: string[] = [];
  const letter = lettersFrom();
  try {
    for (let round = 0; round < rounds; round++) {
      for (const each of people)
        for (let changes = 1 + Math.floor(next() * busiest); changes > 0; changes--)
          act(each, next, letter, log);
      log.push("|");
      deliver(people, arrive, next);
      settled(people, oracle, fault === undefined);
    }
  } catch (error) {
    throw new Error(
      `seed ${String(seed)}, gc ${String(gc)}: ${log.join(" ")}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const { records, unnamed } = unnamedRecords(people[0]!.doc);
  for (const doc of docs.splice(0)) doc.destroy();
  return { ...oracle.count, runs: 1, records, unnamedRecords: unnamed };
}

function add(total: Tally, more: Tally) {
  for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += more[key];
}

const SEEDS = Number(process.env.BODY_CONTAINERS_SEEDS ?? 60);
const FIRST = Number(process.env.BODY_CONTAINERS_FIRST ?? 1);
const ROUNDS = Number(process.env.BODY_CONTAINERS_ROUNDS ?? 0);
const BUSIEST = Number(process.env.BODY_CONTAINERS_BUSIEST ?? 0);
const SETUPS = (
  [
    [2, "one by one", 6, 3],
    [2, "merged", 6, 3],
    [2, "after a reconnect", 6, 3],
    [3, "one by one", 4, 3],
    [3, "merged", 4, 6],
    [3, "after a reconnect", 4, 3],
    [4, "one by one", 3, 3],
    [4, "merged", 3, 3],
    [4, "after a reconnect", 3, 6],
  ] as [number, Arrive, number, number][]
).map(
  ([count, arrive, rounds, busiest]) =>
    [count, arrive, ROUNDS || rounds, BUSIEST || busiest] as const,
);

it.each(SETUPS)(
  "random changes to lines and containers by %i people, arriving %s, %i rounds of up to %i changes each",
  (count, arrive, rounds, busiest) => {
    const total = tally();
    for (let seed = FIRST; seed < FIRST + SEEDS; seed++)
      for (const gc of [true, false])
        add(total, randomRun({ seed, count, arrive, rounds, busiest, gc }));
    console.log(
      `${String(count)} people, ${arrive}, ${String(rounds)} rounds of up to ${String(busiest)}: ${json(total)}`,
    );
    expect(total.runs).toBe(2 * SEEDS);
  },
  600_000,
);

const BREAKAGE_SEEDS = Number(process.env.BODY_CONTAINERS_BREAKAGE_SEEDS ?? 15);
const BREAKAGES: [Fault, string][] = [
  [DEFAULT_MAP_UNDO, "[3 undo]"],
  [NO_DELETE_FILTER, "[5 records]"],
  [TYPE_RECORD_ONLY, "[3 undo]"],
  [DEFAULT_FIRST, "[4 settings]"],
  [OLD_BOUNDARY_ABOVE, "[writer]"],
  [ONE_RECORD_FOR_TWINS, "[writer]"],
];

it.each(BREAKAGES)(
  "fails when broken on purpose with %s, at check %s",
  (fault, check) => {
    const fired = new Map<string, number>();
    for (let seed = 1; seed <= BREAKAGE_SEEDS; seed++)
      for (const [count, arrive, rounds, busiest] of SETUPS) {
        try {
          randomRun({ seed, count, arrive, rounds, busiest, gc: seed % 2 === 0, fault });
        } catch (error) {
          const said = /\n(\[[^\]]+\]) ?(.*)/.exec(String(error)) ?? [];
          const which = process.env.BODY_CONTAINERS_BREAKAGE_DETAIL
            ? `${String(said[1])} ${String(said[2]).replace(/\d+:\d+|\b[wxyz][0-9a-z]+\b/g, "_")}`
            : String(said[1]);
          fired.set(which, (fired.get(which) ?? 0) + 1);
        }
        for (const doc of docs.splice(0)) doc.destroy();
      }
    console.log(
      `${fault}, ${String(BREAKAGE_SEEDS * SETUPS.length)} runs:\n${[...fired].map(([which, runs]) => `  ${String(runs)} ${which}`).join("\n")}`,
    );
    expect([...fired.keys()].some((which) => which.startsWith(check))).toBe(true);
  },
  600_000,
);

const LONG_RUN = Number(process.env.BODY_CONTAINERS_LONG_RUN ?? 2000);

it("counts the records no path names while one person wraps, lifts and undoes", () => {
  const next = random(11);
  const { oracle, people } = team(1, plainNote());
  const only = people[0]!;
  const log: string[] = [];
  const letter = lettersFrom();
  const growth: string[] = [];
  for (let changes = 1; changes <= LONG_RUN; changes++) {
    act(only, next, letter, log, 4);
    if (changes % (LONG_RUN / 4) !== 0) continue;
    settled(people, oracle, true);
    const lines = only.lines();
    const kept = open(Y.encodeStateAsUpdate(only.doc), 99);
    growth.push(
      json({
        changes,
        lines: lines.length,
        deepest: Math.max(...lines.map((line) => line.path.length)),
        ...unnamedRecords(only.doc),
        bytesWithOwnHistory: Y.encodeStateAsUpdate(only.doc).length,
        bytesForSomeoneElse: Y.encodeStateAsUpdate(kept).length,
      }),
    );
  }
  console.log(`one person, ${json(oracle.count)}\n${growth.join("\n")}`);
  expect(unnamedRecords(only.doc).records).toBeLessThan(10 * LONG_RUN);
}, 600_000);

const open = (baseline: Uint8Array, clientID: number) => {
  const doc = new Y.Doc();
  docs.push(doc);
  doc.clientID = clientID;
  doc.getText(SEQUENCE);
  doc.getMap(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  return doc;
};
const exchange = (left: Y.Doc, right: Y.Doc) => {
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left, Y.encodeStateVector(right)), REMOTE);
  Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)), REMOTE);
};
const pathsOf = (doc: Y.Doc) =>
  readBody(schema, doc).map((line) => line.path.map((container) => container.id));
const titlesOf = (doc: Y.Doc) =>
  (
    readBodySequence(schema, doc).toJSON() as { content: { type: string; attrs?: SequenceAttrs }[] }
  ).content.map((block) => (block.type === "callout" ? block.attrs?.title : block.type));

it.each([
  ["before the line's own", false, ["false paragraph:", "true paragraph:,heading:abc"]],
  ["after it, which section 4 forbids", true, ["true paragraph:,heading:", "false paragraph:abc"]],
])(
  "a tick and a heading given to a to-do while someone adds a line above it, with the new boundary %s",
  (_, wrong, read) => {
    const baseline = note(
      [
        { id: "T", type: "taskList", attrs: {} },
        { id: "T1", type: "taskItem", attrs: {} },
      ],
      [["abc", PARAGRAPH, ["T", "T1"]]],
    );
    const splitter = open(baseline, 10);
    const ticker = open(baseline, 20);
    const split = splitLine(schema, splitter, 0, 0, () => "fresh")!;
    if (wrong) split.added!.index++;
    splitter.transact(() => writeBody(splitter, split), LOCAL);
    ticker.transact(() => {
      writeBody(ticker, setContainerAttributes(schema, ticker, 0, 1, { checked: true }, String)!);
      writeBody(ticker, setLineKind(schema, ticker, 0, { type: "heading", level: 2 })!);
    }, LOCAL);
    exchange(splitter, ticker);
    const list = (
      readBodySequence(schema, ticker).toJSON() as {
        content: {
          content: {
            attrs: { checked: boolean };
            content: { type: string; content?: { text: string }[] }[];
          }[];
        }[];
      }
    ).content[0]!;
    expect(
      list.content.map(
        (item) =>
          `${String(item.attrs.checked)} ${item.content.map((block) => `${block.type}:${block.content?.[0]?.text ?? ""}`).join(",")}`,
      ),
    ).toEqual(read);
    expect(view(splitter)).toBe(view(ticker));
  },
);

const calloutNote = () =>
  note(
    [{ id: "C", type: "callout", attrs: { calloutType: "tip", title: "Read me", fold: "+" } }],
    ["a", "b", "c"].map((text): Written => [text, PARAGRAPH, ["C"]]),
  );

it("gives what a callout holds after a lifted line a fresh id and the same settings", () => {
  const { oracle, people } = team(1, calloutNote());
  const only = people[0]!;
  only.lift(1, 1, 1);
  expect(pathsOf(only.doc)).toEqual([["C"], [], ["w0"]]);
  expect(titlesOf(only.doc)).toEqual(["Read me", "paragraph", "Read me"]);
  expect(only.records.get("w0.fold")).toBe("+");
  only.undo();
  expect(pathsOf(only.doc)).toEqual([["C"], ["C"], ["C"]]);
  settled(people, oracle, true);
});

it("gives a callout its own id before changing its title when its id is on two callouts", () => {
  const { oracle, people } = team(2, calloutNote());
  const [lifter, adder] = people as [Person, Person];
  lifter.lift(2, 1, 1);
  adder.split(2, 1);
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  expect(pathsOf(lifter.doc)).toEqual([["C"], ["C"], [], ["C"]]);
  lifter.newStep();
  lifter.containerAttrs(3, 0, { title: "Danger" });
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  expect(pathsOf(adder.doc)).toEqual([["C"], ["C"], [], ["w0"]]);
  expect(titlesOf(adder.doc)).toEqual(["Read me", "paragraph", "Danger"]);
  expect(adder.records.get("w0.calloutType")).toBe("tip");
  lifter.undo();
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  expect(titlesOf(adder.doc)).toEqual(["Read me", "paragraph", "Read me"]);
  expect(adder.records.get("w0.title")).toBe("Danger");
});

it("redo puts back what the undo replaced, which is someone else's start number", () => {
  const baseline = note(
    [
      { id: "N", type: "orderedList", attrs: {} },
      { id: "N1", type: "listItem", attrs: {} },
    ],
    [["a", PARAGRAPH, ["N", "N1"]]],
  );
  const { oracle, people } = team(2, baseline);
  const [first, second] = people as [Person, Person];
  const start = () => first.records.get("N.start");
  first.containerAttrs(0, 0, { start: 5 });
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  second.containerAttrs(0, 0, { start: 9 });
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  first.undo();
  expect(start()).toBe(1);
  first.redo();
  expect(start()).toBe(9);
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
});

it.each([
  ["puts the earlier level back", undefined],
  ["passes over the step when the heading was made without its level", NO_KIND_DEFAULTS],
] as [string, Fault | undefined][])(
  "undo of a heading's level after someone changed it again %s",
  (_, fault) => {
    const { oracle, people } = team(2, plainNote(), true, fault);
    const [first, second] = people as [Person, Person];
    const level = () =>
      JSON.parse(
        first
          .shot()
          .tokens.flatMap((token) =>
            token.kind === "boundary" ? [token.attrs.get("level")?.value ?? "null"] : [],
          )[0]!,
      ) as unknown;
    first.type(0, 0, "X");
    first.newStep();
    first.kind(0, { type: "heading", level: 1 });
    first.newStep();
    first.kind(0, { type: "heading", level: 3 });
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
    second.kind(0, { type: "heading", level: 2 });
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
    if (fault) {
      expect(() => first.undo()).toThrow("[3 undo] undo passed over a step");
      return;
    }
    first.undo();
    expect(level()).toBe(1);
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
  },
);

it.each([
  ["as the step last set it", false, 5],
  ["as someone else set it since", true, 9],
])(
  "undo of a step that made a list and then set its start number leaves the number %s",
  (_, changedSince, start) => {
    const { oracle, people } = team(2, plainNote());
    const [first, second] = people as [Person, Person];
    first.wrap(0, 0, 1, "orderedList", { start: 3 });
    first.containerAttrs(0, 0, { start: 5 });
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
    if (changedSince) second.containerAttrs(0, 0, { start: 9 });
    second.split(0, 4);
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
    first.undo();
    deliver(people, "one by one", random(1));
    settled(people, oracle, true);
    expect(pathsOf(second.doc)).toEqual([[], ["w0", "x0"], [], []]);
    expect(second.records.get("w0.start")).toBe(start);
  },
);

it("shows a title set while someone lifts a line out of the callout's middle on its first part only", () => {
  const { oracle, people } = team(2, calloutNote());
  const [namer, lifter] = people as [Person, Person];
  namer.containerAttrs(0, 0, { title: "Danger" });
  lifter.lift(1, 1, 1);
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  expect(titlesOf(namer.doc)).toEqual(["Danger", "paragraph", "Read me"]);
  lifter.undo();
  deliver(people, "one by one", random(1));
  settled(people, oracle, true);
  expect(titlesOf(namer.doc)).toEqual(["Danger"]);
});

it("splits a line inside bold text without writing any formatting", () => {
  const doc = open(plainNote(), 10);
  const sequence = doc.getText(SEQUENCE);
  const formatting = () => {
    let items = 0;
    for (let item = sequence._start; item !== null; item = item.right)
      if (item.content instanceof Y.ContentFormat) items++;
    return items;
  };
  doc.transact(() => sequence.format(1, 4, { bold: {} }), LOCAL);
  const before = formatting();
  doc.transact(() => writeBody(doc, splitLine(schema, doc, 0, 2, String)!), LOCAL);
  expect(formatting()).toBe(before);
  const bold = { type: "text", marks: [{ type: "bold" }] };
  expect(readBodySequence(schema, doc).toJSON()).toMatchObject({
    content: [
      { content: [{ ...bold, text: "ab" }] },
      { content: [{ ...bold, text: "cd" }] },
      {},
      {},
    ],
  });
});
