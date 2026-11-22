import * as Y from "yjs";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
  leavesOfSequence,
  readBodyLeaves,
  recordsOfContainer,
} from "./bodySequenceGrammar.js";
import { piecesOfSequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

export const REMOTE = Symbol("remote");
export const LOCAL = Symbol("local");
const schema = getDohcProseMirrorSchema();

export type ChangeKind =
  | "typing"
  | "letters deleted"
  | "split"
  | "join"
  | "line removed"
  | "kind of line"
  | "mark"
  | "inline item"
  | "container made"
  | "line lifted out"
  | "record"
  | "property"
  | "undo"
  | "redo"
  | "formatting cleanup"
  | "merged changes"
  | "reconnect";

export interface Change {
  readonly bytes: Uint8Array;
  readonly kind: ChangeKind;
  readonly from: number;
}

export type Token =
  | { readonly kind: "letter"; readonly unit: string }
  | { readonly kind: "boundary" | "item"; readonly element: Y.XmlElement };

export function element(name: string, attrs: Record<string, unknown>): Y.XmlElement {
  const made = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, value as string);
  return made;
}

export function tokensOf(sequence: Y.Text): Token[] {
  const tokens: Token[] = [];
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentString)
      for (const unit of content.str.split("")) tokens.push({ kind: "letter", unit });
    else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
      tokens.push({
        kind: content.type.nodeName === BLOCK_ELEMENT ? "boundary" : "item",
        element: content.type,
      });
  }
  return tokens;
}

/** What a note's Yjs document reads as, without declaring a root on it. */
export function storedReading(doc: Y.Doc): unknown {
  const sequence = doc.share.get(BODY_SEQUENCE_FIELD) as Y.Text | undefined;
  const records = doc.share.get(BODY_CONTAINERS_FIELD);
  const node = readBodyLeaves(
    schema,
    leavesOfSequence(schema, sequence ? piecesOfSequence(sequence) : [], {
      get(key) {
        const item = records?._map.get(key);
        return item && !item.deleted ? item.content.getContent()[item.length - 1] : undefined;
      },
    }),
  );
  node.check();
  return node.toJSON();
}

/** A format-2 note as the engine seeds it: letters, marks, an inline item, a to-do list and a callout. */
export function seededNote(): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  doc.getMap("meta").set("schemaVersion", 2);
  doc.getMap("frontmatter").set("status", "draft");
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  const line = (attrs: Record<string, unknown>, text: string) => {
    sequence.insertEmbed(sequence.length, element(BLOCK_ELEMENT, attrs), {});
    sequence.insert(sequence.length, text, {});
  };
  const container = (id: string, type: string, attrs: Record<string, unknown> = {}) => {
    for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
      records.set(key, value);
  };
  line({ type: "heading", level: 1, path: [] }, "Trip plan");
  line({ type: "paragraph", path: [] }, "Pack the ");
  sequence.insert(sequence.length, "bags", { bold: {} });
  sequence.insert(sequence.length, " tonight 😀", {});
  container("L", "taskList");
  container("I1", "taskItem");
  container("I2", "taskItem", { checked: true });
  line({ type: "paragraph", path: ["L", "I1"] }, "tickets");
  line({ type: "paragraph", path: ["L", "I2"] }, "passports");
  container("Q", "callout", { calloutType: "note", title: "Note", fold: "" });
  line({ type: "paragraph", path: ["Q"] }, "Gate closes at ");
  sequence.insertEmbed(sequence.length, element("mathInline", { tex: "t_0" }), {});
  line({ type: "codeBlock", language: "ts", path: [] }, "const x = 1;");
  line({ type: "paragraph", path: [] }, "The end");
  const baseline = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return baseline;
}

const LISTS = ["bulletList", "orderedList", "taskList"];
const ITEMS = ["listItem", "taskItem"];
const HOLD_BLOCKS = new Set(["blockquote", "callout", ...ITEMS]);
const lowSurrogate = (token: Token | undefined) =>
  token?.kind === "letter" && token.unit >= "\uDC00" && token.unit <= "\uDFFF";
