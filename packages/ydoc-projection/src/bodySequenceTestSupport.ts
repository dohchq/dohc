import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { baseKeymap, setBlockType, toggleMark } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import type { Attrs, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Plugin } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import {
  BLOCK_ELEMENT,
  BODY_CONTAINERS_FIELD,
  BODY_SEQUENCE_FIELD,
} from "./bodySequenceGrammar.js";
import {
  bodySequencePlugin,
  createBodySequenceHistory,
  isBodySequenceChange,
} from "./bodySequenceEditor.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import { getDohcProseMirrorSchema } from "./import-export.js";

export const REMOTE = Symbol("remote");
export const schema = getDohcProseMirrorSchema();

type Id = string;
const idOf = (client: number, clock: number): Id => `${String(client)}:${String(clock)}`;

export type ElementToken = { kind: "boundary" | "item"; id: Id; name: string; attrs: string };
export type Token = { kind: "letter"; id: Id; text: string; marks: string } | ElementToken;

const sorted = (attrs: Record<string, unknown>) =>
  JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)));

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Every letter, boundary and inline item of a sequence, in order, by the id of its Yjs item. */
export function tokensOf(sequence: Y.Text): Token[] {
  const tokens: Token[] = [];
  const marks = new Map<string, unknown>();
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const content = item.content;
    if (content instanceof Y.ContentFormat) marks.set(content.key, content.value);
    else if (content instanceof Y.ContentString) {
      const on = [...marks]
        .filter(([, value]) => isPlainObject(value))
        .map(([key]) => key)
        .sort()
        .join(",");
      for (let at = 0; at < content.str.length; at++)
        tokens.push({
          kind: "letter",
          id: idOf(item.id.client, item.id.clock + at),
          text: content.str[at]!,
          marks: on,
        });
    } else if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
      tokens.push({
        kind: content.type.nodeName === BLOCK_ELEMENT ? "boundary" : "item",
        id: idOf(item.id.client, item.id.clock),
        name: content.type.nodeName,
        attrs: sorted(content.type.getAttributes()),
      });
  }
  return tokens;
}

/** The boundaries of a sequence, or its inline items, in order. */
export function elementsOf(sequence: Y.Text, kind: ElementToken["kind"]): ElementToken[] {
  return tokensOf(sequence).filter((token): token is ElementToken => token.kind === kind);
}

type Kind = "letters" | "boundaries" | "items" | "formats" | "attributes";
export type Counts = Record<Kind, number>;
export const quiet = (): Counts => ({
  letters: 0,
  boundaries: 0,
  items: 0,
  formats: 0,
  attributes: 0,
});

function kindOf(item: Y.Item): Kind | null {
  const content = item.content;
  if (content instanceof Y.ContentAny) return "attributes";
  if (content instanceof Y.ContentString) return "letters";
  if (content instanceof Y.ContentFormat) return "formats";
  if (content instanceof Y.ContentType && content.type instanceof Y.XmlElement)
    return content.type.nodeName === BLOCK_ELEMENT ? "boundaries" : "items";
  return null;
}

function inventory(sequence: Y.Text): Map<Id, Kind> {
  const found = new Map<Id, Kind>();
  for (let item = sequence._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const kind = kindOf(item);
    if (kind === null) continue;
    for (let at = 0; at < item.length; at++)
      found.set(idOf(item.id.client, item.id.clock + at), kind);
    if (item.content instanceof Y.ContentType)
      for (const attribute of (item.content.type as Y.XmlElement)._map.values())
        if (!attribute.deleted)
          found.set(idOf(attribute.id.client, attribute.id.clock), "attributes");
  }
  return found;
}

export type Effects = {
  /** Items the change made, by kind. */
  made: Counts;
  /** Items the change deleted, by kind. */
  gone: Counts;
  /** Items made or deleted that are none of those kinds, or made and deleted at once. */
  other: number;
  goneLetters: string;
  madeLetters: string;
  goneBoundaries: Id[];
  madeBoundaries: Id[];
  /** How many times the editor was changed to show the sequence while the action ran. */
  shown: number;
};

