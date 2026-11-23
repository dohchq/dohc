// @vitest-environment jsdom
import { afterEach, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { bodySequencePlugin } from "./bodySequenceEditor.js";
import { createBodyReader } from "./bodySequenceReading.js";
import {
  boundary,
  declared,
  note,
  noteOf,
  page,
  person,
  schema,
  stopEveryone,
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

function editorWithNoPage(baseline: Uint8Array, clientID: number) {
  const base = page(baseline, clientID);
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
  return { ...base, view };
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

  const seats: [string, ReturnType<typeof editorWithNoPage>][] = [];
  const mounted = performance.now();
  seats.push(["no page drawn", editorWithNoPage(baseline, 20)]);
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
      const caret = (offset: number) => {
        let pos = 0;
        for (let block = 0; block < at; block++) pos += view.state.doc.child(block).nodeSize;
        const size = view.state.doc.child(at).content.size;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(view.state.doc, pos + 1 + Math.min(offset, size)),
          ),
        );
      };
      const label = `${name}, ${seat}, ${where}`;
      caret(30);
      report.push(
        `${label}: one typed letter, editor to sequence: ${median(() =>
          view.dispatch(view.state.tr.insertText("x")),
        )}`,
      );
      sync();
      let update: Uint8Array = new Uint8Array();
      report.push(
        `${label}: one letter from elsewhere, update to editor: ${median(
          () => each.receive(update),
          {
            before() {
              const index = Math.round((other.sequence.length * at) / blocks);
              other.sequence.insert(index, "y", {});
              update = Y.mergeUpdates(other.sent.splice(0));
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
    const timed = (...acts: ((view: EditorView) => void)[]) => {
      const { view } = editorWithNoPage(headed, 40);
      return acts.map((act) => {
        const start = performance.now();
        act(view);
        return `${(performance.now() - start).toFixed(1)} ms`;
      });
    };
    const typed = timed(
      (view) => view.dispatch(view.state.tr.insertText("x", 30)),
      (view) => view.dispatch(view.state.tr.insertText("x", 31)),
    );
    const edits = "10,000 paragraphs, the first with no boundary";
    report.push(
      `${edits}: the first letter typed in its middle, which gives it its boundary first, once: ${typed[0]!}`,
      `${edits}: the next letter typed there, once the line has its boundary: ${typed[1]!}`,
      `${edits}: one Enter in its middle, once: ${timed((view) => view.dispatch(view.state.tr.split(30)))[0]!}`,
      `${edits}: one Enter at its start, once: ${timed((view) => view.dispatch(view.state.tr.split(1)))[0]!}`,
    );
    console.log(report.join("\n"));
  },
  900_000,
);
