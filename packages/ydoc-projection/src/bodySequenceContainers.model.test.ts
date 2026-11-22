import { afterEach, expect, it } from "vitest";
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
  deleteLetters,
  indentItem,
  joinLine,
  liftBlocks,
  outdentItem,
  readBody,
  setContainerAttributes,
  setContainerKind,
  setLineKind,
  splitLine,
  typeLetters,
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
const NEVER_ELAPSES = Number.MAX_SAFE_INTEGER;
const LISTS = ["bulletList", "orderedList", "taskList"];
const ITEMS = ["listItem", "taskItem"];
const ITEM_OF: Record<string, string | undefined> = {
  bulletList: "listItem",
  orderedList: "listItem",
  taskList: "taskItem",
};
const defaultsOf = (types: string[]): Record<string, unknown> =>
  Object.fromEntries(
    types.flatMap((type) =>
      Object.entries(schema.nodes[type]!.spec.attrs ?? {}).map(([key, spec]) => [
        key,
        (spec as { default?: unknown }).default ?? null,
      ]),
    ),
  );
const DEFAULTS = defaultsOf(["blockquote", "callout", ...LISTS, ...ITEMS]);
const HIGH_HALF = /[\uD800-\uDBFF]/;
const LOW_HALF = /[\uDC00-\uDFFF]/;

const FAULT = {
  defaultMapUndo: "Yjs's default undo of map changes",
  noDeleteFilter: "no delete filter",
  recordsOnlyFilter: "a delete filter that keeps container records and not a boundary's attributes",
  typeRecordOnly: "a container made with its type record and no defaults",
  defaultFirst: "a missing record's default written first, outside the history",
  oldBoundaryAbove: "a split at offset 0 that leaves the old boundary with the empty line",
  oneRecordForTwins: "a setting written to an id that is on two containers",
  noKindDefaults: "a line's kind written without the attributes that hold their default",
  splitInsideLetter: "a split between the two units of a surrogate pair",
  alwaysLowerBoundary: "a join that always deletes the lower line's boundary",
  wrongSetting: "a start number written one higher than asked",
  deleteAndRecreate: "a record deleted and written again in one transaction",
  copyKnownAttributes: "a fresh id's copy that takes only the records its kind has",
} as const;
type Fault = (typeof FAULT)[keyof typeof FAULT];

type Id = string;
const idOf = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;
const json = (value: unknown) =>
  JSON.stringify(value, (_key, held: unknown) => (typeof held === "bigint" ? Number(held) : held));

type Held = { item: Id; value: string };
type Token =
  | { kind: "char"; id: Id; line: Id | null; unit: string }
  | { kind: "boundary"; id: Id; attrs: Map<string, Held> };
type Shot = { tokens: Token[]; records: Map<string, Held> };
type Row = { boundary: Id | null; attrs: Map<string, Held>; chars: Id[]; units: string };

const heldBy = new WeakMap<Y.Item, { length: number; held: Held }>();

function heldIn(map: Map<string, Y.Item>): Map<string, Held> {
  const all = new Map<string, Held>();
  for (const [key, item] of map) {
    if (item.deleted) continue;
    let known = heldBy.get(item);
    if (known?.length !== item.length) {
      const held = {
        item: idOf(item.id.client, item.id.clock + item.length - 1),
        value: json(item.content.getContent()[item.length - 1]),
      };
      known = { length: item.length, held };
      heldBy.set(item, known);
    }
    all.set(key, known.held);
  }
  return all;
}

function shoot(doc: Y.Doc): Shot {
  const tokens: Token[] = [];
  let line: Id | null = null;
  for (let item = doc.getText(SEQUENCE)._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString)
      for (let at = 0; at < content.str.length; at++)
        tokens.push({
          kind: "char",
          id: idOf(item.id.client, item.id.clock + at),
          line,
          unit: content.str[at]!,
        });
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement) {
      line = idOf(item.id.client, item.id.clock);
      tokens.push({ kind: "boundary", id: line, attrs: heldIn(content.type._map) });
    }
  }
  return { tokens, records: heldIn(doc.getMap(CONTAINERS)._map) };
}

function rowsOf(shot: Shot): Row[] {
  const rows: Row[] = [];
  const unbounded = (): Row => ({ boundary: null, attrs: new Map(), chars: [], units: "" });
  for (const token of shot.tokens)
    if (token.kind === "boundary")
      rows.push({ boundary: token.id, attrs: token.attrs, chars: [], units: "" });
    else {
      if (rows.length === 0) rows.push(unbounded());
      rows.at(-1)!.chars.push(token.id);
      rows.at(-1)!.units += token.unit;
    }
  return rows.length > 0 ? rows : [unbounded()];
}

const pathOf = (row: Row) => JSON.parse(row.attrs.get("path")?.value ?? "[]") as string[];
const freshIds = (before: Shot, after: Shot) =>
  [...after.records.keys()].filter((key) => !key.includes(".") && !before.records.has(key));
const reads = (shot: Shot, key: string) => {
  const attribute = key.split(".")[1];
  const unset = attribute === undefined ? undefined : json(DEFAULTS[attribute]);
  return shot.records.get(key)?.value ?? unset;
};

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
  boundariesForUnboundedText: 0,
  refusedInsideALetter: 0,
  unnamedRecords: 0,
  records: 0,
});
type Tally = ReturnType<typeof tally>;

class Oracle {
  readonly rootOf = new Map<Id, Id>();
  readonly unitOf = new Map<Id, string>();
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
  sees(tokens: Token[]) {
    for (const token of tokens) {
      if (token.kind !== "char") continue;
      const known = this.unitOf.get(this.root(token.id));
      if (known === undefined) this.unitOf.set(token.id, token.unit);
      else if (known !== token.unit)
        throw new Error(`[2 letters] a letter changed from ${json(known)} to ${json(token.unit)}`);
    }
  }
}