const pathOf = (boundary: Y.XmlElement): string[] => {
  const held = boundary.getAttribute("path") as unknown;
  return Array.isArray(held) ? held.filter((id): id is string => typeof id === "string") : [];
};

export interface PersonOptions {
  readonly gc?: boolean;
  /** False for a page that stops Yjs deleting formatting on its own when other people's changes arrive. */
  readonly yjsCleanup?: boolean;
}

/**
 * One person's page on a format-2 note. It declares both roots before it applies anything, keeps
 * the history section 4 prescribes, and makes each change as section 4 says a writer does. Every
 * change it makes, Yjs's own formatting cleanup included, waits in `waiting` to be sent.
 */
export function openPerson(baseline: Uint8Array, clientID: number, options: PersonOptions = {}) {
  const doc = new Y.Doc({ gc: options.gc ?? true });
  doc.clientID = clientID;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  if (options.yjsCleanup === false)
    doc.on("afterTransaction", (transaction: Y.Transaction) => {
      transaction._needFormattingCleanup = false;
    });
  const waiting: Change[] = [];
  let doing: ChangeKind = "typing";
  let updates = 0;
  doc.on("update", (bytes: Uint8Array, origin: unknown) => {
    updates++;
    if (origin === REMOTE) return;
    waiting.push({ bytes, from: clientID, kind: origin === null ? "formatting cleanup" : doing });
  });
  Y.applyUpdate(doc, baseline, REMOTE);
  const history = new Y.UndoManager([sequence, records], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 60_000,
    ignoreRemoteMapChanges: true,
    deleteFilter: (item) => item.parent !== records,
  });
  let made = 0;
  const freshId = () => `c${String(clientID)}n${String(made++)}`;
  const change = (kind: ChangeKind, act: () => void) => {
    doing = kind;
    doc.transact(act, LOCAL);
  };
  const tokens = () => tokensOf(sequence);
  const marksAt = (index: number) => {
    const marks = new Map<string, unknown>();
    let passed = 0;
    for (let item = sequence._start; item !== null && passed < index; item = item.right) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentFormat) {
        if (item.content.value === null) marks.delete(item.content.key);
        else marks.set(item.content.key, item.content.value);
      } else if (item.countable) passed += item.length;
    }
    return Object.fromEntries(marks);
  };
  const lineAt = (all: readonly Token[], index: number): Y.XmlElement | undefined => {
    for (let at = Math.min(index, all.length) - 1; at >= 0; at--) {
      const token = all[at]!;
      if (token.kind === "boundary") return token.element;
    }
    return undefined;
  };
  const writeRecords = (id: string, type: string, attrs: Record<string, unknown> = {}) => {
    for (const [key, value] of recordsOfContainer(schema, { id, type, attrs }))
      records.set(key, value);
  };
  const typeOf = (id: string) => {
    const held = records.get(id);
    return typeof held === "string" ? held : "";
  };
  /** Section 4: a writer that changes a record of a container whose id stands on two gives this one a fresh id first. */
  const ownId = (boundary: Y.XmlElement, depth: number): string => {
    const lines = tokens().flatMap((token) => (token.kind === "boundary" ? [token.element] : []));
    const prefix = JSON.stringify(pathOf(boundary).slice(0, depth + 1));
    const id = pathOf(boundary)[depth]!;
    const shares = (line: Y.XmlElement) =>
      JSON.stringify(pathOf(line).slice(0, depth + 1)) === prefix;
    const at = lines.indexOf(boundary);
    let first = at;
    let last = at;
    while (first > 0 && shares(lines[first - 1]!)) first--;
    while (last < lines.length - 1 && shares(lines[last + 1]!)) last++;
    const elsewhere = lines.some(
      (line, index) => (index < first || index > last) && pathOf(line).includes(id),
    );
    if (!elsewhere) return id;
    const fresh = freshId();
    for (const [key] of recordsOfContainer(schema, { id, type: typeOf(id), attrs: {} })) {
      const held = records.get(key);
      const freshKey = fresh + key.slice(id.length);
      if (held !== undefined) records.set(freshKey, held);
    }
    for (const line of lines.slice(first, last + 1)) {
      const path = pathOf(line);
      path[depth] = fresh;
      line.setAttribute("path", path as unknown as string);
    }
    return fresh;
  };

  return {
    clientID,
    doc,
    sequence,
    records,
    history,
    waiting,
    tokens,
    updates: () => updates,
    receive(bytes: Uint8Array) {
      Y.applyUpdate(doc, bytes, REMOTE);
    },
    type(index: number, letters: string, marks?: Record<string, unknown>) {
      change("typing", () => {
        if (marks) sequence.insert(index, letters, { ...marksAt(index), ...marks });
        else sequence.insert(index, letters);
      });
    },
    deleteLetters(index: number, length: number) {
      change("letters deleted", () => sequence.delete(index, length));
    },
    split(index: number) {
      const all = tokens();
      const startsALineThatHoldsSomething =
        all[index - 1]?.kind === "boundary" &&
        all[index] !== undefined &&
        all[index].kind !== "boundary";
      const place = startsALineThatHoldsSomething ? index - 1 : index;
      const line = lineAt(all, index);
      change("split", () => {
        const path = line ? pathOf(line) : [];
        const last = path.at(-1);
        if (last !== undefined && ITEMS.includes(typeOf(last))) {
          const item = freshId();
          writeRecords(item, typeOf(last));
          path[path.length - 1] = item;
        }
        sequence.insertEmbed(
          place,
          element(BLOCK_ELEMENT, { type: "paragraph", path }),
          marksAt(place),
        );
      });
    },
    join(index: number) {
      change("join", () => sequence.delete(index, 1));
    },
    removeLine(index: number) {
      const all = tokens();
      let length = 1;
      while (all[index + length] !== undefined && all[index + length]!.kind !== "boundary")
        length++;
      change("line removed", () => sequence.delete(index, length));
    },
    setKind(boundary: Y.XmlElement, attrs: Record<string, unknown>) {
      change("kind of line", () => {
        for (const [key, value] of Object.entries(attrs))
          boundary.setAttribute(key, value as string);
      });
    },
    mark(index: number, length: number, name: string, value: unknown) {
      change("mark", () => sequence.format(index, length, { [name]: value }));
    },
    insertItem(index: number, name: string, attrs: Record<string, unknown>) {
      change("inline item", () =>
        sequence.insertEmbed(index, element(name, attrs), marksAt(index)),
      );
    },
    changeItem(item: Y.XmlElement, key: string, value: unknown) {
      change("inline item", () => item.setAttribute(key, value as string));
    },
    deleteItem(index: number) {
      change("inline item", () => sequence.delete(index, 1));
    },
    wrap(boundary: Y.XmlElement, type: string) {
      change("container made", () => {
        const path = pathOf(boundary);
        const id = freshId();
        writeRecords(id, type);
        path.push(id);
        if (LISTS.includes(type)) {
          const item = freshId();
          writeRecords(item, type === "taskList" ? "taskItem" : "listItem");
          path.push(item);
        }
        boundary.setAttribute("path", path as unknown as string);
      });
    },
    liftOut(boundary: Y.XmlElement) {
      change("line lifted out", () => {
        const path = pathOf(boundary);
        const kept = path.slice(0, ITEMS.includes(typeOf(path.at(-1) ?? "")) ? -2 : -1);
        boundary.setAttribute("path", kept as unknown as string);
      });
    },
    changeRecord(boundary: Y.XmlElement, depth: number, next: () => number) {
      change("record", () => {
        const id = ownId(boundary, depth);
        const type = typeOf(id);
        if (type === "taskItem")
          records.set(`${id}.checked`, records.get(`${id}.checked`) !== true);
        else if (LISTS.includes(type)) {
          if (next() < 0.5) records.set(id, LISTS[(LISTS.indexOf(type) + 1) % LISTS.length]!);
          else records.set(`${id}.start`, 1 + Math.floor(next() * 9));
        } else if (type === "callout") {
          if (next() < 0.5) records.set(`${id}.title`, `Note ${String(Math.floor(next() * 9))}`);
          else records.set(id, "blockquote");
        } else if (type === "blockquote") records.set(id, "callout");
        else if (type === "listItem") records.set(id, "taskItem");
      });
    },
    setProperty(value: string) {
      change("property", () => doc.getMap("frontmatter").set("status", value));
    },
    undo() {
      doing = "undo";
      history.undo();
    },
    redo() {
      doing = "redo";
      history.redo();
    },
    canWrap(boundary: Y.XmlElement) {
      const path = pathOf(boundary);
      const last = path.at(-1);
      return path.length < 6 && (last === undefined || HOLD_BLOCKS.has(typeOf(last)));
    },
  };
}
export type Person = ReturnType<typeof openPerson>;

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const LETTERS = ["a", "e", "k", "é", " ", "ж", "😀"];
const MARKS: [string, unknown][] = [
  ["bold", {}],
  ["italic", {}],
  ["code", {}],
  ["link", { href: "https://example.com", title: null }],
];
const KINDS: Record<string, unknown>[] = [
  { type: "paragraph" },
  { type: "heading", level: 2 },
  { type: "codeBlock", language: "ts" },
];
const WRAPS = ["blockquote", "callout", "bulletList", "orderedList", "taskList"];
const ITEMS_TO_INSERT: [string, Record<string, unknown>][] = [
  ["mathInline", { tex: "x^2" }],
  ["hardBreak", {}],
  ["image", { src: "https://example.com/a.png", alt: "a", title: null }],
  ["wikilink", { target: "Page", label: null }],
];

