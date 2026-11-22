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
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { undo } from "y-prosemirror";
import {
  createLiveMarkdownJournalValidator,
  WORKER_LIVE_VALIDATION_POLICY,
} from "@dohc/ydoc-projection/live-journal-validation";
import { MovedText } from "@dohc/ydoc-projection/moved-text";
import { applyUpdateFindingRemovedText } from "@dohc/ydoc-projection/removed-text";
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
/** A person on a share page, with the text the page told them someone else's change removed. */
type OnSharePage = Person & { told: string[] };

/**
 * A share page: the editor's change runs inside the session's transaction, and a change from
 * elsewhere is applied the way the page's live session applies it.
 */
function sharePage(baseline: Uint8Array): Promise<OnSharePage> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseline, REMOTE);
  const sent: Uint8Array[] = [];
  const told: string[] = [];
  const moved = new MovedText();
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.origin !== REMOTE) moved.note(transaction);
  });
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
    receive(update) {
      const removed = applyUpdateFindingRemovedText(
        doc,
        update,
        REMOTE,
        () => Y.decodeUpdate(update).ds,
        (item) => item.id.client === doc.clientID,
        { follower: moved, mayEdit: () => true },
      );
      if (removed) told.push(removed.text);
    },
    told,
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

function caretIn(person: Person, text: string, offset: number) {
  const { view } = person;
  let start = -1;
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return start < 0;
    if (start < 0 && node.textContent === text) start = pos + 1;
    return false;
  });
  if (start < 0) throw new Error(`no line reads "${text}"`);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start + offset)));
}

function press(person: Person, key: string) {
  const { view } = person;
  const event = new window.KeyboardEvent("keydown", { key });
  view.someProp("handleKeyDown", (handle) => handle(view, event));
}

function type(person: Person, text: string) {
  for (const character of text) person.view.dispatch(person.view.state.tr.insertText(character));
}

const empty = (update: Uint8Array) => {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
};

/** The server: it keeps each change it accepts and passes it to the other page. */
function startServer(baseline: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, baseline);
  const accepted: Uint8Array[] = [];
  stops.push(() => doc.destroy());
  return {
    /**
     * Takes the first person's change and then the second's, neither having received the
     * other's. The pages go on answering each other until neither has anything left to send.
     * Returns the server's verdict on each change.
     */
    async take(first: Person, second: Person) {
      const verdicts: string[] = [];
      let waiting: [Person, Uint8Array][] = [
        [first, await first.take()],
        [second, await second.take()],
      ];
      for (let round = 0; waiting.length > 0; round++) {
        if (round === 6) throw new Error("the pages kept rewriting the note");
        for (const [person, update] of waiting) {
          if (empty(update)) continue;
          verdicts.push(verdict(baseline, accepted, update));
          if (verdicts.at(-1) !== "accepted") continue;
          accepted.push(update);
          Y.applyUpdate(doc, update);
          (person === first ? second : first).receive(update);
        }
        waiting = [];
        for (const person of [first, second]) {
          const update = await person.take();
          if (!empty(update)) waiting.push([person, update]);
        }
      }
      return verdicts;
    },
    note: () => yDocToMarkdown(doc),
  };
}

function baselineOf(note: string) {
  const seed = markdownToYDoc(note);
  const baseline = Y.encodeStateAsUpdate(seed);
  seed.destroy();
  return baseline;
}

const pages = { desktop, "share page": sharePage };

const LINES = "One one\n\nTwo two two\n\nThree\n";

const joinsUp = (text: string) => (person: Person) => {
  caretIn(person, text, 0);
  press(person, "Backspace");
};
const splitsAt = (text: string, offset: number) => (person: Person) => {
  caretIn(person, text, offset);
  press(person, "Enter");
};
const typesAt = (text: string, offset: number, typed: string) => (person: Person) => {
  caretIn(person, text, offset);
  type(person, typed);
};