function twins(doc: Y.Doc) {
  const held = new Set(readBody(schema, doc).flatMap((line) => line.path));
  return held.size - new Set([...held].map((container) => container.id)).size;
}

function kindsHold(shot: Shot) {
  for (const token of shot.tokens) {
    if (token.kind !== "boundary") continue;
    const type = String(JSON.parse(token.attrs.get("type")?.value ?? "null"));
    for (const key of ["type", "path", ...Object.keys(schema.nodes[type]?.spec.attrs ?? {})])
      if (!token.attrs.has(key)) throw new Error(`[7 kind] a ${type} boundary holds no ${key}`);
  }
}

function expectMade(after: Shot, id: string, type: string, attrs: SequenceAttrs) {
  for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
    if (reads(after, key) !== json(value))
      throw new Error(
        `[4 settings] asked for a ${type} with ${key.slice(id.length) || "type"} ${json(value)} and the note holds ${String(reads(after, key))}`,
      );
}

function expectCopies(before: Shot, after: Shot, changed: string[] = []) {
  const was = new Map(rowsOf(before).map((row) => [row.boundary, pathOf(row)]));
  for (const id of freshIds(before, after)) {
    const replaced = rowsOf(after).flatMap((row) => {
      const path = pathOf(row);
      const earlier = path.includes(id) ? (was.get(row.boundary) ?? []) : [];
      return earlier.filter((old) => !path.includes(old));
    });
    const whole = replaced.some((old) =>
      [...before.records].every(([key, held]) => {
        if (key !== old && !key.startsWith(`${old}.`)) return true;
        const suffix = key.slice(old.length);
        return changed.includes(suffix) || reads(after, id + suffix) === held.value;
      }),
    );
    if (!whole)
      throw new Error(
        `[4 settings] the fresh id ${id} does not hold a copy of every record of the id it replaces`,
      );
  }
}

const docs: Y.Doc[] = [];
afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

type Expected = { chars?: number; boundaries?: number; movable?: Id[] };
type Claim = { value: string | undefined; round: number };