/** One change by one person, picked at random among those a person can make on the note as they see it. */
export function randomChange(who: Person, next: () => number): void {
  const pick = (below: number) => Math.floor(next() * below);
  const all = who.tokens();
  const places = (kind: Token["kind"]) =>
    all.flatMap((token, index) => (token.kind === kind ? [index] : []));
  const boundaries = places("boundary");
  const letters = places("letter");
  const items = places("item");
  const first = all[0]?.kind === "boundary" ? 1 : 0;
  const between = () => {
    let at = first + pick(all.length - first + 1);
    while (lowSurrogate(all[at])) at++;
    return at;
  };
  const range = (most: number) => {
    let at = pick(all.length);
    if (lowSurrogate(all[at])) at--;
    let length = 1 + pick(most);
    while (at + length < all.length && lowSurrogate(all[at + length])) length++;
    return { at, length: Math.min(length, all.length - at) };
  };
  const elementAt = (index: number) =>
    (all[index] as Extract<Token, { element: Y.XmlElement }>).element;
  if (next() < 0.3) who.history.stopCapturing();
  const roll = next();
  if (roll < 0.18) {
    const marks = next() < 0.25 ? MARKS[pick(MARKS.length)]! : undefined;
    const text = Array.from({ length: 1 + pick(3) }, () => LETTERS[pick(LETTERS.length)]!).join("");
    who.type(between(), text, marks && { [marks[0]]: next() < 0.7 ? marks[1] : null });
  } else if (roll < 0.28) who.split(between());
  else if (roll < 0.36 && boundaries.length > 1)
    who.join(boundaries[1 + pick(boundaries.length - 1)]!);
  else if (roll < 0.39 && boundaries.length > 1)
    who.removeLine(boundaries[1 + pick(boundaries.length - 1)]!);
  else if (roll < 0.46 && letters.length > 0) {
    let at = letters[pick(letters.length)]!;
    if (lowSurrogate(all[at])) at--;
    let length = 1;
    while (
      all[at + length]?.kind === "letter" &&
      (lowSurrogate(all[at + length]) || (length < 3 && next() < 0.5))
    )
      length++;
    who.deleteLetters(at, length);
  } else if (roll < 0.52 && boundaries.length > 0)
    who.setKind(elementAt(boundaries[pick(boundaries.length)]!), KINDS[pick(KINDS.length)]!);
  else if (roll < 0.64 && all.length > 1) {
    const { at, length } = range(8);
    const [name, value] = MARKS[pick(MARKS.length)]!;
    who.mark(at, length, name, next() < 0.65 ? value : null);
  } else if (roll < 0.69) {
    if (items.length > 0 && next() < 0.5) {
      const at = items[pick(items.length)]!;
      const item = elementAt(at);
      if (item.nodeName === "mathInline" && next() < 0.6)
        who.changeItem(item, "tex", `y_${String(pick(9))}`);
      else who.deleteItem(at);
    } else {
      const [name, attrs] = ITEMS_TO_INSERT[pick(ITEMS_TO_INSERT.length)]!;
      who.insertItem(between(), name, attrs);
    }
  } else if (roll < 0.84 && boundaries.length > 0) {
    const boundary = elementAt(boundaries[pick(boundaries.length)]!);
    const path = pathOf(boundary);
    const which = next();
    if (path.length > 0 && which < 0.6) who.changeRecord(boundary, pick(path.length), next);
    else if (path.length > 0 && which < 0.75) who.liftOut(boundary);
    else if (who.canWrap(boundary)) who.wrap(boundary, WRAPS[pick(WRAPS.length)]!);
  } else if (roll < 0.86) who.setProperty(`s${String(pick(9))}`);
  else if (roll < 0.95) {
    who.undo();
    if (next() < 0.4) who.redo();
  } else who.redo();
}

