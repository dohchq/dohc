// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import type { Attrs, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
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

function conflict(
  mine: Step,
  theirs: Step,
  seen = false,
  { note = NOTE, before, owner = 1 }: { note?: string; before?: Step; owner?: number } = {},
): OwnerYDocOutboxRecovery {
  const start = markdownToYDoc(note, { bodySequence: true });
  let baseUpdate = Y.encodeStateAsUpdate(start);
  start.destroy();
  if (before) {
    const author = person(baseUpdate, 3);
    before(author);
    baseUpdate = Y.encodeStateAsUpdate(author.doc);
  }
  const me = person(baseUpdate, owner);
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
const heading = (to: number) => (editor: Person) =>
  markup(editor, named("paragraph", "Start here."), "heading", { level: to });
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

function afterBottom(editor: Person) {
  const end = find(editor, named("paragraph", "Bottom"));
  editor.view.dispatch(
    editor.view.state.tr.setSelection(
      TextSelection.create(editor.view.state.doc, end.pos + end.node.nodeSize - 1),
    ),
  );
  editor.press("Enter");
}

function removeAfterBottom(editor: Person) {
  const end = find(editor, named("paragraph", "Bottom"));
  const from = end.pos + end.node.nodeSize;
  editor.view.dispatch(editor.view.state.tr.delete(from, editor.view.state.doc.content.size));
}

function atEndOfBottom(editor: Person) {
  const end = find(editor, named("paragraph", "Bottom"));
  editor.view.dispatch(
    editor.view.state.tr.setSelection(
      TextSelection.create(editor.view.state.doc, end.pos + end.node.nodeSize - 1),
    ),
  );
}

const recorded = (from: string, to: string) => (editor: Person) => {
  const [id] = [...editor.containers.entries()].find(([, type]) => type === from)!;
  editor.doc.transact(() => editor.containers.set(id, to));
};

const nothing: Step = () => {};

const LOOSE_TODO = NOTE.replace("- [ ] tick me\n\n", "- [ ] tick me\n\n  second\n\n");

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
      afterBottom(editor);
      editor.type("More words");
      editor.press("Enter");
      editor.put("horizontalRule");
    },
    removeAfterBottom,
    true,
    NOTE,
    "Text added to a part that was deleted:\n\n> More words\n\n1 more kept edit, such as an image, can't be shown as text.\n",
    2,
  ],
  [
    "the last of two heading levels the kept edit set, against one someone else set",
    both(level(2), level(4)),
    level(3),
    false,
    NOTE.replace("# Plan", "### Plan"),
    'Set level to 4 on "Plan". The note has 3.\n',
    1,
  ],
  [
    "the last of two first numbers the kept edit set, against one someone else set",
    both(list("orderedList", { start: 5 }), list("orderedList", { start: 6 })),
    list("orderedList", { start: 9 }),
    false,
    NOTE.replace("1. Pack\n2. Eat", "9. Pack\n10. Eat"),
    'Set start to 6 on "Pack Eat". The note has 9.\n',
    1,
  ],
  [
    "a heading level on a line someone else made a code block",
    level(2),
    (editor) => markup(editor, named("heading", "Plan"), "codeBlock", {}),
    false,
    NOTE.replace("# Plan", "```\nPlan\n```"),
    'Set level to 2 on "Plan". The note has it as a codeBlock.\n',
    1,
  ],
  [
    "a first number on a list someone else's record made unreadable as a list",
    list("orderedList", { start: 5 }),
    recorded("orderedList", "table"),
    false,
    NOTE.replace("1. Pack\n2. Eat", "Pack\n\nEat"),
    'Set start to 5 on "Pack Eat". The note has no value.\n',
    1,
  ],
  [
    "text on each side of a formula, quoted apart, that someone else removed after seeing it",
    (editor) => {
      afterBottom(editor);
      editor.type("Before");
      editor.put("mathInline", { tex: "x" });
      editor.type("After");
    },
    removeAfterBottom,
    true,
    NOTE,
    "Text added to a part that was deleted:\n\n> Before\n\nText added to a part that was deleted:\n\n> After\n\n1 more kept edit, such as an image, can't be shown as text.\n",
    3,
  ],
  [
    "a line taken out of a quote, which someone else deleted",
    (editor) => command(editor, "one", lift),
    (editor) => remove(editor, named("paragraph", "one")),
    false,
    NOTE.replace("> one\n>\n> two", "> two"),
    "Moved a paragraph that was deleted.\n",
    1,
  ],
  [
    "a line made a heading, which someone else deleted",
    (editor) => markup(editor, named("paragraph", "Start here."), "heading", { level: 2 }),
    (editor) => remove(editor, named("paragraph", "Start here.")),
    false,
    NOTE.replace("Start here.\n\n", ""),
    "Changed a part that was deleted to a heading.\n",
    1,
  ],
  [
    "a first number someone else replaced, on a list they then made bulleted",
    list("orderedList", { start: 5 }),
    both(list("orderedList", { start: 9 }), list("bulletList")),
    false,
    NOTE.replace("1. Pack\n2. Eat", "- Pack\n- Eat"),
    'Set start to 5 on "Pack Eat". The note has it as a bulletList.\n',
    1,
  ],
  [
    "a line made a heading, and not its level, which someone else made a code block",
    heading(2),
    (editor) => markup(editor, named("paragraph", "Start here."), "codeBlock", {}),
    false,
    NOTE.replace("Start here.", "```\nStart here.\n```"),
    'Changed "Start here." to a heading. The note has it as a codeBlock.\n',
    1,
  ],
  [
    "a heading level on a line someone else also made a heading",
    heading(2),
    heading(3),
    false,
    NOTE.replace("Start here.", "### Start here."),
    'Set level to 2 on "Start here.". The note has 3.\n',
    1,
  ],
  [
    "a heading level, and not a line the kept edit made a heading,",
    both(heading(2), level(2)),
    level(3),
    false,
    NOTE.replace("# Plan", "### Plan").replace("Start here.", "## Start here."),
    'Set level to 2 on "Plan". The note has 3.\n',
    1,
  ],
  [
    "a rule made from a new line, that someone else removed after seeing it",
    (editor) => {
      afterBottom(editor);
      markup(
        editor,
        (node) => node.type.name === "paragraph" && node.content.size === 0,
        "horizontalRule",
        {},
      );
    },
    removeAfterBottom,
    true,
    NOTE,
    "1 more kept edit, such as an image, can't be shown as text.\n",
    1,
  ],
  [
    "nothing for a heading level the kept edit set before making the line a paragraph",
    both(level(2), (editor) => markup(editor, named("heading", "Plan"), "paragraph", {})),
    nothing,
    false,
    NOTE.replace("# Plan", "Plan"),
    "",
    0,
  ],
  [
    "nothing for a first number the kept edit set before making the list bulleted",
    both(list("orderedList", { start: 5 }), list("bulletList")),
    nothing,
    false,
    NOTE.replace("1. Pack\n2. Eat", "- Pack\n- Eat"),
    "",
    0,
  ],
  [
    "nothing for a tick the kept edit set before making the to-do list bulleted",
    both(tick(true), (editor) => {
      const { node, pos } = find(editor, named("taskList"));
      const { schema } = editor.view.state;
      const items: ProseMirrorNode[] = [];
      node.forEach((item) => items.push(schema.nodes.listItem!.create(null, item.content)));
      editor.view.dispatch(
        editor.view.state.tr.replaceWith(
          pos,
          pos + node.nodeSize,
          schema.nodes.bulletList!.create(null, items),
        ),
      );
    }),
    nothing,
    false,
    NOTE.replace("- [ ] tick me", "- tick me"),
    "",
    0,
  ],
  [
    "a move and a change of kind on a line someone else deleted",
    both(
      (editor) => command(editor, "one", lift),
      (editor) => markup(editor, named("paragraph", "one"), "heading", { level: 2 }),
    ),
    (editor) => remove(editor, named("paragraph", "one")),
    false,
    NOTE.replace("> one\n>\n> two", "> two"),
    "Moved a heading that was deleted.\n\nChanged a part that was deleted to a heading.\n",
    2,
  ],
  [
    "a heading level someone else replaced on a line they then made a code block",
    level(2),
    both(level(3), (editor) => markup(editor, named("heading", "Plan"), "codeBlock", {})),
    false,
    NOTE.replace("# Plan", "```\nPlan\n```"),
    'Set level to 2 on "Plan". The note has it as a codeBlock.\n',
    1,
  ],
  [
    "a heading level someone else also set on a line they then made a code block",
    level(2),
    both(level(2), (editor) => markup(editor, named("heading", "Plan"), "codeBlock", {})),
    false,
    NOTE.replace("# Plan", "```\nPlan\n```"),
    'Set level to 2 on "Plan". The note has it as a codeBlock.\n',
    1,
  ],
  [
    "nothing for a formula the kept edit added and removed, after someone else saw it",
    (editor) => {
      atEndOfBottom(editor);
      editor.put("mathInline", { tex: "x" });
      const { from } = editor.view.state.selection;
      editor.view.dispatch(editor.view.state.tr.delete(from - 1, from));
    },
    level(3),
    true,
    NOTE.replace("# Plan", "### Plan"),
    "",
    0,
  ],
  [
    "a tick on a to-do someone else's record made unreadable as a list",
    tick(true),
    recorded("taskList", "table"),
    false,
    NOTE.replace("- [ ] tick me", "tick me"),
    'Ticked "tick me". The note doesn\'t show it as a to-do.\n',
    1,
  ],
  [
    "a list made bulleted that someone else's record made unreadable as a list",
    list("bulletList"),
    recorded("orderedList", "table"),
    false,
    NOTE.replace("1. Pack\n2. Eat", "Pack\n\nEat"),
    'Changed "Pack Eat" to a bulletList. The note doesn\'t show it as a bulletList.\n',
    1,
  ],
])(
  "lists %s at the end of a format-2 note's readable copy",
  async (_case, mine, theirs, seen, note, listed, count) => {
    const copy = await saved(conflict(mine, theirs, seen));
    expect(copy.markdown).toBe(listed === "" ? note : `${note}\n${LISTED}${listed}`);
    expect(copy.notInNote).toBe(count);
  },
);

