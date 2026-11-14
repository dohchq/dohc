// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Collaboration } from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import { baseKeymap } from "@tiptap/pm/commands";
import { EditorView } from "@tiptap/pm/view";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import { getDohcYDocBodyFragment, markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import {
  createLiveMarkdownJournalValidator,
  WORKER_LIVE_VALIDATION_POLICY,
} from "@dohc/ydoc-projection/live-journal-validation";
import { bindEngineYDoc, type EngineYDocTransport } from "../collab/engineYDocProvider";
import { desktopMarkdownExtensions } from "./extensions";
import { ListConversions } from "./listEditing";

const admit = createLiveMarkdownJournalValidator(WORKER_LIVE_VALIDATION_POLICY);
const REMOTE = Symbol("remote");
const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

type Person = {
  doc: Y.Doc;
  view: EditorView;
  take(): Promise<Uint8Array>;
  receive(update: Uint8Array): void;
  enter(): void;
};

/** A share page: the editor's change runs inside the session's transaction, as the transport runs it. */
function sharePage(baseline: Uint8Array): Promise<Person> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
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
      doc.transact(change);
      return true;
    },
  });
  EditorView.prototype.updateState = updateState;
  stops.push(() => {
    editor.destroy();
    mount.remove();
    doc.destroy();
  });
  return Promise.resolve({
    doc,
    view: view!,
    take: async () => Y.mergeUpdates(sent.splice(0)),
    receive: (update) => Y.applyUpdate(doc, update, REMOTE),
    enter: () => void baseKeymap.Enter!(view!.state, view!.dispatch, view!),
  });
}

/** The desktop: the Markdown editor on the engine's document, sending what it ships to main. */
async function desktop(baseline: Uint8Array): Promise<Person> {
  const shipped: Uint8Array[] = [];
  let remote: ((update: Uint8Array, generation: number) => void) | null = null;
  const transport: EngineYDocTransport = {
    open: async () => ({ available: true, initialUpdate: baseline, lineageGeneration: 1 }),
    stageLocalUpdate: (() => {
      let sequence = 0;
      return () => ++sequence;
    })(),
    applyLocalUpdate(update) {
      shipped.push(update);
    },
    onRemoteUpdate(listener) {
      remote = listener;
      return () => (remote = null);
    },
    onLineageReplacement: () => () => {},
    acknowledgeLineageReplacement: async () => [],
    close: async () => {},
  };
  const binding = await bindEngineYDoc(transport);
  const doc = binding.doc!;
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [
      ...desktopMarkdownExtensions,
      StarterKit.configure({
        trailingNode: false,
        undoRedo: false,
        orderedList: false,
        listItem: false,
      }),
      ListConversions,
      MarkdownListItem,
      MarkdownOrderedList,
      MarkdownTaskList,
      DohcTaskItem,
      TableKit.configure({ table: false }),
      DohcMarkdownTable,
      Collaboration.configure({ document: doc, field: "body" }),
    ],
  });
  stops.push(async () => {
    editor.destroy();
    element.remove();
    await binding.destroy();
  });
  return {
    doc,
    view: editor.view,
    async take() {
      await binding.flushPendingLocalUpdates();
      return Y.mergeUpdates(shipped.splice(0));
    },
    receive: (update) => remote!(update, 1),
    enter: () => void editor.commands.keyboardShortcut("Enter"),
  };
}

function textblocks(view: EditorView) {
  const found: { end: number; text: string }[] = [];
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    found.push({ end: pos + node.nodeSize - 1, text: node.textContent });
    return false;
  });
  return found;
}

function caretAtEnd(person: Person, index: number) {
  const { view } = person;
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, textblocks(view)[index]!.end)),
  );
}

function type(person: Person, text: string) {
  for (const character of text) person.view.dispatch(person.view.state.tr.insertText(character));
}

/** "accepted", or why the server refused the update. */
function verdict(baseline: Uint8Array, suffix: Uint8Array[], candidate: Uint8Array) {
  const result = admit({
    document: {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: createHash("sha256").update(baseline).digest("hex"),
    },
    currentPath: "notes/plan.md",
    checkpoint: baseline,
    suffix,
    candidate,
  });
  return result.kind === "refused" ? `refused: ${result.reason}` : result.kind;
}

const pages = { desktop, "share page": sharePage };
const pairs = (["desktop", "share page"] as const).flatMap((maker) =>
  (["desktop", "share page"] as const).map((other) => [maker, other] as const),
);