function person(baseline: Uint8Array, who: number, oracle: Oracle, gc: boolean, fault?: Fault) {
  const doc = new Y.Doc({ gc });
  docs.push(doc);
  doc.clientID = 10 * (who + 1);
  const sequence = doc.getText(SEQUENCE);
  const records = doc.getMap<unknown>(CONTAINERS);
  Y.applyUpdate(doc, baseline, REMOTE);
  records.delete = () => {
    throw new Error("[5 records] a writer deleted a record");
  };
  const own = { trackedOrigins: new Set([LOCAL]), captureTimeout: NEVER_ELAPSES };
  const keepRecords = (item: Y.Item) => item.parent !== records;
  const keepAttributes = (item: Y.Item) =>
    keepRecords(item) && !(item.parentSub !== null && item.parent instanceof Y.XmlElement);
  const history =
    fault === FAULT.defaultMapUndo
      ? new Y.UndoManager([sequence, records], { ...own, deleteFilter: keepAttributes })
      : fault === FAULT.noDeleteFilter
        ? new Y.UndoManager([sequence, records], { ...own, ignoreRemoteMapChanges: true })
        : fault === FAULT.recordsOnlyFilter
          ? new Y.UndoManager([sequence, records], {
              ...own,
              ignoreRemoteMapChanges: true,
              deleteFilter: keepRecords,
            })
          : bodyHistory(doc, LOCAL, NEVER_ELAPSES);
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
    oracle.sees(after.tokens);
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

  const local = (act: () => void, expected: Expected, settings: string[] = []): [Step, Shot] => {
    const depth = history.undoStack.length;
    const twinsBefore = twins(doc);
    const before = shoot(doc);
    doc.transact(act, LOCAL);
    const [effects, after] = seen(before);
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
    if ((expected.boundaries ?? 0) >= 0 && effects.deletedBoundaries.length > 0)
      throw new Error("[writer] a change that deletes no boundary deleted one");
    if ((expected.boundaries ?? 0) <= 0 && effects.insertedBoundaries.length > 0)
      throw new Error("[writer] a change that adds no boundary added one");
    if (!effects.moved.every((id) => expected.movable?.includes(id)))
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
    return [effects, after];
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

  const write = (plan: BodyWrites | null, expected: Expected = {}): [Step, Shot] | null => {
    if (!plan) return null;
    const settings: string[] = [];
    for (const [key, value] of plan.records)
      if (!records.has(key.split(".")[0]!)) oracle.asMade.set(key, json(value));
      else {
        oracle.asMade.delete(key);
        settings.push(key);
      }
    for (const [key, value] of fault === undefined ? [] : [...plan.records]) {
      const [id, attribute] = key.split(".") as [string, string | undefined];
      const isDefault = attribute !== undefined && json(value) === json(DEFAULTS[attribute]);
      const itsKind = () =>
        recordsOfContainer(schema, { id, type: String(plan.records.get(id)), attrs: {} });
      if (fault === FAULT.typeRecordOnly || fault === FAULT.defaultFirst) {
        if (isDefault && !records.has(key)) plan.records.delete(key);
      } else if (fault === FAULT.copyKnownAttributes) {
        if (!records.has(id) && !itsKind().has(key)) plan.records.delete(key);
      } else if (fault === FAULT.wrongSetting && attribute === "start")
        plan.records.set(key, Number(value) + 1);
    }
    const missing = [...plan.records.keys()].filter(
      (key) => key.includes(".") && !records.has(key),
    );
    if (fault === FAULT.defaultFirst && missing.length > 0) {
      const before = shoot(doc);
      doc.transact(() => {
        for (const key of missing) records.set(key, DEFAULTS[key.split(".")[1]!]);
      }, OUTSIDE_HISTORY);
      seen(before);
    }
    return local(
      () => {
        if (fault === FAULT.deleteAndRecreate)
          for (const key of plan.records.keys()) if (records.has(key)) records.delete(key);
        writeBody(doc, plan);
      },
      expected,
      settings,
    );
  };

  const shown = () =>
    leavesOfSequence(schema, piecesOfSequence(sequence), records).map((leaf) =>
      leaf.path.map((frame) => json([frame.type, frame.attrs])),
    );
  const setting = (
    at: number,
    depth: number,
    type: string | undefined,
    attrs: SequenceAttrs,
    plan: BodyWrites | null,
  ) => {
    const body = lines();
    const container = body[at]?.path[depth];
    if (!container) return false;
    const before = shoot(doc);
    const shownBefore = shown();
    const asked = new Map(Object.entries(attrs).map(([name, value]) => [`.${name}`, json(value)]));
    if (type !== undefined) asked.set("", json(type));
    if (plan && fault === FAULT.oneRecordForTwins) withoutFreshIds(plan);
    const done = write(plan);
    if (!done) {
      for (const [suffix, value] of asked)
        if (before.records.get(container.id + suffix)?.value !== value)
          throw new Error(
            `[4 settings] asked for ${suffix || "type"} ${value} and the writer wrote nothing`,
          );
      return false;
    }
    const after = done[1];
    const now = lines();
    const its = now[at]!.path[depth]!;
    for (const [suffix, value] of asked) {
      const holds = after.records.get(its.id + suffix)?.value;
      if (holds !== value)
        throw new Error(
          `[4 settings] asked for ${suffix || "type"} ${value} and the note holds ${String(holds)}`,
        );
      claims.set(`record ${its.id}${suffix}`, { value, round: oracle.round });
    }
    for (const line of now) {
      const item = line.path[depth] === its ? line.path[depth + 1] : undefined;
      const itemType = type === undefined ? undefined : ITEM_OF[type];
      if (item && itemType && after.records.get(item.id)?.value !== json(itemType))
        throw new Error(`[4 settings] an item of a list made a ${type!} is stored as another kind`);
    }
    expectCopies(before, after, [...asked.keys()]);
    if (freshIds(before, after).length > 0) oracle.count.freshIdsForATwin++;
    shown().forEach((path, index) =>
      path.forEach((frame, level) => {
        const itsOwn = body[index]!.path[depth] === container;
        const onIt = level === depth || (type !== undefined && level === depth + 1);
        if (frame !== shownBefore[index]![level] && !(itsOwn && onIt))
          throw new Error("[writer] a setting changed on a container it was not made on");
      }),
    );
    return true;
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
    oracle.sees(after.tokens);
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
      const earlier = change.from?.value ?? json(DEFAULTS[key.split(".")[1] ?? ""]);
      if (reads(after, key) !== earlier)
        throw new Error(
          `[4 settings] ${which} left ${key} reading ${String(reads(after, key))}, and it read ${String(earlier)} before the step`,
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
    kindsHold(after);
    return did;
  };

  const expectDefaults = (before: Shot, after: Shot) => {
    for (const id of freshIds(before, after))
      expectMade(after, id, String(JSON.parse(after.records.get(id)!.value)), {});
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
    type(at: number, offset: number, letters: string) {
      const done = write(typeLetters(schema, doc, at, offset, letters), { chars: letters.length });
      if (!done) return false;
      const [effects, after] = done;
      const landed = rowsOf(after)[at]?.chars.slice(offset, offset + letters.length);
      if (json(landed) !== json(effects.insertedChars))
        throw new Error("[writer] letters landed away from where they were typed");
      const units = new Map(
        after.tokens.flatMap((token) => (token.kind === "char" ? [[token.id, token.unit]] : [])),
      );
      if (effects.insertedChars.map((id) => units.get(id)).join("") !== letters)
        throw new Error("[2 letters] the note does not hold the letters that were typed");
      return true;
    },
    erase(at: number, offset: number, length: number) {
      const asked = rowsOf(shoot(doc))[at]?.chars.slice(offset, offset + length) ?? [];
      const done = write(deleteLetters(schema, doc, at, offset, length), { chars: -asked.length });
      if (!done) return false;
      if (json(done[0].deletedChars) !== json(asked))
        throw new Error("[writer] an erase deleted other letters than the ones asked for");
      return true;
    },
    split(at: number, offset: number) {
      const before = shoot(doc);
      const row = rowsOf(before)[at];
      if (!row || offset > row.chars.length) return false;
      const inside =
        HIGH_HALF.test(row.units.charAt(offset - 1)) && LOW_HALF.test(row.units.charAt(offset));
      let plan = splitLine(schema, doc, at, offset, freshId);
      if (!plan && inside) oracle.count.refusedInsideALetter++;
      if (!plan && inside && fault === FAULT.splitInsideLetter) {
        plan = splitLine(schema, doc, at, offset + 1, freshId);
        if (plan?.added) plan.added[0]!.index--;
      }
      if (!plan?.added) return false;
      const unbounded = row.boundary === null && offset === 0;
      const above = offset === 0 && row.chars.length > 0 && !unbounded;
      if (above && fault === FAULT.oldBoundaryAbove) plan.added[0]!.index++;
      if (unbounded) oracle.count.boundariesForUnboundedText++;
      const done = write(plan, {
        boundaries: unbounded ? 2 : 1,
        movable: above ? [] : row.chars.slice(offset),
      })!;
      const [upper, lower] = rowsOf(done[1]).slice(at, at + 2);
      const stays = above || unbounded ? [] : row.chars.slice(0, offset);
      const wrongLine = above
        ? lower?.boundary !== row.boundary
        : !unbounded && upper?.boundary !== row.boundary;
      if (
        wrongLine ||
        json(upper?.chars) !== json(stays) ||
        json(lower?.chars) !== json(row.chars.slice(stays.length))
      )
        throw new Error("[writer] a split put its boundary in the wrong place");
      expectDefaults(before, done[1]);
      return true;
    },
    join(at: number) {
      const rows = rowsOf(shoot(doc));
      const upper = rows[at - 1];
      const lower = rows[at];
      const plan = joinLine(schema, doc, at);
      if (!upper || !lower?.boundary) {
        if (plan) throw new Error("[writer] a join was written where no line can be joined");
        return false;
      }
      if (!plan) throw new Error("[writer] a join was refused between two lines");
      if (fault === FAULT.alwaysLowerBoundary) plan.removed = lines()[at]!.start - 1;
      const upperGoes = upper.boundary !== null && upper.chars.length === 0;
      const done = write(plan, { boundaries: -1, movable: upperGoes ? [] : lower.chars })!;
      if (json(done[0].deletedBoundaries) !== json([upperGoes ? upper.boundary : lower.boundary]))
        throw new Error("[writer] a join deleted the boundary of the wrong line");
      return true;
    },
    kind(at: number, asked: SequenceAttrs) {
      const row = rowsOf(shoot(doc))[at];
      if (!row) return false;
      const held = String(JSON.parse(row.attrs.get("type")?.value ?? '"paragraph"'));
      const type = typeof asked.type === "string" ? asked.type : held;
      const unset = defaultsOf([type]);
      const expected = new Map([["type", json(type)]]);
      for (const key of Object.keys(unset))
        expected.set(
          key,
          key in asked
            ? json(asked[key])
            : ((type === held ? row.attrs.get(key)?.value : undefined) ?? json(unset[key])),
        );
      const plan = setLineKind(schema, doc, at, asked);
      if (plan && fault === FAULT.noKindDefaults)
        for (const attrs of [
          ...plan.attributes.values(),
          ...(plan.added ?? []).map((a) => a.attrs),
        ])
          for (const key of Object.keys(unset))
            if (!row.attrs.has(key) && json(attrs[key]) === json(unset[key])) delete attrs[key];
      const unbounded = row.boundary === null;
      if (plan && unbounded) oracle.count.boundariesForUnboundedText++;
      const done = write(plan, {
        boundaries: unbounded ? 1 : 0,
        movable: unbounded ? row.chars : [],
      });
      const now = done ? rowsOf(done[1])[at]!.attrs : row.attrs;
      for (const [key, value] of expected)
        if (now.get(key)?.value !== value && (done || !unbounded || type !== "paragraph"))
          throw new Error(
            `[7 kind] asked for ${json(asked)}, and the boundary holds ${key} ${String(now.get(key)?.value)} where it should hold ${value}`,
          );
      return done !== null;
    },
    wrap(at: number, depth: number, count: number, type: string, attrs: SequenceAttrs) {
      const before = shoot(doc);
      const first = rowsOf(before)[0]!;
      const unbounded = at === 0 && first.boundary === null;
      const plan = wrapBlocks(schema, doc, at, depth, count, type, attrs, freshId);
      if (plan && unbounded) oracle.count.boundariesForUnboundedText++;
      const done = write(plan, {
        boundaries: unbounded ? 1 : 0,
        movable: unbounded ? first.chars : [],
      });
      if (!done) return false;
      const made = lines()[at]!.path[depth]?.id;
      const fresh = freshIds(before, done[1]);
      if (made === undefined || !fresh.includes(made))
        throw new Error("[4 settings] a wrap made no container where it was asked for one");
      for (const id of fresh)
        if (id === made) expectMade(done[1], id, type, attrs);
        else if (ITEM_OF[type]) expectMade(done[1], id, ITEM_OF[type], {});
        else throw new Error("[4 settings] a wrap made a container it was not asked for");
      return true;
    },
    lift(at: number, depth: number, count: number) {
      const before = shoot(doc);
      const done = write(liftBlocks(schema, doc, at, depth, count, freshId));
      if (done) expectCopies(before, done[1]);
      return done !== null;
    },
    indent(at: number, depth: number) {
      const before = shoot(doc);
      const done = write(indentItem(schema, doc, at, depth, freshId));
      if (done) expectDefaults(before, done[1]);
      return done !== null;
    },
    outdent(at: number, depth: number) {
      const before = shoot(doc);
      const done = write(outdentItem(schema, doc, at, depth, freshId));
      if (done) expectCopies(before, done[1]);
      return done !== null;
    },
    containerKind: (at: number, depth: number, type: string) =>
      setting(at, depth, type, {}, setContainerKind(schema, doc, at, depth, type, freshId)),
    containerAttrs: (at: number, depth: number, attrs: SequenceAttrs) =>
      setting(
        at,
        depth,
        undefined,
        attrs,
        setContainerAttributes(schema, doc, at, depth, attrs, freshId),
      ),
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

function note(
  frames: SequenceFrame[],
  lines: Written[],
  more: Record<string, unknown> = {},
  unbounded = "",
): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const sequence = doc.getText(SEQUENCE);
  const records = doc.getMap(CONTAINERS);
  for (const frame of frames)
    for (const [key, value] of recordsOfContainer(schema, frame)) records.set(key, value);
  for (const [key, value] of Object.entries(more)) records.set(key, value);
  sequence.insert(0, unbounded, {});
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

const nestedNote = (unbounded = "") =>
  note(
    [
      { id: "Q", type: "blockquote", attrs: {} },
      { id: "T", type: "taskList", attrs: {} },
      { id: "T1", type: "taskItem", attrs: {} },
      { id: "N", type: "orderedList", attrs: { start: 3n } },
      { id: "N1", type: "listItem", attrs: {} },
      { id: "T2", type: "taskItem", attrs: { checked: true } },
      { id: "C", type: "callout", attrs: { calloutType: "tip", title: "Read me", fold: "+" } },
    ],
    [
      ["a\u{1F600}b", PARAGRAPH, []],
      ["cd", { type: "heading", level: 2 }, ["Q"]],
      ["ef", PARAGRAPH, ["Q"]],
      ["gh", PARAGRAPH, ["T", "T1"]],
      ["ij", PARAGRAPH, ["T", "T1", "N", "N1"]],
      ["kl", PARAGRAPH, ["T", "T2"]],
      ["mn", PARAGRAPH, ["C"]],
      ["o\u{1F9E9}", PARAGRAPH, ["C"]],
      ["qr", PARAGRAPH, ["C"]],
      ["st", PARAGRAPH, []],
    ],
    { "Q.start": 7, "T.title": "kept", "T1.fold": "-", "N.calloutType": "tip", "C.checked": true },
    unbounded,
  );
const STARTS = [plainNote, nestedNote, () => nestedNote("u\u{1F389}v")];

function team(count: number, baseline: Uint8Array, gc = true, fault?: Fault) {
  const oracle = new Oracle();
  const base = new Y.Doc();
  Y.applyUpdate(base, baseline);
  const { tokens } = shoot(base);
  oracle.sees(tokens);
  for (const token of tokens)
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
    throw new Error(`[1 same note] the note is not a valid document: ${String(error)}`, {
      cause: error,
    });
  }
  return json({
    tokens: shot.tokens.map((token) =>
      token.kind === "char" ? [token.id, token.line, token.unit] : [token.id, sorted(token.attrs)],
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
  oracle.sees(final);
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
  for (const [key, value] of oracle.asMade)
    if (reads(shot, key) !== value)
      throw new Error(
        `[4 settings] ${key} was made as ${value} and reads ${String(reads(shot, key))}, and no one changed it`,
      );
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
  const named = new Set(rowsOf(shot).flatMap(pathOf));
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
  for (const line of readBody(schema, doc)) {
    if (!line.boundary) continue;
    if (json(line.attrs.path) !== json(line.path.map((container) => container.id)))
      throw new Error("[writer] a path does not read as it was written");
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
  kindsHold(final);
  if (faithful && readsAsWritten(people[0]!.doc) > 0) oracle.count.roundsWithOneIdOnTwo++;
  oracle.round++;
}

const CALLOUT_KINDS = ["note", "tip", "warning"];
const TITLES = ["", "Read me", "Danger"];
const FOLDS = ["", "+", "-"];

type Weights = { wraps: number; kindsOfTheFirstLine: number };
const EVEN: Weights = { wraps: 1, kindsOfTheFirstLine: 0 };
const ONE_LINE: Weights = { wraps: 1, kindsOfTheFirstLine: 600 };

function change(
  each: Person,
  next: () => number,
  letter: () => string,
  log: string[],
  { wraps, kindsOfTheFirstLine }: Weights,
) {
  const pick = (below: number) => Math.floor(next() * below);
  const tried = (what: unknown[], run: () => boolean) => {
    log.push(`${String(each.who)}:${what.join(" ")}`);
    if (run()) return true;
    log.pop();
    return false;
  };
  const lines = each.lines();
  const at = pick(lines.length);
  const line = lines[at]!;
  const length = line.text.length;
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
    const offset = pick(length + 1);
    return tried(["type", at, offset], () => each.type(at, offset, letter()));
  };
  const options: [number, () => boolean][] = [
    [14, typing],
    [
      4,
      () => {
        const offset = pick(length + 1);
        const count = Math.min(1 + pick(2), length - offset);
        return tried(["erase", at, offset, count], () => each.erase(at, offset, count));
      },
    ],
    [
      11,
      () => {
        const pair = line.text.search(HIGH_HALF);
        const insideALetter = pair < 0 ? 0 : pair + 1;
        const offset = [0, length, pick(length + 1), insideALetter][pick(4)]!;
        return tried(["split", at, offset], () => each.split(at, offset));
      },
    ],
    [8, () => tried(["join", at], () => each.join(at))],
    [
      11 * wraps,
      () => {
        const count = 1 + pick(3);
        const start = 1 + pick(5);
        const [type, attrs] = (
          [
            ["blockquote", {}],
            [
              "callout",
              { calloutType: CALLOUT_KINDS[pick(3)], title: TITLES[pick(3)], fold: FOLDS[pick(3)] },
            ],
            ["bulletList", {}],
            ["orderedList", { start: start % 2 === 0 ? BigInt(start) : start }],
            ["taskList", {}],
          ] as [string, SequenceAttrs][]
        )[pick(5)]!;
        return tried(["wrap", at, depth, count, type, json(attrs)], () =>
          each.wrap(at, depth, count, type, attrs),
        );
      },
    ],
    [
      8 * wraps,
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
        const asked = start % 3 === 0 ? BigInt(start) : start;
        return tried(["start", list.at, list.depth, start], () =>
          each.containerAttrs(list.at, list.depth, { start: asked }),
        );
      },
    ],
    [
      6 + kindsOfTheFirstLine,
      () => {
        const level = 1 + pick(3);
        const kind = [
          PARAGRAPH,
          { type: "heading" },
          { type: "heading", level },
          { level },
          { type: "codeBlock" },
          { type: "codeBlock", language: "ts" },
        ][pick(6)]!;
        const line = next() * (6 + kindsOfTheFirstLine) < 6 ? at : 0;
        return tried(["kind", line, json(kind)], () => each.kind(line, kind));
      },
    ],
  ];
  let roll = next() * options.reduce((sum, [weight]) => sum + weight, 0);
  const chosen = options.find(([weight]) => (roll -= weight) < 0) ?? options[0]!;
  if (!chosen[1]() && !typing()) tried(["type", at, 0], () => each.type(at, 0, letter()));
}

function act(
  each: Person,
  next: () => number,
  letter: () => string,
  log: string[],
  weights = EVEN,
) {
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
  } else change(each, next, letter, log, weights);
}

const FACES = ["\u{1F600}", "\u{1F389}", "\u{1F9E9}"];
const lettersFrom = () => {
  let typed = 0;
  return () => (typed++ % 5 === 4 ? FACES[typed % 3]! : String.fromCharCode(0x391 + (typed % 600)));
};

type Run = {
  seed: number;
  count: number;
  arrive: Arrive;
  rounds: number;
  busiest: number;
  gc: boolean;
  fault?: Fault;
  weights?: Weights;
};

function randomRun({ seed, count, arrive, rounds, busiest, gc, fault, weights }: Run): Tally {
  const next = random(seed);
  const { oracle, people } = team(count, STARTS[seed % 3]!(), gc, fault);
  const log: string[] = [];
  const letter = lettersFrom();
  try {
    for (let round = 0; round < rounds; round++) {
      for (const each of people)
        for (let changes = 1 + Math.floor(next() * busiest); changes > 0; changes--)
          act(each, next, letter, log, weights);
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

const SEEDS = Number(process.env.BODY_CONTAINERS_SEEDS ?? 40);
const WEIGHTS = process.env.BODY_CONTAINERS_ONE_LINE ? ONE_LINE : EVEN;
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
        add(total, randomRun({ seed, count, arrive, rounds, busiest, gc, weights: WEIGHTS }));
    console.log(
      `${String(count)} people, ${arrive}, ${String(rounds)} rounds of up to ${String(busiest)}: ${json(total)}`,
    );
    expect(total.runs).toBe(2 * SEEDS);
  },
  600_000,
);

const BREAKAGE_SEEDS = Number(process.env.BODY_CONTAINERS_BREAKAGE_SEEDS ?? 8);
const BREAKAGES: [Fault, string, Weights?][] = [
  [FAULT.defaultMapUndo, "[3 undo]"],
  [FAULT.noDeleteFilter, "[5 records] the record"],
  [FAULT.typeRecordOnly, "[3 undo] or [4 settings]"],
  [FAULT.defaultFirst, "[4 settings]"],
  [FAULT.oldBoundaryAbove, "[writer] a change took letters to another line"],
  [FAULT.oneRecordForTwins, "[writer] a setting changed on a container it was not made on"],
  [FAULT.noKindDefaults, "[7 kind] asked for"],
  [FAULT.splitInsideLetter, "[2 letters] a letter changed"],
  [
    FAULT.alwaysLowerBoundary,
    "[writer] a join deleted the boundary of the wrong line or [writer] a change took letters",
  ],
  [FAULT.recordsOnlyFilter, "[7 kind] a", ONE_LINE],
  [FAULT.wrongSetting, "[4 settings] asked for"],
  [FAULT.deleteAndRecreate, "[5 records] a writer deleted a record"],
  [FAULT.copyKnownAttributes, "[4 settings] the fresh id"],
];

it.each(BREAKAGES)(
  "fails when broken on purpose with %s, at check %s",
  (fault, check, weights) => {
    const fired = new Map<string, number>();
    let asExpected = 0;
    for (let seed = 1; seed <= BREAKAGE_SEEDS; seed++)
      for (const [count, arrive, rounds, busiest] of SETUPS) {
        try {
          const gc = seed % 2 === 0;
          randomRun({ seed, count, arrive, rounds, busiest, gc, fault, weights });
        } catch (error) {
          const said = /\n(\[[^\]]+\]) ?(.*)/.exec(String(error)) ?? [];
          const message = `${String(said[1])} ${String(said[2])}`;
          if (check.split(" or ").some((one) => message.startsWith(one))) asExpected++;
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
    expect(asExpected).toBeGreaterThan(0);
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
    act(only, next, letter, log, { wraps: 4, kindsOfTheFirstLine: 0 });
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
const written = (doc: Y.Doc, plan: BodyWrites | null) => {
  if (plan) doc.transact(() => writeBody(doc, plan), LOCAL);
  return plan !== null;
};
const pathsOf = (doc: Y.Doc) =>
  readBody(schema, doc).map((line) => line.path.map((container) => container.id));
const storedLines = (doc: Y.Doc) =>
  readBody(schema, doc).map((line) => (line.boundary ? { ...line.attrs, text: line.text } : null));
const blocksOf = (doc: Y.Doc) =>
  (
    readBodySequence(schema, doc).toJSON() as {
      content: {
        type: string;
        attrs?: SequenceAttrs;
        content?: { type: string; text?: string }[];
      }[];
    }
  ).content;
const titlesOf = (doc: Y.Doc) =>
  blocksOf(doc).map((block) => (block.type === "callout" ? block.attrs?.title : block.type));
const textsOf = (doc: Y.Doc) =>
  blocksOf(doc).map((block) => `${block.type}:${block.content?.[0]?.text ?? ""}`);

it("refuses a split, a delete and typing between the two units of a surrogate pair", () => {
  const face = "\u{1F600}";
  const doc = open(note([], [[`a${face}b`, PARAGRAPH, []]]), 10);
  const text = () => readBody(schema, doc)[0]!.text;
  expect(splitLine(schema, doc, 0, 2, String)).toBeNull();
  expect(deleteLetters(schema, doc, 0, 1, 1)).toBeNull();
  expect(deleteLetters(schema, doc, 0, 2, 1)).toBeNull();
  expect(deleteLetters(schema, doc, 0, 2, 2)).toBeNull();
  expect(typeLetters(schema, doc, 0, 2, "x")).toBeNull();
  expect(typeLetters(schema, doc, 0, 1, face[0]!)).toBeNull();
  expect(text()).toBe(`a${face}b`);
  expect(written(doc, typeLetters(schema, doc, 0, 3, face))).toBe(true);
  expect(written(doc, splitLine(schema, doc, 0, 3, String))).toBe(true);
  expect(written(doc, deleteLetters(schema, doc, 0, 1, 2))).toBe(true);
  expect(readBody(schema, doc).map((line) => line.text)).toEqual(["a", `${face}b`]);
  expect(textsOf(doc)).toEqual(["paragraph:a", `paragraph:${face}b`]);
});

const unboundedNote = () => note([], [["d", PARAGRAPH, []]], {}, "abc");

it.each([
  [
    "a split at offset 0 gives it a boundary and the empty line above it another",
    (doc: Y.Doc) => splitLine(schema, doc, 0, 0, String),
    ["paragraph:", "paragraph:abc", "paragraph:d"],
  ],
  [
    "a change of kind gives it a boundary of that kind",
    (doc: Y.Doc) => setLineKind(schema, doc, 0, { type: "heading", level: 2 }),
    ["heading:abc", "paragraph:d"],
  ],
  [
    "a wrap gives it a boundary with the quote in its path",
    (doc: Y.Doc) => wrapBlocks(schema, doc, 0, 0, 1, "blockquote", {}, () => "q"),
    ["blockquote:", "paragraph:d"],
  ],
] as [string, (doc: Y.Doc) => BodyWrites | null, string[]][])(
  "text before the first boundary: %s",
  (_, plan, read) => {
    const doc = open(unboundedNote(), 10);
    const history = bodyHistory(doc, LOCAL);
    expect(storedLines(doc)[0]).toBeNull();
    expect(written(doc, plan(doc))).toBe(true);
    expect(textsOf(doc)).toEqual(read);
    const lines = storedLines(doc);
    expect(lines.every((line) => line !== null && "type" in line && "path" in line)).toBe(true);
    expect(lines.map((line) => line?.text)).toEqual(
      read.length === 3 ? ["", "abc", "d"] : ["abc", "d"],
    );
    history.undo();
    expect(storedLines(doc)).toEqual([null, { type: "paragraph", path: [], text: "d" }]);
    expect(readBody(schema, doc)[0]!.text).toBe("abc");
  },
);

it.each([
  [10, 20, ["heading:", "codeBlock:abc", "paragraph:d"], ["heading:Xabc", "paragraph:d"]],
  [
    20,
    10,
    ["codeBlock:", "heading:abc", "paragraph:d"],
    ["paragraph:X", "heading:abc", "paragraph:d"],
  ],
])(
  "text before the first boundary, when %i gives it a boundary while %i gives it one too, or types at its start",
  (one, other, bothBounded, typed) => {
    const heading = (doc: Y.Doc) => setLineKind(schema, doc, 0, { type: "heading", level: 2 });
    const first = open(unboundedNote(), one);
    const second = open(unboundedNote(), other);
    written(first, heading(first));
    written(second, setLineKind(schema, second, 0, { type: "codeBlock" }));
    exchange(first, second);
    expect(textsOf(first)).toEqual(bothBounded);
    expect(view(first)).toBe(view(second));
    const third = open(unboundedNote(), one);
    const fourth = open(unboundedNote(), other);
    written(third, heading(third));
    written(fourth, typeLetters(schema, fourth, 0, 0, "X"));
    exchange(third, fourth);
    expect(textsOf(third)).toEqual(typed);
    expect(view(third)).toBe(view(fourth));
  },
);

it("splits a note that holds nothing into two empty lines, each with a boundary", () => {
  const doc = open(note([], []), 10);
  expect(readBody(schema, doc)).toHaveLength(1);
  expect(written(doc, splitLine(schema, doc, 0, 0, String))).toBe(true);
  expect(storedLines(doc)).toEqual([
    { type: "paragraph", path: [], text: "" },
    { type: "paragraph", path: [], text: "" },
  ]);
  expect(textsOf(doc)).toEqual(["paragraph:", "paragraph:"]);
});

it("stores every attribute a line's kind has, with the default for one not asked for", () => {
  const doc = open(plainNote(), 10);
  const first = () => storedLines(doc)[0];
  expect(written(doc, setLineKind(schema, doc, 0, { type: "heading" }))).toBe(true);
  expect(first()).toEqual({ type: "heading", level: 1, path: [], text: "abcd" });
  expect(setLineKind(schema, doc, 0, { type: "heading" })).toBeNull();
  expect(written(doc, setLineKind(schema, doc, 0, { level: 3 }))).toBe(true);
  expect(first()).toMatchObject({ type: "heading", level: 3 });
  expect(written(doc, setLineKind(schema, doc, 0, { type: "codeBlock" }))).toBe(true);
  expect(first()).toMatchObject({ type: "codeBlock", language: null, level: 3 });
  expect(written(doc, setLineKind(schema, doc, 0, { type: "heading" }))).toBe(true);
  expect(first()).toMatchObject({ type: "heading", level: 1 });
  expect(written(doc, splitLine(schema, doc, 0, 2, String))).toBe(true);
  expect(storedLines(doc)[1]).toEqual({ type: "heading", level: 1, path: [], text: "cd" });
});

it("compares a BigInt with the number it reads as, in a record, an attribute and an array", () => {
  const baseline = note(
    [
      { id: "N", type: "orderedList", attrs: { start: 2n } },
      { id: "N1", type: "listItem", attrs: {} },
    ],
    [["a", { type: "heading", level: 2n }, ["N", "N1"]]],
    { "N.colwidth": [1n, 2] },
  );
  const doc = open(baseline, 10);
  const start = (value: unknown) =>
    setContainerAttributes(schema, doc, 0, 0, { start: value }, String);
  expect(start(2)).toBeNull();
  expect(start(2n)).toBeNull();
  expect(setContainerAttributes(schema, doc, 0, 0, { colwidth: [1, 2n] }, String)).toBeNull();
  expect(setLineKind(schema, doc, 0, { type: "heading", level: 2 })).toBeNull();
  expect(written(doc, start(3))).toBe(true);
  expect(doc.getMap(CONTAINERS).get("N.start")).toBe(3);
  expect(written(doc, start(4n))).toBe(true);
  expect(blocksOf(doc)[0]).toMatchObject({ type: "orderedList", attrs: { start: 4 } });
});

const calloutNote = (more: Record<string, unknown> = {}) =>
  note(
    [{ id: "C", type: "callout", attrs: { calloutType: "tip", title: "Read me", fold: "+" } }],
    ["a", "b", "c"].map((text): Written => [text, PARAGRAPH, ["C"]]),
    more,
  );

it("copies every record under a split container's id to the fresh id, whatever it names", () => {
  const more = { "C.checked": true, "C.start": 7n };
  const copy = { checked: true, start: 7n, calloutType: "tip", title: "Read me", fold: "+" };
  const recordsOf = (doc: Y.Doc, id: string) =>
    Object.fromEntries(
      [...doc.getMap(CONTAINERS)].flatMap(([key, value]) =>
        key.startsWith(`${id}.`) ? [[key.slice(id.length + 1), value]] : [],
      ),
    );
  const lifter = open(calloutNote(more), 10);
  expect(
    written(
      lifter,
      liftBlocks(schema, lifter, 1, 1, 1, () => "later"),
    ),
  ).toBe(true);
  expect(pathsOf(lifter)).toEqual([["C"], [], ["later"]]);
  expect(lifter.getMap(CONTAINERS).get("later")).toBe("callout");
  expect(recordsOf(lifter, "later")).toEqual(copy);

  const adder = open(calloutNote(more), 20);
  const other = open(calloutNote(more), 30);
  written(adder, splitLine(schema, adder, 2, 1, String));
  written(other, liftBlocks(schema, other, 2, 1, 1, String));
  exchange(adder, other);
  expect(pathsOf(adder)).toEqual([["C"], ["C"], [], ["C"]]);
  const titled = setContainerAttributes(schema, adder, 3, 0, { title: "Danger" }, () => "own");
  expect(written(adder, titled)).toBe(true);
  expect(pathsOf(adder)).toEqual([["C"], ["C"], [], ["own"]]);
  expect(recordsOf(adder, "own")).toEqual({ ...copy, title: "Danger" });
});

it("splits a line of a list item in each of the four places section 4 names", () => {
  const baseline = () =>
    note(
      [
        { id: "L", type: "bulletList", attrs: {} },
        { id: "I", type: "listItem", attrs: {} },
      ],
      ["first", "later", "last"].map((text): Written => [text, PARAGRAPH, ["L", "I"]]),
    );
  const split = (at: number, offset: number) => {
    const doc = open(baseline(), 10);
    let asked = 0;
    const plan = splitLine(schema, doc, at, offset, () => `new${String(asked++)}`);
    written(doc, plan);
    const lines = readBody(schema, doc).map(
      (line) => `${line.path.map((container) => container.id).join("/")}:${line.text}`,
    );
    return { lines, asked, records: doc.getMap(CONTAINERS).has("new0.checked") };
  };
  expect(split(0, 2)).toEqual({
    lines: ["L/I:fi", "L/new0:rst", "L/new0:later", "L/new0:last"],
    asked: 1,
    records: true,
  });
  expect(split(0, 0)).toEqual({
    lines: ["L/new0:", "L/I:first", "L/I:later", "L/I:last"],
    asked: 1,
    records: true,
  });
  expect(split(1, 0)).toEqual({
    lines: ["L/I:first", "L/I:", "L/I:later", "L/I:last"],
    asked: 0,
    records: false,
  });
  expect(split(1, 3)).toEqual({
    lines: ["L/I:first", "L/I:lat", "L/I:er", "L/I:last"],
    asked: 0,
    records: false,
  });
});

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
    if (wrong) split.added![0]!.index++;
    written(splitter, split);
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
  ["keeps its level when the history keeps a boundary's attributes", undefined],
  [
    "loses its level, and an undo then removes other typing, on section 4's first filter",
    FAULT.recordsOnlyFilter,
  ],
] as [string, Fault | undefined][])("a heading two people's undos bring back %s", (_, fault) => {
  const { oracle, people } = team(2, plainNote(), true, fault);
  const [first, second] = people as [Person, Person];
  const send = () => deliver(people, "one by one", random(1));
  const heading = () => storedLines(second.doc)[0];
  first.kind(0, { type: "heading", level: 2 });
  send();
  second.kind(0, { type: "codeBlock" });
  send();
  first.undo();
  send();
  if (!fault) {
    second.undo();
    send();
    expect(heading()).toMatchObject({ type: "heading", level: 2, text: "abcd" });
    settled(people, oracle, true);
    return;
  }
  expect(() => second.undo()).toThrow("[7 kind] a heading boundary holds no level");
  send();
  expect(heading()).toEqual({ type: "heading", path: [], text: "abcd" });
  second.newStep();
  second.type(0, 0, "X");
  second.newStep();
  second.kind(0, { level: 3 });
  send();
  first.kind(0, { level: 4 });
  send();
  expect(() => second.undo()).toThrow("[3 undo] undo passed over a step");
  expect(heading()).toEqual({ type: "heading", level: 4, path: [], text: "abcd" });
});

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
  written(doc, splitLine(schema, doc, 0, 2, String));
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
