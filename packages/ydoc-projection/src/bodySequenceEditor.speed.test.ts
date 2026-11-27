// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { lift, wrapIn } from "@tiptap/pm/commands";
import { liftListItem, wrapInList } from "@tiptap/pm/schema-list";
import { EditorState, TextSelection, type Command } from "@tiptap/pm/state";
import { addColumnAfter, setCellAttr } from "@tiptap/pm/tables";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { bodySequenceAnchor, bodySequencePlugin } from "./bodySequenceEditor.js";
import { toggleListCommand } from "./browser-editor.js";
import { recordsOfContainer } from "./bodySequenceGrammar.js";
import { bodySequenceChangeLimit, bodySequenceChangeSize } from "./bodySequenceIntake.js";
import { createBodyReader } from "./bodySequenceReading.js";
import { WORKER_LIVE_VALIDATION_POLICY } from "./liveValidationPolicy.js";
import {
  boundary,
  declared,
  element,
  note,
  noteOf,
  onStop,
  page,
  person,
  schema,
  stopEveryone,
  type Page,
} from "./bodySequenceTestSupport.js";
import { readBodySequence } from "./bodySequenceYjs.js";

afterEach(stopEveryone);

const LETTERS = 60;
const SAMPLES = 100;
const LINE = "abcdefghij".repeat(LETTERS / 10);

function median(
  run: () => void,
  around: { before?: () => void; after?: () => void; samples?: number } = {},
): string {
  const times: number[] = [];
  for (let sample = 0; sample < (around.samples ?? SAMPLES); sample++) {
    around.before?.();
    const start = performance.now();
    run();
    times.push(performance.now() - start);
    around.after?.();
  }
  times.sort((a, b) => a - b);
  return `${times[Math.floor(times.length / 2)]!.toFixed(3)} ms`;
}

function editorWithNoPage(base: { sequence: Y.Text; containers: Y.Map<unknown> }) {
  const plugin = bodySequencePlugin({ sequence: base.sequence, containers: base.containers });
  let state = EditorState.create({ schema, plugins: [plugin] });
  let bound: ReturnType<NonNullable<typeof plugin.spec.view>> | undefined;
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
      const before = state;
      state = state.apply(transaction);
      bound?.update?.(view, before);
    },
  } as unknown as EditorView;
  bound = plugin.spec.view!(view);
  return { view, release: () => bound?.destroy?.() };
}

function noteWithHistory(lines: number, edits: number): Uint8Array {
  const people = [2, 3, 4].map((clientID) => {
    const made = declared(clientID);
    Y.applyUpdate(made.doc, note(...Array.from({ length: lines }, () => LINE)));
    return made;
  });
  let state = 7;
  const pick = (below: number) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * below);
  };
  for (let edit = 0; edit < edits; edit++) {
    const { doc, sequence } = people[edit % people.length]!;
    const at = pick(sequence.length);
    const roll = pick(10);
    if (roll < 6) sequence.insert(at, "x", {});
    else if (roll < 8) sequence.delete(at, 1);
    else if (roll < 9) sequence.insertEmbed(at, boundary(), {});
    else sequence.format(at, 1 + pick(5), { bold: {} });
    if (edit % 50 === 49)
      for (const other of people)
        if (other.doc !== doc)
          Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other.doc)));
  }
  for (const from of people)
    for (const to of people)
      if (from !== to)
        Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
  const baseline = Y.encodeStateAsUpdate(people[0]!.doc);
  for (const each of people) each.doc.destroy();
  return baseline;
}