/** Each line's text pieces, as `""` for an empty piece; a line must never hold two. */
function lineShape(doc: Y.Doc) {
  const found: string[] = [];
  const visit = (node: Y.XmlFragment) => {
    for (const child of node.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      const pieces = child.toArray().filter((piece) => piece instanceof Y.XmlText);
      if (pieces.length > 0 || ["paragraph", "heading", "codeBlock"].includes(child.nodeName))
        found.push(pieces.map((piece) => JSON.stringify(piece.toString())).join("+") || "none");
      visit(child);
    }
  };
  visit(getDohcYDocBodyFragment(doc));
  return found;
}

// An editor must never delete an empty text piece: someone may be typing into it.

const ALL_ACCEPTED = ["accepted", "accepted", "accepted", "accepted"];

function hardBreak(person: Person) {
  const { view } = person;
  view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.nodes.hardBreak!.create()));
}

function backspace(person: Person) {
  const { view } = person;
  const at = view.state.selection.from;
  view.dispatch(view.state.tr.delete(at - 1, at));
}

function caretAt(person: Person, index: number, offset: number) {
  const { view } = person;
  let start = -1;
  let seen = 0;
  view.state.doc.descendants((node, pos) => {
    if (start >= 0) return false;
    if (!node.isTextblock) return true;
    if (seen++ === index) start = pos + 1;
    return false;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + offset)));
}

/** A note whose second line holds `parts`: strings are text pieces, null a line break. */
function seeded(parts: (string | null)[]): Uint8Array {
  const seed = markdownToYDoc("One.\n");
  const line = new Y.XmlElement("paragraph");
  line.insert(
    0,
    parts.map((part) => (part === null ? new Y.XmlElement("hardBreak") : new Y.XmlText(part))),
  );
  getDohcYDocBodyFragment(seed).push([line]);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return baseline;
}

/** Sends each page's update to the other until neither has anything left to send. */
async function exchange(a: Person, b: Person, fromA: Uint8Array, fromB: Uint8Array) {
  a.receive(fromB);
  b.receive(fromA);
  for (let round = 0; round < 3; round++) {
    const [nextA, nextB] = [await a.take(), await b.take()];
    const quiet = [nextA, nextB].every((update) => {
      const { structs, ds } = Y.decodeUpdate(update);
      return structs.length === 0 && ds.clients.size === 0;
    });
    if (quiet) return;
    a.receive(nextB);
    b.receive(nextA);
  }
  throw new Error("the pages kept rewriting the line");
}

async function expectKept(a: Person, b: Person, typed: string) {
  const saved = yDocToMarkdown(a.doc);
  expect(yDocToMarkdown(b.doc)).toBe(saved);
  expect(saved.split(typed)).toHaveLength(2);
}

