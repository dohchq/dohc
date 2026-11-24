// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { isBodySequenceChange } from "./bodySequenceEditor.js";
import { readBodySequence } from "./bodySequenceYjs.js";
import { person, schema, stopEveryone, type Person } from "./bodySequenceTestSupport.js";
import {
  noteOfLines,
  ORACLE_NOTES,
  ORACLE_KINDS,
  expectNoLineLeftWanting,
  tiptapInsertContentAt,
  dropOfSelection,
  twoParagraphs,
  anotherAttribute,
  random,
  SEEDS,
} from "./bodySequenceEditorTestSupport.js";

afterEach(stopEveryone);

const TWO_STEP_COUNTS = {
  pairs: 2600,
  firstWroteNothing: 556,
  secondWroteNothing: 338,
  undone: 1706,
};

describe("the note reads as the document ProseMirror computed", () => {
  it("reads as before two steps picked at random once both are undone, in every note", () => {
    const select = (a: Person, from: number, to = from) =>
      a.view.dispatch(
        a.view.state.tr.setSelection(TextSelection.create(a.view.state.doc, from, to)),
      );
    const rule = () => schema.nodes.horizontalRule!.create();
    const stepAtRandom = (
      next: () => number,
      doc: ProseMirrorNode,
    ): [string, (a: Person) => void] => {
      const pick = <Option>(options: readonly Option[]) =>
        options[Math.floor(next() * options.length)]!;
      const size = doc.content.size;
      const inText: number[] = [];
      for (let pos = 0; pos <= size; pos++)
        if (doc.resolve(pos).parent.isTextblock) inText.push(pos);
      const anywhere = [Math.floor(next() * (size + 1)), Math.floor(next() * (size + 1))];
      const [one, other] = inText.length > 0 ? [pick(inText), pick(inText)] : anywhere;
      const [from, to] = one! <= other! ? [one!, other!] : [other!, one!];
      const over = `over ${String(from)}-${String(to)}`;
      const [kind, attrs] = pick(ORACLE_KINDS);
      const nodes: [number, ProseMirrorNode][] = [];
      doc.descendants((node, pos) => {
        if (anotherAttribute(node)) nodes.push([pos, node]);
      });
      const steps: [string, (a: Person) => void][] = [
        [
          `delete(${String(Math.min(...anywhere))}, ${String(Math.max(...anywhere))})`,
          (a) =>
            a.view.dispatch(a.view.state.tr.delete(Math.min(...anywhere), Math.max(...anywhere))),
        ],
        [
          `a letter at ${String(from)}`,
          (a) => a.view.dispatch(a.view.state.tr.insertText("x", from)),
        ],
        [
          `a letter typed ${over}`,
          (a) => a.view.dispatch(a.view.state.tr.insertText("Z", from, to)),
        ],
        [
          `Enter ${over}`,
          (a) => {
            select(a, from, to);
            a.press("Enter");
          },
        ],
        [
          `Backspace ${over}`,
          (a) => {
            select(a, from, to);
            a.press("Backspace");
          },
        ],
        [
          `bold ${over}`,
          (a) => {
            select(a, from, to);
            a.toggle("bold");
          },
        ],
        [
          `${kind}${JSON.stringify(attrs ?? {})} ${over}`,
          (a) => {
            select(a, from, to);
            a.retype(kind, attrs);
          },
        ],
        [
          `a divider ${over}`,
          (a) => a.view.dispatch(tiptapInsertContentAt(a.view.state.tr, from, to, rule())),
        ],
        [
          `two paragraphs pasted ${over}`,
          (a) => a.view.dispatch(a.view.state.tr.replaceRange(from, to, twoParagraphs())),
        ],
        [
          `two paragraphs pasted ${over}, the first whole`,
          (a) => a.view.dispatch(a.view.state.tr.replaceRange(from, to, twoParagraphs(0))),
        ],
        [
          `a code block put ${over}`,
          (a) =>
            a.view.dispatch(
              tiptapInsertContentAt(
                a.view.state.tr,
                from,
                to,
                schema.nodes.codeBlock!.create(null, schema.text("X")),
              ),
            ),
        ],
        [
          `a heading and a paragraph put ${over}`,
          (a) =>
            a.view.dispatch(
              tiptapInsertContentAt(a.view.state.tr, from, to, [
                schema.nodes.heading!.create({ level: 2 }, schema.text("X")),
                schema.nodes.paragraph!.create(null, schema.text("Y")),
              ]),
            ),
        ],
        [
          `a delete and a split ${over}`,
          (a) => a.view.dispatch(a.view.state.tr.delete(from, to).split(from)),
        ],
        [
          `a text drag of ${String(from)}-${String(to)} to ${String(anywhere[0])}`,
          (a) => {
            select(a, from, to);
            a.view.dispatch(dropOfSelection(a.view.state, anywhere[0]!));
          },
        ],
      ];
      const blocks: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isBlock && (node.isTextblock || node.isLeaf)) blocks.push(pos);
      });
      if (blocks.length > 0) {
        const pos = pick(blocks);
        steps.push([
          `a block drag of ${String(pos)} to ${String(anywhere[1])}`,
          (a) => {
            a.view.dispatch(
              a.view.state.tr.setSelection(NodeSelection.create(a.view.state.doc, pos)),
            );
            a.view.dispatch(dropOfSelection(a.view.state, anywhere[1]!));
          },
        ]);
      }
      if (nodes.length > 0) {
        const [pos, node] = pick(nodes);
        steps.push([
          `another attribute of the ${node.type.name} at ${String(pos)}`,
          (a) =>
            a.view.dispatch(
              a.view.state.tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                ...anotherAttribute(node),
              }),
            ),
        ]);
      }
      return pick(steps);
    };

    const counted = { pairs: 0, firstWroteNothing: 0, secondWroteNothing: 0, undone: 0 };
    ORACLE_NOTES.forEach(([, lines], which) => {
      const baseline = noteOfLines(lines);
      for (let seed = 1; seed <= SEEDS; seed++) {
        const next = random(seed * 1000 + which);
        const a = person(baseline, 10);
        const before = a.view.state.doc;
        const said: string[] = [];
        let wrote: Transaction | null = null;
        const dispatch = a.view.dispatch.bind(a.view);
        a.view.dispatch = (transaction) => {
          const changes = transaction.docChanged && !isBodySequenceChange(transaction);
          if (changes && a.view.state.applyTransaction(transaction).transactions.length > 0)
            wrote = transaction;
          dispatch(transaction);
        };
        const take = () => {
          const [label, act] = stepAtRandom(next, a.view.state.doc);
          const held = Y.encodeStateAsUpdate(a.doc);
          const sent = a.sent.length;
          const was = a.view.state.doc;
          wrote = null;
          try {
            act(a);
          } catch (error) {
            const cannotBeBuilt = error instanceof Error && error.name === "TransformError";
            if (!(error instanceof RangeError) && !cannotBeBuilt) throw error;
          }
          const applied = wrote as Transaction | null;
          if (a.sent.length === sent || !applied) return false;
          said.push(`${label} in ${was.toString()}`);
          a.expectMirror();
          expectNoLineLeftWanting(held, a.sent.slice(sent), applied, said.join(", then "));
          return true;
        };
        counted.pairs += 1;
        const wroteTheFirst = take();
        const afterTheFirst = a.view.state.doc;
        const wroteBoth = wroteTheFirst && take();
        if (!wroteTheFirst) counted.firstWroteNothing += 1;
        else if (!wroteBoth) counted.secondWroteNothing += 1;
        else {
          for (const [which, was] of [
            ["the second is", afterTheFirst],
            ["both are", before],
          ] as const) {
            expect(a.undo(), said.join(", then ")).toBe(true);
            a.expectMirror();
            const undone = readBodySequence(schema, a.doc);
            if (!undone.eq(was))
              throw new Error(
                `${said.join(", then ")}\n  after ${which} undone the note reads as ${undone.toString()}`,
              );
          }
          counted.undone += 1;
        }
        stopEveryone();
      }
    });
    console.log(
      `two steps and two undos: ${String(counted.pairs)} pairs in ${String(ORACLE_NOTES.length)} notes; the first step wrote nothing ${String(counted.firstWroteNothing)}, the second ${String(counted.secondWroteNothing)}; both written, both undone, and read as before the first ${String(counted.undone)}`,
    );
    if (SEEDS === 40) expect(counted).toEqual(TWO_STEP_COUNTS);
  }, 600_000);
});