function measure(name: string, baseline: Uint8Array, drawn: boolean): string[] {
  const report: string[] = [`${name}: the note's update is ${String(baseline.length)} bytes`];
  const reader = declared(90);
  Y.applyUpdate(reader.doc, baseline);
  let items = 0;
  for (let item = reader.sequence._start; item !== null; item = item.right) items++;
  report.push(`${name}: the sequence holds ${String(items)} items, deleted ones included`);
  report.push(
    `${name}: read the note with readBodySequence: ${median(() => readBodySequence(schema, reader.doc), { samples: 11 })}`,
  );
  report.push(
    `${name}: build the editor document, with the positions behind each block: ${median(
      () => createBodyReader(schema, reader.sequence, reader.containers).reading(),
      { samples: 11 },
    )}`,
  );
  reader.doc.destroy();

  const seats: [string, Page & { view: EditorView }][] = [];
  const mounted = performance.now();
  const bare = page(baseline, 20);
  const mount = editorWithNoPage(bare);
  onStop(mount.release);
  seats.push(["no page drawn", { ...bare, view: mount.view }]);
  report.push(
    `${name}: mount the editor state and the plugin, once: ${(performance.now() - mounted).toFixed(0)} ms`,
  );
  if (drawn) {
    const drawing = performance.now();
    seats.push(["drawn in jsdom", person(baseline, 10)]);
    report.push(
      `${name}: mount a drawn editor (jsdom), once: ${(performance.now() - drawing).toFixed(0)} ms`,
    );
  }

  for (const [seat, each] of seats) {
    const { view } = each;
    const other = page(baseline, 30 + seats.length);
    for (const update of each.sent.splice(0)) other.receive(update);
    const sync = () => {
      for (const update of each.sent.splice(0)) other.receive(update);
    };
    const blocks = view.state.doc.childCount;
    for (const [where, at] of [
      ["first line", 0],
      ["middle line", Math.floor(blocks / 2)],
      ["last line", blocks - 1],
    ] as const) {
      const inIt = (offset: number) => {
        let pos = 0;
        for (let block = 0; block < at; block++) pos += view.state.doc.child(block).nodeSize;
        return pos + 1 + Math.min(offset, view.state.doc.child(at).content.size);
      };
      const caret = (offset: number) =>
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, inIt(offset))),
        );
      const label = `${name}, ${seat}, ${where}`;
      caret(30);
      report.push(
        `${label}: one typed letter, editor to sequence: ${median(() =>
          view.dispatch(view.state.tr.insertText("x")),
        )}`,
      );
      sync();
      let update: Uint8Array = new Uint8Array();
      let size = 0;
      report.push(
        `${label}: one letter from elsewhere, update to editor: ${median(
          () => each.receive(update),
          {
            before() {
              size = view.state.doc.child(at).content.size;
              const anchor = bodySequenceAnchor(view.state, inIt(30))!;
              const there = Y.createAbsolutePositionFromRelativePosition(anchor, other.doc)!;
              other.sequence.insert(there.index, "y", {});
              update = Y.mergeUpdates(other.sent.splice(0));
            },
            after() {
              const { doc } = view.state;
              if (doc.childCount !== blocks || doc.child(at).content.size !== size + 1)
                throw new Error(`${label}: the letter from elsewhere is not in that line`);
            },
          },
        )}`,
      );
      const split = () => view.dispatch(view.state.tr.split(view.state.selection.from));
      const join = () => view.dispatch(view.state.tr.join(view.state.selection.$from.before()));
      caret(20);
      report.push(`${label}: one Enter: ${median(split, { after: join })}`);
      report.push(`${label}: one Backspace that joins: ${median(join, { before: split })}`);
      sync();
    }
  }
  return report;
}