const stops: (() => void)[] = [];
export function onStop(stop: () => void) {
  stops.push(stop);
}
export function stopEveryone() {
  for (const stop of stops.splice(0).reverse()) stop();
}

export function element(name: string, attributes: Record<string, unknown>): Y.XmlElement {
  const made = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) made.setAttribute(key, value as string);
  return made;
}

export const boundary = (attributes: Record<string, unknown> = {}) =>
  element(BLOCK_ELEMENT, { type: "paragraph", path: [], ...attributes });

/** A note's Yjs document with the sequence and the records declared, as an editor declares them. */
export function declared(clientID: number) {
  const doc = new Y.Doc();
  doc.clientID = clientID;
  return {
    doc,
    sequence: doc.getText(BODY_SEQUENCE_FIELD),
    containers: doc.getMap<unknown>(BODY_CONTAINERS_FIELD),
  };
}

/** A note written by `write`, as one update. */
export function noteOf(write: (made: ReturnType<typeof declared>) => void): Uint8Array {
  const made = declared(1);
  write(made);
  const baseline = Y.encodeStateAsUpdate(made.doc);
  made.doc.destroy();
  return baseline;
}

/** A note with one paragraph per line. */
export function note(...lines: string[]): Uint8Array {
  return noteOf(({ sequence }) => {
    for (const line of lines) {
      sequence.insertEmbed(sequence.length, boundary(), {});
      sequence.insert(sequence.length, line, {});
    }
  });
}

/**
 * How the host runs a person's change: `bare` as the phone does, with no Yjs transaction of its
 * own, or `hosted` as the share page's session does, inside a Yjs transaction with no origin. A
 * hosted page also takes other people's changes inside such a transaction.
 */
export type HostShape = "bare" | "hosted";

/** A document on the sequence with no editor, changed as a page or an agent changes it. */
export function page(baseline: Uint8Array, clientID: number, shape: HostShape = "bare") {
  const made = declared(clientID);
  Y.applyUpdate(made.doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  const received = new WeakSet<Y.Transaction>();
  made.doc.on(
    "update",
    (update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
      if (origin !== REMOTE && !received.has(transaction)) sent.push(update);
    },
  );
  stops.push(() => made.doc.destroy());
  return {
    ...made,
    sent,
    receive(update: Uint8Array) {
      if (shape === "bare") Y.applyUpdate(made.doc, update, REMOTE);
      else
        made.doc.transact((transaction) => {
          received.add(transaction);
          Y.applyUpdate(made.doc, update);
        });
    },
  };
}

export type Page = ReturnType<typeof page>;

/** A person at a plain ProseMirror editor bound to the sequence. */
export function person(
  baseline: Uint8Array,
  clientID: number,
  shape: HostShape = "bare",
  plugins: Plugin[] = [],
  pluginsBefore: Plugin[] = [],
) {
  const base = page(baseline, clientID, shape);
  const mount = window.document.createElement("div");
  window.document.body.append(mount);
  const history = createBodySequenceHistory(base.doc, { captureTimeout: 0 });
  const shown = { count: 0 };
  const view = new EditorView(mount, {
    state: EditorState.create({
      schema,
      plugins: [
        ...pluginsBefore,
        bodySequencePlugin({ sequence: base.sequence, containers: base.containers, history }),
        keymap(baseKeymap),
        ...plugins,
      ],
    }),
    dispatchTransaction(this: EditorView, transaction) {
      const apply = () => this.updateState(this.state.apply(transaction));
      if (isBodySequenceChange(transaction)) shown.count += 1;
      if (shape === "hosted" && transaction.docChanged && !isBodySequenceChange(transaction))
        base.doc.transact(apply);
      else apply();
    },
  });
  stops.push(() => {
    view.destroy();
    history.destroy();
    mount.remove();
  });
  return withEditor({ ...base, history, view, shown });
}

export type Person = ReturnType<typeof person>;

function leafBlocks(doc: ProseMirrorNode): { node: ProseMirrorNode; pos: number }[] {
  const found: { node: ProseMirrorNode; pos: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isBlock) return false;
    if (!node.isTextblock && !node.isLeaf) return true;
    found.push({ node, pos });
    return false;
  });
  return found;
}

