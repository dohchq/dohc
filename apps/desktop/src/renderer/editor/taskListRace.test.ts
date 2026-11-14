// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { Collaboration } from "@tiptap/extension-collaboration";
import { TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import { getDohcYDocBodyFragment, markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
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
  };
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
const TASKS = "- [ ] alpha\n- [x] bravo\n- [ ] charlie\n- [x] delta\n";

function caretAtLineStart(person: Person, index: number) {
  const { view } = person;
  let start = -1;
  let seen = 0;
  view.state.doc.descendants((node, pos) => {
    if (start >= 0) return false;
    if (!node.isTextblock) return true;
    if (seen++ === index) start = pos + 1;
    return false;
  });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start)));
}

function backspace(person: Person) {
  const { view } = person;
  const event = new window.KeyboardEvent("keydown", { key: "Backspace" });
  view.someProp("handleKeyDown", (handle) => handle(view, event));
}

/** What a page or the note shows: each to-do box in order, `x` ticked and `_` not, and the text. */
function shown(doc: EditorView["state"]["doc"]) {
  let boxes = "";
  doc.descendants((node) => {
    if (node.type.name === "taskItem") boxes += node.attrs.checked ? "x" : "_";
    return true;
  });
  return { boxes, text: doc.textContent };
}

/**
 * Sends each page's change to the server in turn. The server keeps a change it accepts and
 * passes it to the other page; a page whose change it refuses keeps that change as a draft and
 * hears nothing more until it reloads.
 */
async function throughServer(baseline: Uint8Array, people: Person[]) {
  const server = new Y.Doc();
  Y.applyUpdate(server, baseline);
  const accepted: Uint8Array[] = [];
  const refused = new Set<Person>();
  for (let pass = 0; pass < 4; pass++) {
    let sent = false;
    // Everyone sends before hearing from the others, as two people editing at once do.
    const updates: Uint8Array[] = [];
    for (const person of people) updates.push(await person.take());
    for (const [index, person] of people.entries()) {
      const update = updates[index]!;
      const { structs, ds } = Y.decodeUpdate(update);
      if ((structs.length === 0 && ds.clients.size === 0) || refused.has(person)) continue;
      sent = true;
      if (verdict(baseline, accepted, update) !== "accepted") {
        refused.add(person);
        continue;
      }
      accepted.push(update);
      Y.applyUpdate(server, update);
      for (const other of people)
        if (other !== person && !refused.has(other)) other.receive(update);
    }
    if (!sent) break;
  }
  const note = yDocToMarkdown(server);
  server.destroy();
  return { note, refused };
}

function read(note: string, view: EditorView) {
  const doc = markdownToYDoc(note);
  const node = yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(doc), view.state.schema);
  doc.destroy();
  return shown(node);
}

// Backspace at the start of a to-do on the desktop turns it into a plain line. When two people do
// that to neighbouring to-dos at once, the merged list keeps an empty to-do list between them.
it("shows each person the note's to-do boxes after two people turn neighbouring to-dos into plain lines at once", async () => {
  const seed = markdownToYDoc(TASKS);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  const a = await desktop(baseline),
    b = await desktop(baseline);
  caretAtLineStart(a, 1);
  backspace(a);
  caretAtLineStart(b, 2);
  backspace(b);
  const { note, refused } = await throughServer(baseline, [a, b]);
  for (const person of [a, b])
    expect(shown(person.view.state.doc)).toEqual(read(note, person.view));
  expect(refused.size).toBe(0);
});

// Backspace at the start of a to-do on a share page moves its line into the to-do above.
it.each([
  ["desktop", "share page"],
  ["share page", "share page"],
] as const)(
  "keeps every line when two people join neighbouring to-dos into the ones above at once (%s, then %s)",
  async (first, second) => {
    const seed = markdownToYDoc(TASKS);
    const baseline = Y.encodeStateAsUpdate(seed);
    seed.destroy();
    const a = await pages[first](baseline),
      b = await pages[second](baseline);
    caretAtLineStart(a, 1);
    backspace(a);
    caretAtLineStart(b, 2);
    backspace(b);
    const { note, refused } = await throughServer(baseline, [a, b]);
    for (const line of ["alpha", "bravo", "charlie", "delta"]) expect(note).toContain(line);
    expect(refused.size).toBe(0);
  },
);