it.skipIf(!process.env.BODY_SEQUENCE_SPEED)(
  "measures an editor on a long note and on a note with a long history",
  () => {
    const long = note(...Array.from({ length: 10_000 }, () => LINE));
    const report = [
      ...measure(
        "10,000 paragraphs of 60 letters",
        long,
        process.env.BODY_SEQUENCE_SPEED === "drawn",
      ),
      ...measure(
        "2,000 lines after 20,000 edits by 3 people",
        noteWithHistory(2_000, 20_000),
        false,
      ),
    ];
    const headed = noteOf(({ sequence }) => {
      sequence.insert(0, LINE, {});
      for (let line = 1; line < 10_000; line++) {
        sequence.insertEmbed(sequence.length, boundary(), {});
        sequence.insert(sequence.length, LINE, {});
      }
    });
    const code = () => boundary({ type: "codeBlock", language: null });
    const underCodeWith = (third: [Y.XmlElement, string]) =>
      noteOf(({ sequence }) => {
        sequence.insertEmbed(0, code(), {});
        sequence.insert(sequence.length, LINE, {});
        sequence.insertEmbed(sequence.length, element("wikilink", { target: "Page" }), {});
        sequence.insert(sequence.length, "tail", {});
        for (let line = 1; line < 10_000; line++) {
          const [start, text] = line === 2 ? third : [boundary(), LINE];
          sequence.insertEmbed(sequence.length, start, {});
          sequence.insert(sequence.length, text, {});
        }
      });
    const underCode = underCodeWith([boundary(), LINE]);
    const timed = (...acts: ((view: EditorView) => void)[]): string[] => timedOn(headed, ...acts);
    const timedOn = (baseline: Uint8Array, ...acts: ((view: EditorView, doc: Y.Doc) => void)[]) => {
      const runs = Array.from({ length: 5 }, () => {
        const base = declared(40);
        Y.applyUpdate(base.doc, baseline);
        const { view, release } = editorWithNoPage(base);
        try {
          return acts.map((act) => {
            const start = performance.now();
            act(view, base.doc);
            return performance.now() - start;
          });
        } finally {
          release();
          base.doc.destroy();
        }
      });
      return acts.map((_, act) => {
        const times = runs.map((run) => run[act]!).toSorted((a, b) => a - b);
        return `${times[2]!.toFixed(1)} ms`;
      });
    };
    const typed = timed(
      (view) => view.dispatch(view.state.tr.insertText("x", 30)),
      (view) => view.dispatch(view.state.tr.insertText("x", 31)),
    );
    const edits = "10,000 paragraphs, the first with no boundary";
    const lastThousandAsHeadings = (() => {
      const peer = declared(50);
      Y.applyUpdate(peer.doc, long);
      const had = Y.encodeStateVector(peer.doc);
      peer.doc.transact(() => {
        const boundaries = (peer.sequence.toDelta() as { insert: unknown }[]).flatMap(
          ({ insert }) => (insert instanceof Y.XmlElement ? [insert] : []),
        );
        for (const each of boundaries.slice(-1_000)) {
          each.setAttribute("type", "heading");
          each.setAttribute("level", 1 as unknown as string);
        }
      });
      const update = Y.encodeStateAsUpdate(peer.doc, had);
      peer.doc.destroy();
      return update;
    })();
    const manyKinds = timedOn(long, (view, doc) => {
      Y.applyUpdate(doc, lastThousandAsHeadings);
      if (view.state.doc.lastChild!.type.name !== "heading")
        throw new Error("the editor does not show the headings");
    });
    report.push("each time below is the median of five editors mounted anew on the note");
    report.push(
      `10,000 paragraphs of 60 letters: one change from elsewhere that makes the last 1,000 of them headings, update to editor: ${manyKinds[0]!}`,
    );
    report.push(
      `${edits}: the first letter typed in its middle, which gives it its boundary first: ${typed[0]!}`,
      `${edits}: the next letter typed there, once the line has its boundary: ${typed[1]!}`,
      `${edits}: one Enter in its middle: ${timed((view) => view.dispatch(view.state.tr.split(30)))[0]!}`,
      `${edits}: one Enter at its start: ${timed((view) => view.dispatch(view.state.tr.split(1)))[0]!}`,
    );
    const codeEnd = 1 + LETTERS;
    const paragraph = codeEnd + 1;
    const under = paragraph + 7;
    const below = under + LETTERS + 2;
    const inCode = timedOn(
      underCode,
      (view) => view.dispatch(view.state.tr.insertText("x", codeEnd)),
      (view) => view.dispatch(view.state.tr.insertText("x", codeEnd + 1)),
    );
    const language = timedOn(
      underCode,
      (view) => view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { language: "js" })),
      (view) => view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { language: "ts" })),
    );
    const joined = timedOn(
      underCode,
      (view) => view.dispatch(view.state.tr.join(under)),
      (view) => view.dispatch(view.state.tr.insertText("x", paragraph + 3)),
    );
    const joinedAboveCode = timedOn(
      underCodeWith([
        code(),
        `${LINE}
`,
      ]),
      (view) => view.dispatch(view.state.tr.join(under)),
    );
    const cut = timedOn(
      underCode,
      (view) => view.dispatch(view.state.tr.delete(codeEnd - 1, paragraph + 2)),
      (view) => view.dispatch(view.state.tr.insertText("x", codeEnd - 1)),
    );
    const divided = timedOn(
      underCode,
      (view) =>
        view.dispatch(view.state.tr.replaceWith(0, 0, schema.nodes.horizontalRule!.create())),
      (view) =>
        view.dispatch(view.state.tr.replaceWith(0, 0, schema.nodes.horizontalRule!.create())),
    );
    const apart = timedOn(
      underCode,
      (view) => view.dispatch(view.state.tr.join(below)),
      (view) => view.dispatch(view.state.tr.split(below - 1)),
      (view) => view.dispatch(view.state.tr.join(below)),
      (view) => view.dispatch(view.state.tr.split(below - 1)),
      (view) => view.dispatch(view.state.tr.join(below)),
    );
    const drag = (from: number, to: number, at: number) => (view: EditorView) => {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
      const { state } = view;
      const slice = state.selection.content();
      const dropped = state.tr.deleteSelection();
      const pos = dropped.mapping.map(dropPoint(state.doc, at, slice) ?? at);
      view.dispatch(dropped.replaceRange(pos, pos, slice));
    };
    const dragged = timedOn(underCode, drag(under + 3, under + 9, below + 5));
    const underAParagraph = noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary(), {});
      sequence.insert(sequence.length, LINE, {});
      sequence.insertEmbed(sequence.length, code(), {});
      sequence.insert(sequence.length, LINE, {});
      sequence.insertEmbed(sequence.length, element("wikilink", { target: "Page" }), {});
      sequence.insert(sequence.length, "tail", {});
      for (let line = 2; line < 10_000; line++) {
        sequence.insertEmbed(sequence.length, boundary(), {});
        sequence.insert(sequence.length, LINE, {});
      }
    });
    const refused = timedOn(underAParagraph, drag(30, 2 * (LETTERS + 2) + 1, 10));
    const spill = "10,000 paragraphs under a code block whose paragraph after it has no boundary";
    report.push(
      `${spill}: the first letter typed at the code block's end: ${inCode[0]!}`,
      `${spill}: the second letter typed there: ${inCode[1]!}`,
      `${spill}: the code block's language changed: ${language[0]!}`,
      `${spill}: its language changed again: ${language[1]!}`,
      `${spill}: the paragraph under that paragraph joined into it, which gives it its boundary first: ${joined[0]!}`,
      `${spill}: the next letter typed in it: ${joined[1]!}`,
      `${spill}: the same join when the block under the two is a code block that ends in a line feed: ${joinedAboveCode[0]!}`,
      `${spill}: a selection from the code into that paragraph deleted, which gives it its boundary first: ${cut[0]!}`,
      `${spill}: the next letter typed at the code block's end: ${cut[1]!}`,
      `${spill}: a divider put above the code block, which gives that paragraph its boundary first: ${divided[0]!}`,
      `${spill}: a second divider put above it: ${divided[1]!}`,
      `${spill}: the two paragraphs under that paragraph joined, which leaves it as it is, then split and joined again: ${apart.join(", ")}`,
      `${spill}: text dragged within the paragraph under that paragraph into the next one: ${dragged[0]!}`,
      `10,000 paragraphs, the second a code block whose paragraph after it has no boundary: text dragged from the first paragraph across the code block to that paragraph's start and dropped in the first paragraph, which is refused: ${refused[0]!}`,
    );
    console.log(report.join("\n"));
  },
  900_000,
);

