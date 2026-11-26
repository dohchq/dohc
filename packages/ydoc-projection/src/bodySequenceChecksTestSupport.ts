import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";
import { BLOCK_ELEMENT, BODY_CONTAINERS_FIELD, BODY_SEQUENCE_FIELD } from "./bodySequenceStore.js";

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

/** What a note's Yjs document reads as, checked against the schema. */
export function storedReading(doc: Y.Doc): unknown {
  const node = readBodySequence(schema, doc);
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
  { type: "paragraph" },
  { type: "horizontalRule" },
  { type: "mathBlock", tex: "x^2" },
  { type: "rawBlock", source: "<aside>kept as written</aside>" },
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

/** One struct as a client could send it, which no editor would. */
export type SentStruct =
  | {
      readonly client: number;
      readonly clock: number;
      readonly origin?: Y.ID;
      readonly rightOrigin?: Y.ID;
      readonly parent?: string | Y.ID;
      readonly key?: string;
      readonly content: Y.Item["content"];
    }
  | {
      readonly client: number;
      readonly clock: number;
      /** A struct sent as already collected, this many clocks long. */
      readonly collected: number;
    };

/** Content written to the wire as the bytes given, for values no Yjs client writes. */
export function contentAsWritten(
  ref: number,
  countable: boolean,
  write: (encoder: Y.UpdateEncoderV1) => void,
): Y.Item["content"] {
  return {
    getRef: () => ref,
    getLength: () => 1,
    isCountable: () => countable,
    write,
  } as unknown as Y.Item["content"];
}

/** A value in Yjs's `any` encoding, given as its bytes. */
export const anyAsWritten = (bytes: readonly number[]) =>
  contentAsWritten(8, true, (encoder) => {
    encoder.writeLen(1);
    encoding.writeUint8Array(encoder.restEncoder, Uint8Array.from(bytes));
  });

/** A mark whose value is the JSON text given. */
export const markAsWritten = (key: string, json: string) =>
  contentAsWritten(6, false, (encoder) => {
    encoder.writeKey(key);
    encoding.writeVarString(encoder.restEncoder, json);
  });

/**
 * An update holding exactly these structs and deletes. Each client's structs are in clock order.
 * A string named in `bytesFor` is written as those bytes, for text no encoder would write.
 */
export function updateOf(
  structs: readonly SentStruct[],
  deletes: readonly (readonly [client: number, clock: number, length: number])[] = [],
  bytesFor: ReadonlyMap<string, readonly number[]> = new Map(),
): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  const writeString = encoder.writeString.bind(encoder);
  const written = (text: string) => {
    const bytes = bytesFor.get(text);
    if (bytes) encoding.writeVarUint8Array(encoder.restEncoder, Uint8Array.from(bytes));
    else writeString(text);
  };
  encoder.writeString = written;
  encoder.writeKey = written;
  const byClient = new Map<number, SentStruct[]>();
  for (const struct of structs) {
    const held = byClient.get(struct.client);
    if (held) held.push(struct);
    else byClient.set(struct.client, [struct]);
  }
  encoding.writeVarUint(encoder.restEncoder, byClient.size);
  for (const client of [...byClient.keys()].sort((a, b) => b - a)) {
    const sent = byClient.get(client)!;
    encoding.writeVarUint(encoder.restEncoder, sent.length);
    encoder.writeClient(client);
    encoding.writeVarUint(encoder.restEncoder, sent[0]!.clock);
    for (const struct of sent)
      if ("collected" in struct)
        new Y.GC(Y.createID(client, struct.clock), struct.collected).write(encoder, 0);
      else
        new Y.Item(
          Y.createID(client, struct.clock),
          null,
          struct.origin ?? null,
          null,
          struct.rightOrigin ?? null,
          (struct.parent ?? null) as Y.ID | null,
          struct.key ?? null,
          struct.content,
        ).write(encoder, 0);
  }
  const deletedBy = new Map<number, (readonly [number, number, number])[]>();
  for (const range of deletes) {
    const held = deletedBy.get(range[0]);
    if (held) held.push(range);
    else deletedBy.set(range[0], [range]);
  }
  encoding.writeVarUint(encoder.restEncoder, deletedBy.size);
  for (const [client, ranges] of deletedBy) {
    encoder.resetDsCurVal();
    encoding.writeVarUint(encoder.restEncoder, client);
    encoding.writeVarUint(encoder.restEncoder, ranges.length);
    for (const [, clock, length] of ranges) {
      encoder.writeDsClock(clock);
      encoder.writeDsLen(length);
    }
  }
  return encoder.toUint8Array();
}

