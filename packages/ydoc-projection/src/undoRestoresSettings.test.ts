// @vitest-environment jsdom
import { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import { mountLiveBodyEditor } from "./browser-editor.js";
import { markdownToYDoc, serializeRichdocBody, yDocToMarkdown } from "./import-export.js";

const REMOTE = Symbol("remote");
const NOTE = "first\n\n## title\n\nlast\n";
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0).reverse()) stop();
});

type Person = ReturnType<typeof person>;
const HOSTS = ["phone", "share page"] as const;
type Host = (typeof HOSTS)[number];

function person(baseline: Uint8Array, host: Host) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sent.push(update);
  });
  return { ...editorOn(doc, host), sent };
}

function editorOn(doc: Y.Doc, host: Host) {
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
      if (host === "share page") doc.transact(change);
      else change();
      return true;
    },
  });
  EditorView.prototype.updateState = updateState;
  stops.push(() => {
    editor.destroy();
    mount.remove();
    doc.destroy();
  });
  return { doc, editor, view: view! };
}

function twoPeople(host: Host) {
  const seed = markdownToYDoc(NOTE);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return [person(baseline, host), person(baseline, host)] as const;
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

describe.each(HOSTS)("on the %s", (host) => {
  it("undo brings a deleted heading back at its old level for everyone, after its level changed in the same undo step", () => {
    const [a, b] = twoPeople(host);
    setLevel(a, 3);
    deleteHeading(a);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\nlast\n"));

    expect(a.editor.undo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
  });

  it("undo brings a deleted heading back at the level its deleter last saw, when someone else changed the level meanwhile", () => {
    const [a, b] = twoPeople(host);
    deleteHeading(a);
    setLevel(b, 3);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\nlast\n"));

    expect(a.editor.undo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
  });

  it("undo of a level change puts the old level back over a level someone else set since", () => {
    const [a, b] = twoPeople(host);
    setLevel(a, 3);
    exchange(a, b);
    setLevel(b, 1);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n# title\n\nlast\n"));

    expect(a.editor.undo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
  });

  it("redo of a level change puts that level back over a level someone else set since", () => {
    const [a, b] = twoPeople(host);
    setLevel(a, 3);
    expect(a.editor.undo()).toBe(true);
    exchange(a, b);
    setLevel(b, 1);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n# title\n\nlast\n"));

    expect(a.editor.redo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n### title\n\nlast\n"));
  });

  it("undoes and redoes a level change", () => {
    const [a, b] = twoPeople(host);
    setLevel(a, 3);
    exchange(a, b);
    expect(a.editor.undo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
    expect(a.editor.redo()).toBe(true);
    exchange(a, b);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n### title\n\nlast\n"));
  });

  it("leaves a change that came from someone else out of a person's undo", () => {
    const [a, b] = twoPeople(host);
    setLevel(b, 3);
    exchange(a, b);
    expect(a.editor.undo()).toBe(false);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n### title\n\nlast\n"));
  });

  it("keeps a change marked as outside history out of undo", () => {
    const [a, b] = twoPeople(host);
    a.view.dispatch(
      a.view.state.tr
        .setNodeMarkup(heading(a).at, undefined, { level: 3 })
        .setMeta("addToHistory", false),
    );
    exchange(a, b);
    expect(a.editor.undo()).toBe(false);
    expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n### title\n\nlast\n"));
  });

  it.runIf(host === "share page")(
    "keeps one editor's change out of the undo of another editor on the same document",
    () => {
      const [a, b] = twoPeople(host);
      const second = editorOn(a.doc, host);
      setLevel(a, 3);
      exchange(a, b);
      expect(second.editor.undo()).toBe(false);
      expect(everyoneReads(a, b)).toEqual(everyoneReading("first\n\n### title\n\nlast\n"));
      expect(a.editor.undo()).toBe(true);
      exchange(a, b);
      expect(everyoneReads(a, b)).toEqual(everyoneReading(NOTE));
    },
  );
});