function selectLines(view: EditorView, first: number, last: number): void {
  const starts: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock) starts.push(pos + 1);
    return !node.isTextblock;
  });
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, starts[first]!, starts[last]!)),
  );
}

it("writes container changes to 1,000 lines of a note of 10,000 paragraphs in time, each within the room's limits", () => {
  const long = note(...Array.from({ length: 10_000 }, () => LINE));
  const base = page(long, 60);
  const { view, release } = editorWithNoPage(base);
  onStop(release);
  const other = page(long, 61);
  const report: string[] = [];
  const act = (name: string, command: Command, lines: number) => {
    selectLines(view, 0, lines - 1);
    const from = base.sent.length;
    const start = performance.now();
    expect(command(view.state, view.dispatch), name).toBe(true);
    const took = performance.now() - start;
    const updates = base.sent.slice(from);
    expect(updates, name).not.toHaveLength(0);
    for (const update of updates) {
      expect(bodySequenceChangeLimit(update, WORKER_LIVE_VALIDATION_POLICY), name).toBeUndefined();
      const { structs, values, deletes } = bodySequenceChangeSize(update);
      report.push(
        `${name}: ${took.toFixed(0)} ms, ${String(update.length)} bytes, ${String(structs)} items, ${String(values)} values, ${String(deletes)} delete ranges`,
      );
      other.receive(update);
    }
    expect(readBodySequence(schema, other.doc).eq(view.state.doc), name).toBe(true);
    return took;
  };
  expect(act("1,000 lines put in a quote", wrapIn(schema.nodes.blockquote!), 1_000)).toBeLessThan(
    1_000,
  );
  expect(view.state.doc.child(0).childCount).toBe(1_000);
  expect(act("the quote taken off them", lift, 1_000)).toBeLessThan(1_000);
  expect(view.state.doc.child(0).type.name).toBe("paragraph");
  act("1,000 lines made a bullet list", wrapInList(schema.nodes.bulletList!), 1_000);
  expect(
    act(
      "the list made a to-do list on the share page",
      toggleListCommand(schema, "taskList"),
      1_000,
    ),
  ).toBeLessThan(1_000);
  expect(view.state.doc.child(0).type.name).toBe("taskList");
  act("the to-do list turned off", liftListItem(schema.nodes.taskItem!), 1_000);
  expect(view.state.doc.childCount).toBe(10_000);
  console.log(report.join("\n"));
});