export function withEditor(
  base: Page & { view: EditorView; history: Y.UndoManager; shown: { count: number } },
) {
  const { doc, sequence, view } = base;
  const start = (line: number) => leafBlocks(view.state.doc)[line]!.pos + 1;
  const select = (from: [number, number], to: [number, number] = from) =>
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, start(from[0]) + from[1], start(to[0]) + to[1]),
      ),
    );
  const press = (key: string, modifiers: KeyboardEventInit = {}) => {
    const event = new window.KeyboardEvent("keydown", { key, ...modifiers });
    return view.someProp("handleKeyDown", (handle) => handle(view, event)) === true;
  };
  return {
    ...base,
    /** The text of each block that holds no blocks, in document order. */
    lines: () => leafBlocks(view.state.doc).map(({ node }) => node.textContent),
    blocks: () =>
      leafBlocks(view.state.doc).map(({ node }) =>
        node.type.name === "heading" ? `h${String(node.attrs.level)}` : node.type.name,
      ),
    select,
    press,
    type(letters: string) {
      for (const letter of letters) view.dispatch(view.state.tr.insertText(letter));
    },
    typeAt(line: number, offset: number, letters: string) {
      select([line, offset]);
      this.type(letters);
    },
    join(line: number) {
      select([line, 0]);
      if (!press("Backspace")) throw new Error("Backspace did nothing");
    },
    split(line: number, offset: number) {
      select([line, offset]);
      if (!press("Enter")) throw new Error("Enter did nothing");
    },
    undo: () => press("z", { ctrlKey: true }),
    redo: () => press("y", { ctrlKey: true }),
    toggle: (mark: string) =>
      toggleMark(view.state.schema.marks[mark]!)(view.state, view.dispatch, view),
    mark(name: string, attrs?: Attrs) {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.addMark(from, to, view.state.schema.marks[name]!.create(attrs)));
    },
    retype: (name: string, attrs?: Attrs) =>
      setBlockType(view.state.schema.nodes[name]!, attrs)(view.state, view.dispatch, view),
    /** Puts an inline item, or a block that holds none, where the selection is. */
    put(name: string, attrs?: Attrs) {
      view.dispatch(
        view.state.tr.replaceSelectionWith(view.state.schema.nodes[name]!.create(attrs), false),
      );
    },
    boundaryIds: () =>
      tokensOf(sequence)
        .filter((token) => token.kind === "boundary")
        .map((token) => token.id),
    /** For each line of the note, the id of its boundary and its letters. */
    boundaryLines() {
      const lines: { id: Id | null; text: string }[] = [];
      for (const token of tokensOf(sequence)) {
        if (token.kind === "boundary") lines.push({ id: token.id, text: "" });
        else if (token.kind === "letter") {
          if (lines.length === 0) lines.push({ id: null, text: "" });
          lines.at(-1)!.text += token.text;
        }
      }
      return lines;
    },
    lettersMarked: (mark: string) =>
      tokensOf(sequence)
        .map((token) =>
          token.kind === "letter" && token.marks.split(",").includes(mark) ? token.text : "",
        )
        .join(""),
    /** What one action did to the items of this person's document, read from the updates it sent. */
    effects(act: () => void): Effects {
      const before = inventory(sequence);
      const was = tokensOf(sequence);
      const from = base.sent.length;
      const shownBefore = base.shown.count;
      act();
      const now = tokensOf(sequence);
      const made = quiet();
      const gone = quiet();
      let other = 0;
      const updates = base.sent.slice(from);
      if (updates.length > 0) {
        const { structs, ds } = Y.decodeUpdate(Y.mergeUpdates(updates));
        for (const struct of structs) {
          const kind = struct instanceof Y.Item ? kindOf(struct) : null;
          if (kind === null) other += struct.length;
          else made[kind] += struct.length;
        }
        for (const [client, ranges] of ds.clients)
          for (const range of ranges)
            for (let at = 0; at < range.len; at++) {
              const kind = before.get(idOf(client, range.clock + at));
              if (kind === undefined) other += 1;
              else gone[kind] += 1;
            }
      }
      const ids = (tokens: Token[]) => new Set(tokens.map((token) => token.id));
      const minus = (left: Token[], right: Token[]) => {
        const there = ids(right);
        return left.filter((token) => !there.has(token.id));
      };
      const letters = (tokens: Token[]) =>
        tokens.map((token) => (token.kind === "letter" ? token.text : "")).join("");
      const boundaries = (tokens: Token[]) =>
        tokens.filter((token) => token.kind === "boundary").map((token) => token.id);
      return {
        made,
        gone,
        other,
        goneLetters: letters(minus(was, now)),
        madeLetters: letters(minus(now, was)),
        goneBoundaries: boundaries(minus(was, now)),
        madeBoundaries: boundaries(minus(now, was)),
        shown: base.shown.count - shownBefore,
      };
    },
    /** The editor shows exactly what a new reading of the note gives, and that is a valid document. */
    expectMirror() {
      view.state.doc.check();
      expect(view.state.doc.toJSON()).toEqual(readBodySequence(view.state.schema, doc).toJSON());
    },
  };
}