it("lists nothing for a tick the kept edit itself took out of its list, after an older change to that list", async () => {
  const copy = await saved(
    conflict(
      both(tick(true), (editor) => command(editor, "tick me", lift)),
      level(3),
      false,
      {
        note: LOOSE_TODO,
        before: (editor) => remove(editor, named("paragraph", "second")),
      },
    ),
  );
  expect(copy.markdown).toBe(
    NOTE.replace("# Plan", "### Plan").replace("- [ ] tick me", "tick me"),
  );
  expect(copy.notInNote).toBe(0);
});

it("lists a tick on a to-do someone else's bulleted list shows as a list item", async () => {
  const copy = await saved(
    conflict(
      both(
        (editor) => {
          const { node, pos } = find(editor, named("orderedList"));
          const { schema } = editor.view.state;
          const items: ProseMirrorNode[] = [];
          node.forEach((item) =>
            items.push(schema.nodes.taskItem!.create({ checked: false }, item.content)),
          );
          editor.view.dispatch(
            editor.view.state.tr.replaceWith(
              pos,
              pos + node.nodeSize,
              schema.nodes.taskList!.create(null, items),
            ),
          );
        },
        (editor) => markup(editor, named("taskItem", "Pack"), null, { checked: true }),
      ),
      list("bulletList"),
    ),
  );
  expect(copy.markdown).toContain('Set checked to true on "Pack". The note has it as a listItem.');
  expect(copy.notInNote).toBe(2);
});

it("lists nothing for a to-do the kept edit ticked and took out of its list, when that move wins over someone else putting the list in a quote", async () => {
  const copy = await saved(
    conflict(
      both(tick(true), (editor) => command(editor, "tick me", lift)),
      (editor) => {
        const { view } = editor;
        const { pos } = find(editor, named("taskList"));
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
        if (!wrapIn(view.state.schema.nodes.blockquote!)(view.state, view.dispatch))
          throw new Error("the command did nothing");
      },
      false,
      { owner: 4 },
    ),
  );
  expect(copy.markdown).toBe(NOTE.replace("- [ ] tick me", "tick me"));
  expect(copy.notInNote).toBe(0);
});