/** An update that skips some of one editor's clocks and holds nothing else. */
export function skipOf(client: number, clock: number, length: number): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoding.writeVarUint(encoder.restEncoder, 1);
  encoder.writeClient(client);
  encoding.writeVarUint(encoder.restEncoder, clock);
  new Y.Skip(Y.createID(client, clock), length).write(encoder, 0);
  encoding.writeVarUint(encoder.restEncoder, 0);
  return encoder.toUint8Array();
}

/** What one transaction on a page with this client id sends, or undefined if it changes nothing. */
export function changeMadeBy(
  note: Uint8Array,
  client: number,
  change: (page: { doc: Y.Doc; sequence: Y.Text; records: Y.Map<unknown> }) => void,
): Uint8Array | undefined {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = client;
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  Y.applyUpdate(doc, note);
  let sent: Uint8Array | undefined;
  doc.on("update", (bytes: Uint8Array) => {
    sent = bytes;
  });
  doc.transact(() => change({ doc, sequence, records }));
  doc.destroy();
  return sent;
}

type Page = { doc: Y.Doc; sequence: Y.Text; records: Y.Map<unknown> };

/** One place in a note where a change can put a value, such as an attribute of a node. */
export interface Place {
  readonly name: string;
  /** Places that change what kind a node is; putting a value there changes what the others mean. */
  readonly changesKinds: boolean;
  put(page: Page, value: unknown): void;
}

const CONTAINERS_TO_HOLD: readonly (readonly [id: string, kind: string])[][] = [
  [["q", "blockquote"]],
  [["c", "callout"]],
  [
    ["bl", "bulletList"],
    ["bi", "listItem"],
  ],
  [
    ["ol", "orderedList"],
    ["oi", "listItem"],
  ],
  [
    ["tl", "taskList"],
    ["ti", "taskItem"],
  ],
  [
    ["t", "table"],
    ["r", "tableRow"],
    ["d", "tableCell"],
  ],
  [
    ["t2", "table"],
    ["r2", "tableRow"],
    ["h", "tableHeader"],
  ],
];

/**
 * A format-2 note with no properties that holds one of every node and mark the schema has, and
 * every place a change can put a value in it: each attribute of each node and mark, each
 * container's kind, a line's kind and path, and the letters of each kind of line.
 */
export function noteWithEveryNode(): { note: Uint8Array; places: readonly Place[] } {
  const attributesOf = (name: string) =>
    Object.keys((schema.nodes[name] ?? schema.marks[name])?.spec.attrs ?? {});
  const leafKinds = Object.values(schema.nodes)
    .filter(
      (type) => type.isBlock && type !== schema.topNodeType && (type.isTextblock || type.isLeaf),
    )
    .map((type) => type.name);
  const inlineKinds = Object.values(schema.nodes)
    .filter((type) => type.isInline && type.isLeaf && !type.isText)
    .map((type) => type.name);
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  doc.getMap("meta").set("schemaVersion", 2);
  doc.getMap("frontmatter");
  const sequence = doc.getText(BODY_SEQUENCE_FIELD);
  const records = doc.getMap<unknown>(BODY_CONTAINERS_FIELD);
  const line = (attrs: Record<string, unknown>, text: string) => {
    sequence.insertEmbed(sequence.length, element(BLOCK_ELEMENT, { path: [], ...attrs }), {});
    sequence.insert(sequence.length, text, {});
  };
  for (const kind of leafKinds) line({ type: kind }, "text");
  line({ type: "paragraph" }, "items ");
  for (const kind of inlineKinds) sequence.insertEmbed(sequence.length, new Y.XmlElement(kind), {});
  line({ type: "paragraph" }, "marked letters");
  for (const path of CONTAINERS_TO_HOLD) {
    for (const [id, type] of path)
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        records.set(key, value);
    line({ type: "paragraph", path: path.map(([id]) => id) }, `in ${path.at(-1)![1]}`);
  }
  const note = Y.encodeStateAsUpdate(doc);
  doc.destroy();

  const boundary = (page: Page, index: number) =>
    tokensOf(page.sequence).filter((token) => token.kind === "boundary")[index] as Extract<
      Token,
      { element: Y.XmlElement }
    >;
  const startOfLine = (page: Page, index: number) => {
    const all = tokensOf(page.sequence);
    let seen = -1;
    return all.findIndex((token) => token.kind === "boundary" && ++seen === index) + 1;
  };
  const inlineItem = (page: Page, kind: string) =>
    tokensOf(page.sequence).find(
      (token) => token.kind === "item" && token.element.nodeName === kind,
    ) as Extract<Token, { element: Y.XmlElement }>;
  const places: Place[] = [];
  const place = (name: string, put: Place["put"], changesKinds = false) =>
    places.push({ name, put, changesKinds });
  leafKinds.forEach((kind, index) => {
    for (const attribute of attributesOf(kind))
      place(`${kind}.${attribute}`, (page, value) =>
        boundary(page, index).element.setAttribute(attribute, value as string),
      );
    place(`the letters of a ${kind}`, (page, value) => {
      if (typeof value === "string" && value !== "")
        page.sequence.insert(startOfLine(page, index), value);
    });
  });
  for (const kind of inlineKinds)
    for (const attribute of attributesOf(kind))
      place(`${kind}.${attribute}`, (page, value) =>
        inlineItem(page, kind).element.setAttribute(attribute, value as string),
      );
  const marked = leafKinds.length + 1;
  Object.keys(schema.marks).forEach((mark, index) => {
    const attributes = attributesOf(mark);
    const on = (page: Page, value: unknown) =>
      page.sequence.format(startOfLine(page, marked) + index, 3, { [mark]: value });
    if (attributes.length === 0) place(`the mark ${mark}`, on);
    for (const attribute of attributes)
      place(`${mark}.${attribute}`, (page, value) => on(page, { [attribute]: value }));
  });
  for (const [id, kind] of CONTAINERS_TO_HOLD.flat()) {
    for (const attribute of attributesOf(kind))
      place(`${kind}.${attribute}`, (page, value) => page.records.set(`${id}.${attribute}`, value));
    place(`the kind of a ${kind}`, (page, value) => page.records.set(id, value), true);
  }
  place(
    "the kind of a line",
    (page, value) => boundary(page, 0).element.setAttribute("type", value as string),
    true,
  );
  place(
    "the path of a line",
    (page, value) =>
      boundary(page, 1).element.setAttribute("path", [value, "q", value] as unknown as string),
    true,
  );
  return { note, places };
}