it("writes a column added to a table of 1,000 rows above 9,000 paragraphs, and a cell setting on it, in time, each within the room's limits", () => {
  const table = noteOf(({ sequence, containers }) => {
    const records = (id: string, type: string) => {
      for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
        containers.set(key, value);
    };
    records("TB", "table");
    for (let row = 0; row < 1_000; row++) {
      records(`R${String(row)}`, "tableRow");
      records(`C${String(row)}`, "tableCell");
      const path = ["TB", `R${String(row)}`, `C${String(row)}`];
      sequence.insertEmbed(sequence.length, boundary({ path }), {});
      sequence.insert(sequence.length, LINE, {});
    }
    for (let line = 0; line < 9_000; line++) {
      sequence.insertEmbed(sequence.length, boundary(), {});
      sequence.insert(sequence.length, LINE, {});
    }
  });
  const base = page(table, 62);
  const { view, release } = editorWithNoPage(base);
  onStop(release);
  const other = page(table, 63);
  const report: string[] = [];
  const act = (name: string, command: Command) => {
    const from = base.sent.length;
    const start = performance.now();
    expect(command(view.state, view.dispatch), name).toBe(true);
    const took = performance.now() - start;
    const updates = base.sent.slice(from);
    expect(updates, name).toHaveLength(1);
    expect(
      bodySequenceChangeLimit(updates[0]!, WORKER_LIVE_VALIDATION_POLICY),
      name,
    ).toBeUndefined();
    const { structs, values } = bodySequenceChangeSize(updates[0]!);
    report.push(
      `${name}: ${took.toFixed(0)} ms, ${String(updates[0]!.length)} bytes, ${String(structs)} items, ${String(values)} values`,
    );
    other.receive(updates[0]!);
    expect(readBodySequence(schema, other.doc).eq(view.state.doc), name).toBe(true);
    return took;
  };
  const row = view.state.doc.child(0).child(0).nodeSize;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4 + row * 500)));
  expect(act("a column added to 1,000 rows", addColumnAfter)).toBeLessThan(3_000);
  expect(view.state.doc.child(0).child(0).childCount).toBe(2);
  expect(act("a cell of it centered", setCellAttr("align", "center"))).toBeLessThan(1_000);
  console.log(report.join("\n"));
});

it.skipIf(!process.env.BODY_SEQUENCE_SPEED)("measures a tick in to-do lists of each length", () => {
  const report: string[] = [];
  for (const [items, around] of [
    [100, 0],
    [1_000, 0],
    [10_000, 0],
    [10, 9_990],
  ] as const) {
    const list = noteOf(({ sequence, containers }) => {
      const records = (id: string, type: string) => {
        for (const [key, value] of recordsOfContainer(schema, { id, type, attrs: {} }))
          containers.set(key, value);
      };
      records("T", "taskList");
      for (let item = 0; item < items; item++) {
        records(`K${String(item)}`, "taskItem");
        sequence.insertEmbed(sequence.length, boundary({ path: ["T", `K${String(item)}`] }), {});
        sequence.insert(sequence.length, LINE, {});
      }
      for (let line = 0; line < around; line++) {
        sequence.insertEmbed(sequence.length, boundary(), {});
        sequence.insert(sequence.length, LINE, {});
      }
    });
    const base = page(list, 70);
    const { view, release } = editorWithNoPage(base);
    onStop(release);
    const pos = 1 + Math.floor(items / 2) * view.state.doc.child(0).child(0).nodeSize;
    const sent = base.sent.length;
    const took = median(
      () => {
        const { attrs } = view.state.doc.nodeAt(pos)!;
        view.dispatch(
          view.state.tr.setNodeMarkup(pos, undefined, { ...attrs, checked: !attrs.checked }),
        );
      },
      { samples: 5 },
    );
    expect(base.sent.length - sent).toBe(5);
    const name =
      around === 0
        ? `${items.toLocaleString("en-US")} to-dos`
        : `${items.toLocaleString("en-US")} to-dos above ${around.toLocaleString("en-US")} paragraphs`;
    report.push(`a tick in the middle of ${name}, editor to sequence: ${took}`);
  }
  console.log(report.join("\n"));
});