it.each(pairs)(
  "keeps what one person types into a new empty line while the other puts a line break there (%s breaks, %s types)",
  async (breaker, typist) => {
    const seed = markdownToYDoc("One.\n\nTwo.\n");
    const baseline = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    const a = await pages[breaker](baseline),
      b = await pages[typist](baseline);
    caretAtEnd(a, 0);
    a.enter();
    const enter = await a.take();
    b.receive(enter);
    caretAtEnd(a, 1);
    hardBreak(a);
    caretAtEnd(b, 1);
    type(b, "from b");
    const fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [enter], fromA),
      verdict(baseline, [enter, fromA], fromB),
      verdict(baseline, [enter], fromB),
      verdict(baseline, [enter, fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
    await exchange(a, b, fromA, fromB);
    await expectKept(a, b, "from b");
  },
);

// A line typed into and then cleared keeps its emptied piece; then one person puts a line
// break into it while the other types into it.
it.each(
  pairs.flatMap(([breaker, typist]) =>
    (["breaker", "typist"] as const).map((clearer) => [breaker, typist, clearer] as const),
  ),
)(
  "keeps what one person types into a cleared line while the other puts a line break there (%s breaks, %s types, the %s cleared it)",
  async (breaker, typist, clearer) => {
    const seed = markdownToYDoc("One.\n\nTwo.\n");
    const baseline = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    const a = await pages[breaker](baseline),
      b = await pages[typist](baseline);
    const maker = clearer === "breaker" ? a : b,
      other = clearer === "breaker" ? b : a;
    caretAtEnd(maker, 0);
    maker.enter();
    type(maker, "x");
    backspace(maker);
    const clear = await maker.take();
    other.receive(clear);
    caretAtEnd(a, 1);
    hardBreak(a);
    caretAtEnd(b, 1);
    type(b, "from b");
    const fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [clear], fromA),
      verdict(baseline, [clear, fromA], fromB),
      verdict(baseline, [clear], fromB),
      verdict(baseline, [clear, fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
    await exchange(a, b, fromA, fromB);
    await expectKept(a, b, "from b");
  },
);

it.each(pairs)(
  "keeps what one person types after a line break while the other deletes the break (%s deletes, %s types)",
  async (deleter, typist) => {
    const baseline = seeded([null, ""]);
    const a = await pages[deleter](baseline),
      b = await pages[typist](baseline);
    caretAtEnd(a, 1);
    backspace(a);
    caretAtEnd(b, 1);
    type(b, "from b");
    const fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [], fromA),
      verdict(baseline, [fromA], fromB),
      verdict(baseline, [], fromB),
      verdict(baseline, [fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
    await exchange(a, b, fromA, fromB);
    await expectKept(a, b, "from b");
  },
);

it.each(pairs)(
  "keeps one empty piece in a cleared line that held a line break, so two people can type into it (%s clears, %s)",
  async (clearer, other) => {
    const baseline = seeded(["ab", null]);
    const a = await pages[clearer](baseline),
      b = await pages[other](baseline);
    caretAt(a, 1, 0);
    a.view.dispatch(
      a.view.state.tr.delete(a.view.state.selection.from, a.view.state.selection.from + 3),
    );
    const clear = await a.take();
    b.receive(clear);
    expect(lineShape(a.doc)).toEqual(['"One."', '""']);
    caretAtEnd(a, 1);
    type(a, "from a");
    caretAtEnd(b, 1);
    type(b, "from b");
    const fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [clear], fromA),
      verdict(baseline, [clear, fromA], fromB),
      verdict(baseline, [clear], fromB),
      verdict(baseline, [clear, fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
  },
);

// A line holding a line break, an empty piece and another line break.
it.each(pairs)(
  "keeps what one person types between two line breaks, between them, while the other types after them (%s types after, %s between)",
  async (after, between) => {
    const baseline = seeded([null, "", null]);
    const a = await pages[after](baseline),
      b = await pages[between](baseline);
    caretAtEnd(a, 1);
    type(a, "z");
    caretAt(b, 1, 1);
    type(b, "from b");
    const fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [], fromA),
      verdict(baseline, [fromA], fromB),
      verdict(baseline, [], fromB),
      verdict(baseline, [fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
    await exchange(a, b, fromA, fromB);
    await expectKept(a, b, "from b");
    expect(yDocToMarkdown(a.doc)).toContain("  \nfrom b  \nz\n");
  },
);

// Text, a line break and an empty piece. Removing the break would leave the empty piece
// beside the text, and typing into it would put two pieces of text side by side, which the
// server refuses. So the piece goes with the break, as before.
it.each(pairs)(
  "accepts every change and repeats nothing when one person removes a line break after text while the other types after it (%s removes, %s types)",
  async (first, second) => {
    const baseline = seeded(["a", null, ""]);
    const a = await pages[first](baseline),
      b = await pages[second](baseline);
    caretAtEnd(a, 1);
    caretAt(a, 1, 2);
    backspace(a);
    caretAtEnd(b, 1);
    type(b, "b");
    let fromA = await a.take(),
      fromB = await b.take();
    expect([
      verdict(baseline, [], fromA),
      verdict(baseline, [fromA], fromB),
      verdict(baseline, [], fromB),
      verdict(baseline, [fromB], fromA),
    ]).toEqual(ALL_ACCEPTED);
    await exchange(a, b, fromA, fromB);
    const round = [fromA, fromB];
    caretAtEnd(a, 1);
    type(a, "X");
    caretAtEnd(b, 1);
    type(b, "c");
    fromA = await a.take();
    fromB = await b.take();
    expect([
      verdict(baseline, [...round, fromA], fromB),
      verdict(baseline, [...round, fromB], fromA),
    ]).toEqual(["accepted", "accepted"]);
    await exchange(a, b, fromA, fromB);
    const saved = yDocToMarkdown(a.doc);
    expect(yDocToMarkdown(b.doc)).toBe(saved);
    expect(saved.split("b").length).toBeLessThanOrEqual(2);
    expect(lineShape(a.doc)).toEqual(lineShape(b.doc));
  },
);

it.each(Object.keys(pages) as (keyof typeof pages)[])(
  "pastes ten thousand line breaks into a line holding an empty piece (%s)",
  async (maker) => {
    const baseline = seeded([""]);
    const a = await pages[maker](baseline);
    caretAtEnd(a, 1);
    const { state } = a.view;
    const breaks = Array.from({ length: 10_000 }, () => state.schema.nodes.hardBreak!.create());
    a.view.dispatch(state.tr.insert(state.selection.from, breaks));
    const update = await a.take();
    expect(verdict(baseline, [], update)).toBe("accepted");
    const line = getDohcYDocBodyFragment(a.doc).get(1) as Y.XmlElement;
    expect(line.toArray().filter((child) => child instanceof Y.XmlElement)).toHaveLength(10_000);
  },
);