/** Text a Markdown writer or reader could trip on, for every place a note can hold a string. */
export const HOSTILE_STRINGS: readonly string[] = [
  "\n",
  "\r",
  "\r\n",
  "a\nb",
  "a\r\nb",
  "a\n\n\nb",
  "\n# not a heading",
  "`",
  "``",
  "```",
  "`".repeat(40),
  "~~~",
  "```\ncode\n```",
  "[",
  "]",
  "[[",
  "]]",
  "](",
  "![",
  "[x](y)",
  "[^1]",
  "|",
  "a | b",
  "| a | b |\n| - | - |",
  ">",
  ">".repeat(130),
  "> ".repeat(130),
  `\n${"> ".repeat(130)}x`,
  "\\",
  "*",
  "**bold**",
  "_",
  "$",
  "$$",
  "$$\nx\n$$",
  "<",
  "<script>alert(1)</script>",
  "</div>",
  "<!--",
  "&amp;",
  "#",
  "---",
  "---\na: b\n---",
  "***",
  ":::",
  "==",
  "~~",
  "- [ ] x",
  "1. x",
  "> [!note] x",
  "\u0000",
  "\u2028",
  "\u2029",
  "a\u2028b",
  "\u0085",
  "\v",
  "\f",
  "\t",
  " ",
  "  two spaces each side  ",
  "\uE000",
  "\uE001",
  "\uE000DOHCCHARACTER0\uE001",
  "\uE000DOHC_CODE_BLOCK_0\uE001",
  "\uE000DOHCBLOCK_ESCAPE_0\uE001",
  "\uE000DOHC_PARSE_0\uE001",
  "😀",
  "x".repeat(50_000),
];

const deepValue = (levels: number): unknown => (levels === 0 ? null : [deepValue(levels - 1)]);

/** Single changes two reviews measured: each is under 2 MiB and cost the room's check seconds. */
export const COSTLY_CHANGES: readonly (readonly [name: string, change: (page: Page) => void])[] = [
  [
    "1,900,000 nulls in one record",
    ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 1_900_000 }, () => null),
      ),
  ],
  [
    "1,300,000 nulls in one record",
    ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 1_300_000 }, () => null),
      ),
  ],
  [
    "400,000 nulls in one record",
    ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 400_000 }, () => null),
      ),
  ],
  [
    "7,000 values, each nested 127 deep, in one record",
    ({ records }) =>
      records.set(
        "X.title",
        Array.from({ length: 7_000 }, () => deepValue(127)),
      ),
  ],
  [
    "one record with 200,000 keys",
    ({ records }) =>
      records.set(
        "X.title",
        Object.fromEntries(
          Array.from({ length: 200_000 }, (_, index) => [`k${String(index)}`, null]),
        ),
      ),
  ],
  [
    "60,000 maps, each inside the one before, under frontmatter",
    ({ doc }) => {
      let map = new Y.Map<unknown>();
      doc.getMap("frontmatter").set("deep", map);
      for (let level = 1; level < 60_000; level++) {
        const inner = new Y.Map<unknown>();
        map.set("in", inner);
        map = inner;
      }
    },
  ],
];