export type Arrive = "one by one" | "merged" | "after a reconnect";
export const ARRIVALS: readonly Arrive[] = ["one by one", "merged", "after a reconnect"];

/** Where every change goes first. It answers with the bytes it passes on to everyone else. */
export interface Hub {
  vector(): Uint8Array;
  missingFor(vector: Uint8Array): Uint8Array;
  take(change: Change): Uint8Array;
}

/** Sends what everyone has waiting through the hub, and on to the others, until nobody has more. */
export function deliver(
  people: readonly Person[],
  hub: Hub,
  arrive: Arrive,
  next: () => number,
  alsoReceives: readonly { receive(bytes: Uint8Array): void }[] = [],
): void {
  const passOn = (bytes: Uint8Array, from: number) => {
    for (const each of people) if (each.clientID !== from) each.receive(bytes);
    for (const each of alsoReceives) each.receive(bytes);
  };
  if (arrive === "after a reconnect") {
    for (let moved = true; moved;) {
      moved = false;
      for (const each of people) {
        if (each.waiting.length > 0) {
          each.waiting.length = 0;
          const bytes = Y.encodeStateAsUpdate(each.doc, hub.vector());
          const taken = hub.take({ bytes, kind: "reconnect", from: each.clientID });
          for (const other of alsoReceives) other.receive(taken);
          moved = true;
        }
        const before = each.updates();
        each.receive(hub.missingFor(Y.encodeStateVector(each.doc)));
        if (each.updates() !== before) moved = true;
      }
    }
    return;
  }
  for (;;) {
    const senders = people.filter((each) => each.waiting.length > 0);
    if (senders.length === 0) return;
    if (arrive === "merged")
      for (const each of senders) {
        const several = each.waiting.splice(0);
        each.waiting.push(
          several.length === 1
            ? several[0]!
            : {
                bytes: Y.mergeUpdates(several.map((one) => one.bytes)),
                kind: "merged changes",
                from: each.clientID,
              },
        );
      }
    const from = senders[Math.floor(next() * senders.length)]!;
    const sent = from.waiting.shift()!;
    passOn(hub.take(sent), from.clientID);
  }
}
