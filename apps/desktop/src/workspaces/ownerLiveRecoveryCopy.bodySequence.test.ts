// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import type { Attrs, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { markdownToYDoc } from "@dohc/ydoc-projection";
import { person, stopEveryone, type Person } from "@dohc/ydoc-projection/body-sequence-testing";
import type { OwnerYDocOutboxRecovery } from "@dohc/workspace-engine-client";
import {
  existsInWorkspace,
  keepOnThisComputer,
  liveRecoveryPackage,
  saveLiveRecoveryCopy,
} from "./ownerLiveRecoveryCopy";
import { directDocumentProjection } from "./documentProjection";
import { createDurableFile } from "./workspaceFiles";
import { createTestScratch } from "./testTemp";
import { openedLocalState } from "../testing/preparedLocalState";

afterEach(stopEveryone);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const NOTE =
  "# Plan\n\nStart here.\n\n- [ ] tick me\n\n1. Pack\n2. Eat\n\n> one\n>\n> two\n\nSum $x^2$ here.\n\nBottom\n";
const LISTED =
  "***\n\n## Kept edits that aren't in this copy\n\nThese edits were kept on the computer that made them. A change saved at the same moment removed or replaced the place they were made, so the note above doesn't have them.\n\n";

type Step = (editor: Person) => void;

/**
 * A kept edit made by a person at a format-2 editor (client 1), against a change by someone else
 * at another editor (client 2) that the server already accepted. With `seen`, the other editor had
 * the kept edit before making theirs, as when its delivery was applied but never acknowledged.
 */
function conflict(mine: Step, theirs: Step, seen = false): OwnerYDocOutboxRecovery {
  const start = markdownToYDoc(NOTE, { bodySequence: true });
  const baseUpdate = Y.encodeStateAsUpdate(start);
  start.destroy();
  const me = person(baseUpdate, 1);
  const other = person(baseUpdate, 2);
  mine(me);
  const update = Y.mergeUpdates(me.sent);
  if (seen) other.receive(update);
  theirs(other);
  const checkpoint = Y.encodeStateAsUpdate(other.doc);
  return {
    outboxId: "outbox",
    binding: {
      workspaceId: "workspace",
      mainVersionId: "main",
      objectId: "object",
      lineageClaimId: "a".repeat(64),
      currentPath: "notes/plan.md",
      selectorPaths: ["notes/plan.md"],
      restoreFenceGeneration: 0,
    },
    baseUpdateDigest: sha256(baseUpdate),
    baseUpdate,
    checkpoint,
    checkpointDigest: sha256(checkpoint),
    state: "quarantined",
    pendingBytes: update.byteLength,
    oldestEntryAtMs: 1_001,
    entries: [
      {
        sequence: 1,
        appendKey: "append-1",
        deliveryId: "delivery-1",
        updateDigest: sha256(update),
        update,
        byteLength: update.byteLength,
        createdAtMs: 1_001,
      },
    ],
    quarantineReason: "invalid-update",
    observedBinding: null,
    retryDeliveryId: null,
  };
}

function find(editor: Person, test: (node: ProseMirrorNode) => boolean) {
  let found: { node: ProseMirrorNode; pos: number } | null = null;
  editor.view.state.doc.descendants((node, pos) => {
    if (found === null && test(node)) found = { node, pos };
    return found === null;
  });
  if (found === null) throw new Error("no such node in the note");
  return found as { node: ProseMirrorNode; pos: number };
}

const named = (type: string, text?: string) => (node: ProseMirrorNode) =>
  node.type.name === type && (text === undefined || node.textContent === text);

function markup(
  editor: Person,
  test: (node: ProseMirrorNode) => boolean,
  type: string | null,
  attrs: Attrs,
) {
  const { node, pos } = find(editor, test);
  const { view } = editor;
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, type === null ? undefined : view.state.schema.nodes[type], {
      ...node.attrs,
      ...attrs,
    }),
  );
}

function remove(editor: Person, test: (node: ProseMirrorNode) => boolean) {
  const { node, pos } = find(editor, test);
  editor.view.dispatch(editor.view.state.tr.delete(pos, pos + node.nodeSize));
}

function command(editor: Person, text: string, run: typeof lift) {
  const { view } = editor;
  const { pos } = find(editor, (node) => node.isTextblock && node.textContent === text);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1)));
  if (!run(view.state, view.dispatch)) throw new Error("the command did nothing");
}

const tick = (checked: boolean) => (editor: Person) =>
  markup(editor, named("taskItem", "tick me"), null, { checked });
const level = (to: number) => (editor: Person) =>
  markup(editor, named("heading", "Plan"), null, { level: to });
const tex = (to: string) => (editor: Person) =>
  markup(editor, named("mathInline"), null, { tex: to });
const list =
  (type: string, attrs: Attrs = {}) =>
  (editor: Person) =>
    markup(
      editor,
      (node) => node.type.name.endsWith("List") && node.textContent === "PackEat",
      type,
      attrs,
    );
const both =
  (...steps: Step[]) =>
  (editor: Person) => {
    for (const step of steps) step(editor);
  };