interface Written {
  readonly insert: string | Y.XmlElement;
  readonly attributes: Record<string, unknown>;
}

/**
 * Writes these at the end of the sequence in one pass. Yjs walks a text from its start for each
 * insert that names its marks, so ten thousand lines written one insert at a time take it seconds.
 */
const writeAtTheEnd = (sequence: Y.Text, written: readonly Written[]) =>
  sequence.applyDelta([{ retain: sequence.length }, ...written]);

const todosWithLinks =
  (count: number) =>
  ({ sequence, records }: Page) => {
    for (const [key, value] of recordsOfContainer(schema, {
      id: "sl",
      type: "taskList",
      attrs: {},
    }))
      records.set(key, value);
    const lines: Written[] = [];
    for (let line = 0; line < count; line++) {
      const item = `si${String(line)}`;
      for (const [key, value] of recordsOfContainer(schema, {
        id: item,
        type: "taskItem",
        attrs: {},
      }))
        records.set(key, value);
      lines.push(
        {
          insert: element(BLOCK_ELEMENT, { type: "paragraph", path: ["sl", item] }),
          attributes: {},
        },
        { insert: "see ", attributes: {} },
        {
          insert: `page ${String(line)}`,
          attributes: {
            link: {
              href: `https://example.com/pages/${String(line)}`,
              target: "_blank",
              rel: "noopener noreferrer nofollow",
              class: null,
              title: null,
            },
          },
        },
        { insert: " today", attributes: { link: null } },
      );
    }
    writeAtTheEnd(sequence, lines);
  };

/**
 * Single changes a person's editor can honestly send, each as large as that kind gets, with what
 * each was measured to hold. The last is larger than the 2 MiB a relay takes as one change.
 */
export const LARGE_HONEST_CHANGES: readonly (readonly [
  name: string,
  change: (page: Page) => void,
  holds: { readonly bytes: number; readonly values: number; readonly structs: number },
])[] = [
  [
    "a pasted table of 1,000 cells",
    ({ sequence, records }) => {
      const write = (id: string, type: string) => {
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          records.set(key, value);
      };
      write("pt", "table");
      for (let row = 0; row < 100; row++) {
        write(`pr${String(row)}`, "tableRow");
        for (let column = 0; column < 10; column++) {
          const cell = `pc${String(row)}x${String(column)}`;
          write(cell, row === 0 ? "tableHeader" : "tableCell");
          sequence.insertEmbed(
            sequence.length,
            element(BLOCK_ELEMENT, { type: "paragraph", path: ["pt", `pr${String(row)}`, cell] }),
            {},
          );
          sequence.insert(sequence.length, `cell ${String(row)}.${String(column)}`, {});
        }
      }
    },
    { bytes: 235_965, values: 10_201, structs: 9_201 },
  ],
  [
    "10,000 plain lines seeded at once",
    ({ sequence }) =>
      writeAtTheEnd(
        sequence,
        Array.from({ length: 10_000 }, (_, line): Written[] => [
          { insert: element(BLOCK_ELEMENT, { type: "paragraph", path: [] }), attributes: {} },
          { insert: `line ${String(line)}`, attributes: {} },
        ]).flat(),
      ),
    { bytes: 633_009, values: 20_000, structs: 40_000 },
  ],
  [
    "6,800 to-dos seeded at once, each with a link",
    todosWithLinks(6_800),
    { bytes: 2_081_149, values: 88_404, structs: 68_004 },
  ],
  [
    "one line 64 containers deep",
    ({ sequence, records }) => {
      const path = Array.from({ length: 64 }, (_, depth) => `d${String(depth)}`);
      for (const id of path)
        for (const [key, value] of recordsOfContainer(schema, {
          id,
          type: "blockquote",
          attrs: {},
        }))
          records.set(key, value);
      sequence.insertEmbed(
        sequence.length,
        element(BLOCK_ELEMENT, { type: "paragraph", path }),
        {},
      );
      sequence.insert(sequence.length, "deep", {});
    },
    { bytes: 7_818, values: 322, structs: 260 },
  ],
  [
    "a cell with 1,000 column widths",
    ({ records }) =>
      records.set(
        "wide.colwidth",
        Array.from({ length: 1_000 }, (_, index) => 80 + index),
      ),
    { bytes: 3_036, values: 1_001, structs: 1 },
  ],
  [
    "10,000 to-dos seeded at once, each with a link",
    todosWithLinks(10_000),
    { bytes: 3_064_554, values: 130_004, structs: 100_004 },
  ],
];