type Connected = { sent: Uint8Array[]; receive(update: Uint8Array): void };

/** Passes every waiting change to everyone else, the first person's first, until nobody has any. */
export function exchange(...people: Connected[]) {
  for (let round = 0; round < 6; round++) {
    const waiting = people.map((each) => each.sent.splice(0));
    if (waiting.every((updates) => updates.length === 0)) return;
    waiting.forEach((updates, from) => {
      for (const update of updates)
        people.forEach((to, at) => {
          if (at !== from) to.receive(update);
        });
    });
  }
  throw new Error("the editors kept rewriting the note");
}

/** Everyone catches up from everyone else's whole document, as after a reconnect: one update holds many changes. */
export function reconnect(...people: (Connected & { doc: Y.Doc })[]) {
  for (const each of people) each.sent.length = 0;
  for (let pass = 0; pass < 3; pass++)
    for (const from of people)
      for (const to of people)
        if (from !== to) to.receive(Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
  for (const each of people) each.sent.length = 0;
}

export const LINES = ["One one", "Two two two", "Three"];

/**
 * The races named in issue 4038, played by real editors. `seat` makes the person in each of three
 * seats, so one file can seat plain editors and another a plain editor and a Tiptap one.
 */
export function raceTests(seat: (baseline: Uint8Array, at: 0 | 1 | 2) => Person) {
  describe.each(["first", "second"] as const)("the %s person's change arriving first", (order) => {
    const pair = (...lines: string[]) =>
      [seat(note(...lines), 0), seat(note(...lines), 1)] as const;
    const settle = (a: Person, b: Person) => {
      if (order === "first") exchange(a, b);
      else exchange(b, a);
      a.expectMirror();
      b.expectMirror();
      expect(tokensOf(b.sequence)).toEqual(tokensOf(a.sequence));
      expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
      return a.lines();
    };
    const undoAll = (a: Person, b: Person) => {
      for (const each of [a, b]) while (each.undo());
      return settle(a, b);
    };

    it("keeps a line once when both join it to the line above", () => {
      const [a, b] = pair(...LINES);
      a.join(1);
      b.join(1);
      expect(settle(a, b)).toEqual(["One oneTwo two two", "Three"]);
      a.undo();
      expect(settle(a, b)).toEqual(LINES);
      b.undo();
      const lines = settle(a, b);
      expect(lines.filter((line) => line !== "")).toEqual(LINES);
      expect(lines.filter((line) => line === "")).toHaveLength(1);
    });

    it("keeps a line once when one joins it and the other splits it", () => {
      const [a, b] = pair(...LINES);
      a.join(1);
      b.split(1, 4);
      expect(settle(a, b)).toEqual(["One oneTwo ", "two two", "Three"]);
      expect(undoAll(a, b)).toEqual(LINES);
    });

    it("leaves an empty line and no doubled text when both split a line at one place", () => {
      const [a, b] = pair("One one", "Two two two");
      a.split(1, 4);
      b.split(1, 4);
      const lines = settle(a, b);
      expect(lines.filter((line) => line !== "")).toEqual(["One one", "Two ", "two two"]);
      expect(lines.filter((line) => line === "")).toHaveLength(1);
      expect(undoAll(a, b)).toEqual(["One one", "Two two two"]);
    });

    it("keeps every line when neighbouring lines are joined", () => {
      const [a, b] = pair(...LINES);
      a.join(1);
      b.join(2);
      expect(settle(a, b)).toEqual(["One oneTwo two twoThree"]);
      expect(undoAll(a, b)).toEqual(LINES);
    });

    it("keeps what one person types in a line the other joins away", () => {
      const [a, b] = pair(...LINES);
      a.join(1);
      b.typeAt(1, 11, " more");
      b.typeAt(1, 0, ">");
      expect(settle(a, b)).toEqual(["One one>Two two two more", "Three"]);
      a.undo();
      expect(settle(a, b)).toEqual(["One one", ">Two two two more", "Three"]);
    });

    it("reads abXc when both join bc up and one types between b and c first", () => {
      const [a, b] = pair("a", "bc");
      a.join(1);
      b.join(1);
      b.typeAt(0, 2, "X");
      expect(settle(a, b)).toEqual(["abXc"]);
      b.undo();
      expect(settle(a, b)).toEqual(["abc"]);
      b.undo();
      expect(settle(a, b)).toEqual(["a", "bc"]);
    });

    it("reads ppkkll when one joins ll into kk and leaves, and the other joins both into pp", () => {
      const [a, b] = pair("pp", "kk", "ll");
      const c = seat(note("pp", "kk", "ll"), 2);
      a.join(2);
      const left = a.sent.splice(0);
      b.join(1);
      b.join(1);
      for (const update of left) for (const each of [b, c]) each.receive(update);
      expect(settle(b, c)).toEqual(["ppkkll"]);
      b.undo();
      b.undo();
      expect(settle(b, c)).toEqual(["pp", "kk", "ll"]);
    });

    it("keeps c when one joins it and splits it out, one joins it, and one deletes b", () => {
      const [a, b] = pair("a", "b", "c");
      const c = seat(note("a", "b", "c"), 2);
      a.join(2);
      a.split(1, 1);
      b.join(2);
      c.select([0, 1], [1, 1]);
      c.press("Backspace");
      if (order === "first") exchange(a, b, c);
      else exchange(c, b, a);
      for (const each of [a, b, c]) each.expectMirror();
      expect(b.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
      expect(c.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
      expect(a.lines().join("")).toBe("ac");
      expect(a.lines().at(-1)).toBe("c");
      for (const each of [a, b, c]) while (each.undo());
      if (order === "first") exchange(a, b, c);
      else exchange(c, b, a);
      for (const each of [a, b, c]) each.expectMirror();
      expect(c.view.state.doc.toJSON()).toEqual(a.view.state.doc.toJSON());
      const letters = a.lines().join("");
      expect([...letters].sort().join("")).toBe("abc");
    });

    it("keeps marks where they were through a split and a join", () => {
      const [a, b] = pair("One one", "Two two two");
      a.select([0, 2], [1, 4]);
      a.mark("bold");
      b.split(1, 4);
      b.join(2);
      b.typeAt(0, 5, "X");
      settle(a, b);
      expect(a.lettersMarked("bold")).toBe("e oXneTwo ");
      undoAll(a, b);
      expect(a.lines()).toEqual(["One one", "Two two two"]);
      expect(a.lettersMarked("bold")).toBe("");
    });

    it("gives a heading and a typed letter both when one retypes a line the other types in", () => {
      const [a, b] = pair(...LINES);
      a.select([1, 0]);
      a.retype("heading", { level: 3 });
      b.typeAt(1, 3, "!");
      expect(settle(a, b)).toEqual(["One one", "Two! two two", "Three"]);
      expect(a.blocks()).toEqual(["paragraph", "h3", "paragraph"]);
      expect(b.blocks()).toEqual(["paragraph", "h3", "paragraph"]);
      expect(undoAll(a, b)).toEqual(LINES);
      expect(a.blocks()).toEqual(["paragraph", "paragraph", "paragraph"]);
    });
  });
}