/** A note's text run together: what is there and in what order, wherever the lines end. */
const run = (markdown: string, ...without: string[]) =>
  without
    .reduce((text, word) => text.split(word).join(""), markdown)
    .replace(/^- \[.\] /gmu, "")
    .replace(/&#32;|&nbsp;|\s+/gu, "");

// The first person joins a line to the one above while the second, on a share page, types in
// it. The owner's desktop as the second person is not here: its engine hands it the merged
// note, not each change, and keeps the words for a Notices row.
const cases = (["share page", "desktop"] as const).flatMap((one) =>
  (
    [
      ["at the end of it", 11, " TYPED"],
      ["in the middle of it", 4, "TYPED "],
      ["at the start of it", 0, "TYPED "],
    ] as const
  ).flatMap(([where, offset, typed]) =>
    (["first", "second"] as const).map((arrives) => [where, one, arrives, offset, typed] as const),
  ),
);

it.each(cases)(
  "keeps a word typed %s while someone joins the line up (%s joins; the join arrives %s)",
  async (_where, one, arrives, offset, typed) => {
    const baseline = baselineOf(LINES);
    const a = await pages[one](baseline),
      b = await sharePage(baseline);
    const server = startServer(baseline);
    joinsUp("Two two two")(a);
    typesAt("Two two two", offset, typed)(b);
    const verdicts = await (arrives === "first" ? server.take(a, b) : server.take(b, a));

    expect(verdicts).toEqual(verdicts.map(() => "accepted"));
    const note = server.note();
    for (const person of [a, b]) expect(yDocToMarkdown(person.doc)).toBe(note);
    expect(run(note, "TYPED")).toBe(run(LINES));
    expect(note.split("TYPED")).toHaveLength(2);
    expect(b.told).toEqual([]);
  },
);

it("undoes a word that followed a line someone else joined away", async () => {
  const baseline = baselineOf(LINES);
  const a = await sharePage(baseline),
    b = await sharePage(baseline);
  const server = startServer(baseline);
  joinsUp("Two two two")(a);
  typesAt("Two two two", 11, " TYPED")(b);
  await server.take(a, b);
  expect(server.note()).toBe("One oneTwo two two TYPED\n\nThree\n");

  for (let presses = 0; presses < 2 && server.note().includes("TYPED"); presses++) {
    undo(b.view.state);
    await server.take(b, a);
  }
  expect(server.note()).toBe("One oneTwo two two\n\nThree\n");
  expect(yDocToMarkdown(a.doc)).toBe(server.note());
});

const SMALL = ["ab", "cde", "fg"];
type Step = ["join", number] | ["split", number, number] | ["type", number, number];
const steps: Step[] = SMALL.flatMap((text, line) => [
  ...(line > 0 ? [["join", line] as Step] : []),
  ...Array.from({ length: text.length + 1 }, (_, at) => ["split", line, at] as Step),
  ...Array.from({ length: text.length + 1 }, (_, at) => ["type", line, at] as Step),
]);

function make(person: Person, step: Step, word: string) {
  const text = SMALL[step[1]]!;
  if (step[0] === "join") joinsUp(text)(person);
  else if (step[0] === "split") splitsAt(text, step[2])(person);
  else {
    caretIn(person, text, step[2]);
    person.view.dispatch(person.view.state.tr.insertText(word));
  }
}

// Two people on share pages, three short lines, and every pair of one join, split or typed
// word each, in both orders of arrival. A typed word is never gone and never there twice, and
// its author is never told it was removed. Text two people moved may still stand twice, and a
// line joined into a line someone else joins away may still go, as before this change.
it("keeps every typed word once for every pair of joins, splits and typed words", async () => {
  const wrong: string[] = [];
  for (const one of steps)
    for (const two of steps)
      for (const arrives of ["first", "second"] as const) {
        if (one[0] !== "type" && two[0] !== "type") continue;
        const baseline = baselineOf(`${SMALL.join("\n\n")}\n`);
        const a = await sharePage(baseline),
          b = await sharePage(baseline);
        const server = startServer(baseline);
        make(a, one, "XY");
        make(b, two, "ZW");
        const verdicts = await (arrives === "first" ? server.take(a, b) : server.take(b, a));
        const note = server.note();
        const letters = run(note);
        const typed = [...(one[0] === "type" ? ["XY"] : []), ...(two[0] === "type" ? ["ZW"] : [])];
        const right =
          verdicts.every((verdict) => verdict === "accepted") &&
          yDocToMarkdown(a.doc) === note &&
          yDocToMarkdown(b.doc) === note &&
          letters.replace(/[^a-z]/gu, "") === SMALL.join("") &&
          typed.every((word) => letters.split(word).length === 2) &&
          a.told.length + b.told.length === 0;
        if (!right)
          wrong.push(`${JSON.stringify([one, two])}, the first arrives ${arrives}: ${note}`);
        for (const stop of stops.splice(0).reverse()) await stop();
      }
  expect(wrong).toEqual([]);
}, 120_000);
