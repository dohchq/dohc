// @vitest-environment jsdom
import { EditorView } from "@tiptap/pm/view";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { mountLiveBodyEditor } from "./browser-editor.js";
import { markdownToYDoc, serializeRichdocBody, yDocToMarkdown } from "./import-export.js";

const REMOTE = Symbol("remote");
const NOTE = "first\n\n## title\n\nlast\n";
const stops: (() => void)[] = [];

// Yjs joins changes made within 500 ms into one undo step. A stopped clock keeps a person's
// changes in one step however long the test takes.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
  vi.useRealTimers();
});

type Person = ReturnType<typeof person>;

/** A phone's editor on its own copy of the note: the editor's transactions reach Yjs as they are. */
function person(baseline: Uint8Array) {
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
      change();
      return true;
    },
  });
  EditorView.prototype.updateState = updateState;
  stops.push(() => {
    editor.destroy();
    mount.remove();
    doc.destroy();
  });
  return { doc, editor, view: view!, sent };
}

function twoPeople() {
  const seed = markdownToYDoc(NOTE);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return [person(baseline), person(baseline)] as const;
}

function exchange(a: Person, b: Person) {
  for (const update of a.sent.splice(0)) Y.applyUpdate(b.doc, update, REMOTE);
  for (const update of b.sent.splice(0)) Y.applyUpdate(a.doc, update, REMOTE);
}

function heading({ view }: Person) {
  let found: { at: number; size: number } | undefined;
  view.state.doc.forEach((node, at) => {
    if (node.type.name === "heading") found = { at, size: node.nodeSize };
  });
  return found!;
}

function setLevel(who: Person, level: number) {
  who.view.dispatch(who.view.state.tr.setNodeMarkup(heading(who).at, undefined, { level }));
}

function deleteHeading(who: Person) {
  const { at, size } = heading(who);
  who.view.dispatch(who.view.state.tr.delete(at, at + size));
}

function shown({ view }: Person) {
  return `${serializeRichdocBody(view.state.doc.toJSON())}
`;
}

/** The note as each editor shows it, as each document saves it, and as the first person's document reads when opened again. */
function everyoneReads(a: Person, b: Person) {
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(a.doc));
  try {
    return {
      "first person's editor": shown(a),
      "second person's editor": shown(b),
      "first person's document": yDocToMarkdown(a.doc),
      "second person's document": yDocToMarkdown(b.doc),
      "first person's document, opened again": yDocToMarkdown(reopened),
    };
  } finally {
    reopened.destroy();
  }
}

function everyoneReading(note: string) {
  return {
    "first person's editor": note,
    "second person's editor": note,
    "first person's document": note,
    "second person's document": note,
    "first person's document, opened again": note,
  };
}

it("undo brings a deleted heading back at its old level for everyone, after its level changed in the same undo step", () => {
  const [a, b] = twoPeople();
  setLevel(a, 3);
  deleteHeading(a);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\nlast\n"));

  expect(a.editor.undo()).toBe(true);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
});

it("undo brings a deleted heading back at the level its deleter last saw, when someone else changed the level meanwhile", () => {
  const [a, b] = twoPeople();
  deleteHeading(a);
  setLevel(b, 3);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\nlast\n"));

  expect(a.editor.undo()).toBe(true);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
});

it("undo of a level change puts the old level back over a level someone else set since", () => {
  const [a, b] = twoPeople();
  setLevel(a, 3);
  exchange(a, b);
  setLevel(b, 1);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n# title\n\nlast\n"));

  expect(a.editor.undo()).toBe(true);
  exchange(a, b);
  expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
});