async function saved(recovery: OwnerYDocOutboxRecovery) {
  const root = await createTestScratch("dohc-live-recovery-");
  const local = { workspaceId: "live-recovery", rootPath: root };
  await openedLocalState(local);
  const copy = await saveLiveRecoveryCopy(
    liveRecoveryPackage(recovery, {
      path: "notes/plan.md",
      reason: "invalid-update",
      storedOn: "this-computer",
    }),
    {
      create: (relative: string, text: string) => createDurableFile(root, relative, text),
      keep: keepOnThisComputer(local),
      exists: existsInWorkspace(local),
    },
    directDocumentProjection,
  );
  return {
    notInNote: copy.notInNote,
    markdown: await readFile(join(root, copy.copyPath!), "utf8"),
  };
}

it.each<[string, Step, Step, boolean, string, string, number]>([
  [
    "a tick on a to-do someone else deleted",
    tick(true),
    (editor) => remove(editor, named("taskList")),
    false,
    NOTE.replace("- [ ] tick me\n\n", ""),
    "Ticked a to-do that was deleted.\n",
    1,
  ],
  [
    "a tick someone else undid at the same moment",
    tick(true),
    both(tick(true), tick(false)),
    false,
    NOTE,
    'Ticked "tick me". The note has it unticked.\n',
    1,
  ],
  [
    "a heading level someone else set at the same moment",
    level(2),
    level(3),
    false,
    NOTE.replace("# Plan", "### Plan"),
    'Set level to 2 on "Plan". The note has 3.\n',
    1,
  ],
  [
    "a heading level on a heading someone else deleted",
    level(2),
    (editor) => remove(editor, named("heading")),
    false,
    NOTE.replace("# Plan\n\n", ""),
    "Set level to 2 on a heading that was deleted.\n",
    1,
  ],
  [
    "a formula someone else changed at the same moment",
    tex("x^3"),
    tex("y"),
    false,
    NOTE.replace("$x^2$", "$y$"),
    'Set tex to "x^3" on a mathInline in "Sum here.". The note has "y".\n',
    1,
  ],
  [
    "a formula someone else deleted",
    tex("x^3"),
    (editor) => remove(editor, named("mathInline")),
    false,
    NOTE.replace("$x^2$", ""),
    'Set tex to "x^3" on a mathInline that was deleted.\n',
    1,
  ],
  [
    "a list made bulleted while someone else kept it numbered",
    list("bulletList"),
    both(list("bulletList"), list("orderedList")),
    false,
    NOTE,
    'Changed "Pack Eat" to a bulletList. The note has it as an orderedList.\n',
    1,
  ],
  [
    "a list made bulleted that someone else deleted",
    list("bulletList"),
    (editor) => remove(editor, named("orderedList")),
    false,
    NOTE.replace("1. Pack\n2. Eat\n\n", ""),
    "Changed a part that was deleted to a bulletList.\n",
    1,
  ],
  [
    "a heading level, and not a tick the kept edit itself took out of its list,",
    both(tick(true), (editor) => command(editor, "tick me", lift), level(2)),
    level(3),
    false,
    NOTE.replace("# Plan", "### Plan").replace("- [ ] tick me", "tick me"),
    'Set level to 2 on "Plan". The note has 3.\n',
    1,
  ],
  [
    "a list's first number, on a list someone else made bulleted",
    list("orderedList", { start: 5 }),
    list("bulletList"),
    false,
    NOTE.replace("1. Pack\n2. Eat", "- Pack\n- Eat"),
    'Set start to 5 on "Pack Eat". The note has it as a bulletList.\n',
    1,
  ],
  [
    "a line taken out of a quote someone else put in a new quote",
    (editor) => command(editor, "one", lift),
    (editor) => {
      command(editor, "one", lift);
      command(editor, "one", wrapIn(editor.view.state.schema.nodes.blockquote!));
    },
    false,
    NOTE.replace("> one\n>\n> two", "> one\n\n> two"),
    'Moved "one". The note has it in another place.\n',
    1,
  ],
  [
    "a tick, and not the starting records of a list the kept edit made, on a to-do someone else deleted",
    both(tick(true), (editor) =>
      command(editor, "Bottom", wrapIn(editor.view.state.schema.nodes.bulletList!)),
    ),
    (editor) => remove(editor, named("taskList")),
    false,
    NOTE.replace("- [ ] tick me\n\n", "").replace("Bottom", "- Bottom"),
    "Ticked a to-do that was deleted.\n",
    1,
  ],
  [
    "text and a rule, and not an empty line, that someone else removed after seeing them",
    (editor) => {
      const end = find(editor, named("paragraph", "Bottom"));
      editor.view.dispatch(
        editor.view.state.tr.setSelection(
          TextSelection.create(editor.view.state.doc, end.pos + end.node.nodeSize - 1),
        ),
      );
      editor.press("Enter");
      editor.type("More words");
      editor.press("Enter");
      editor.put("horizontalRule");
    },
    (editor) => {
      const end = find(editor, named("paragraph", "Bottom"));
      const from = end.pos + end.node.nodeSize;
      editor.view.dispatch(editor.view.state.tr.delete(from, editor.view.state.doc.content.size));
    },
    true,
    NOTE,
    "Text added to a part that was deleted:\n\n> More words\n\n1 more kept edit, such as an image, can't be shown as text.\n",
    2,
  ],
])(
  "lists %s at the end of a format-2 note's readable copy",
  async (_case, mine, theirs, seen, note, listed, count) => {
    const copy = await saved(conflict(mine, theirs, seen));
    expect(copy.markdown).toBe(`${note}\n${LISTED}${listed}`);
    expect(copy.notInNote).toBe(count);
  },
);
