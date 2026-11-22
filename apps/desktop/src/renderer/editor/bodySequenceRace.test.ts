// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import {
  DohcMarkdownTable,
  DohcTaskItem,
  MarkdownBulletList,
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownTaskList,
} from "@dohc/ydoc-projection/markdown-extensions";
import {
  createBodySequenceHistory,
  isBodySequenceChange,
} from "@dohc/ydoc-projection/body-sequence-editor";
import { BodySequence } from "@dohc/ydoc-projection/body-sequence-tiptap";
import {
  exchange,
  LINES,
  note,
  onStop,
  page,
  person,
  quiet,
  raceTests,
  stopEveryone,
  withEditor,
  type Effects,
} from "@dohc/ydoc-projection/body-sequence-testing";
import { desktopMarkdownExtensions } from "./extensions";
import { ListConversions } from "./listEditing";

afterEach(stopEveryone);

const BOUNDARY = { ...quiet(), boundaries: 1, attributes: 2 };

function desktop(baseline: Uint8Array, clientID: number) {
  const base = page(baseline, clientID);
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const history = createBodySequenceHistory(base.doc, { captureTimeout: 0 });
  const shown = { count: 0 };
  const editor = new Editor({
    element,
    extensions: [
      ...desktopMarkdownExtensions,
      StarterKit.configure({
        trailingNode: false,
        undoRedo: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      ListConversions,
      MarkdownBulletList,
      MarkdownListItem,
      MarkdownOrderedList,
      MarkdownTaskList,
      DohcTaskItem,
      TableKit.configure({ table: false }),
      DohcMarkdownTable,
      BodySequence.configure({ sequence: base.sequence, containers: base.containers, history }),
    ],
    onTransaction({ transaction }) {
      if (isBodySequenceChange(transaction)) shown.count += 1;
    },
  });
  onStop(() => {
    editor.destroy();
    history.destroy();
    element.remove();
  });
  const seat = withEditor({ ...base, view: editor.view, history, shown });
  return {
    ...seat,
    editor,
    /** Typed letters go through the editor's input rules, as a key press does. */
    type(letters: string) {
      for (const letter of letters) {
        const { from, to } = editor.view.state.selection;
        const handled = editor.view.someProp("handleTextInput", (handle) =>
          handle(editor.view, from, to, letter, () => editor.view.state.tr.insertText(letter)),
        );
        if (!handled) editor.view.dispatch(editor.view.state.tr.insertText(letter));
      }
    },
  };
}

describe("a plain editor and a Tiptap editor racing", () => {
  raceTests((baseline, at) => (at === 1 ? desktop(baseline, 20) : person(baseline, 10 * (at + 1))));
});

describe("a Tiptap editor and a plain editor racing", () => {
  raceTests((baseline, at) => (at === 1 ? person(baseline, 20) : desktop(baseline, 10 * (at + 1))));
});

describe("what one Tiptap change does to the items of the sequence", () => {
  it("deletes one boundary for Backspace at the start of a line, and inserts one for Enter", () => {
    const a = desktop(note(...LINES), 10);
    const lower = a.boundaryIds()[1]!;
    const joined = a.effects(() => a.join(1));
    expect(joined).toEqual({
      made: quiet(),
      gone: BOUNDARY,
      other: 0,
      goneLetters: "",
      madeLetters: "",
      goneBoundaries: [lower],
      madeBoundaries: [],
      shown: 0,
    });
    const split = a.effects(() => a.split(0, 7));
    expect(split).toMatchObject({
      made: BOUNDARY,
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.lines()).toEqual(LINES);
    a.expectMirror();
  });

  it("leaves the old boundary with the text for Enter at the start of a line, a heading too", () => {
    const a = desktop(note(...LINES), 10);
    const [first, second, third] = a.boundaryIds();
    const split = a.effects(() => a.split(1, 0));
    expect(split).toMatchObject({
      made: BOUNDARY,
      gone: quiet(),
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.boundaryLines()).toEqual([
      { id: first, text: "One one" },
      { id: split.madeBoundaries[0], text: "" },
      { id: second, text: "Two two two" },
      { id: third, text: "Three" },
    ]);
    a.select([3, 0]);
    a.editor.commands.setHeading({ level: 2 });
    const above = a.effects(() => a.split(3, 0));
    expect(above.gone.boundaries).toBe(0);
    expect(a.boundaryLines().slice(3)).toEqual([
      { id: above.madeBoundaries[0], text: "" },
      { id: third, text: "Three" },
    ]);
    expect(a.blocks().slice(3)).toEqual(["paragraph", "h2"]);
    a.expectMirror();
  });

  it("changes formatting only for the bold command, and attributes only for the heading command", () => {
    const a = desktop(note(...LINES), 10);
    a.select([0, 4], [1, 3]);
    const bold = a.effects(() => a.editor.commands.toggleBold());
    expect(bold).toMatchObject({
      made: { ...quiet(), formats: 2 },
      gone: quiet(),
      other: 0,
      goneLetters: "",
      madeLetters: "",
    });
    expect(a.lettersMarked("bold")).toBe("oneTwo");
    a.select([2, 1]);
    const heading = a.effects(() => a.editor.commands.toggleHeading({ level: 2 }));
    expect(heading).toMatchObject({
      made: { ...quiet(), attributes: 2 },
      gone: { ...quiet(), attributes: 1 },
      other: 0,
      goneBoundaries: [],
      madeBoundaries: [],
    });
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "h2"]);
    a.expectMirror();
  });

  it("deletes the typed marker and changes attributes for the heading input rule", () => {
    const a = desktop(note(...LINES), 10);
    a.select([1, 0]);
    a.type("##");
    const effects = a.effects(() => a.type(" "));
    expect(effects.made).toEqual({ ...quiet(), attributes: 2 });
    expect(effects.gone).toEqual({ ...quiet(), letters: 2, attributes: 1 });
    expect(effects.goneLetters).toBe("##");
    expect(effects.goneBoundaries).toEqual([]);
    expect(a.blocks()).toEqual(["paragraph", "h2", "paragraph"]);
    expect(a.lines()).toEqual(LINES);
    a.expectMirror();
  });

  it("keeps the letters between the markers of the bold input rule", () => {
    const a = desktop(note("One", ""), 10);
    a.select([1, 0]);
    const effects = a.effects(() => a.type("**bold**"));
    expect(a.lines()).toEqual(["One", "bold"]);
    expect(a.lettersMarked("bold")).toBe("bold");
    expect(effects.madeLetters).toBe("bold");
    a.expectMirror();
  });

  it("undoes and redoes through the Tiptap commands, with one transaction each", () => {
    const a = desktop(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    a.typeAt(0, 7, "!");
    b.typeAt(2, 5, "?");
    exchange(a, b);
    const seen: boolean[] = [];
    a.editor.on("transaction", ({ transaction }) => seen.push(isBodySequenceChange(transaction)));
    expect(a.editor.can().undo()).toBe(true);
    expect(seen).toEqual([]);
    expect(a.editor.commands.undo()).toBe(true);
    expect(seen).toEqual([true]);
    expect(a.editor.commands.undo()).toBe(false);
    expect(a.editor.can().undo()).toBe(false);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one", "Two two two", "Three?"]);
    expect(a.editor.commands.redo()).toBe(true);
    expect(seen).toEqual([true, true]);
    exchange(a, b);
    expect(b.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    expect(a.press("z", { ctrlKey: true })).toBe(true);
    expect(a.press("y", { ctrlKey: true })).toBe(true);
    expect(a.lines()).toEqual(["One one!", "Two two two", "Three?"]);
    a.expectMirror();
    b.expectMirror();
  });

  it("refuses a list, which this step does not write yet", () => {
    const a = desktop(note(...LINES), 10);
    a.select([1, 0]);
    a.editor.commands.toggleBulletList();
    a.type("- ");
    expect(a.blocks()).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(a.view.state.doc.childCount).toBe(3);
    a.expectMirror();
  });
});

const summary = (effects: Effects) =>
  [
    ...Object.entries(effects.made).flatMap(([kind, count]) =>
      count > 0 ? [`+${String(count)} ${kind}`] : [],
    ),
    ...Object.entries(effects.gone).flatMap(([kind, count]) =>
      count > 0 ? [`-${String(count)} ${kind}`] : [],
    ),
    ...(effects.other > 0 ? [`${String(effects.other)} made and deleted at once`] : []),
    ...(effects.shown > 0 ? ["the editor was changed to show the sequence"] : []),
  ].join(", ") || "nothing";

it.skipIf(!process.env.BODY_SEQUENCE_COMMANDS)(
  "lists what each command writes, to find commands that replace letters they could keep",
  () => {
    const report: string[] = [];
    const probe = (name: string, lines: string[], act: (a: ReturnType<typeof desktop>) => void) => {
      const a = desktop(note(...lines), 10);
      const effects = a.effects(() => act(a));
      a.expectMirror();
      report.push(
        `${name}: ${summary(effects)} -> ${JSON.stringify(a.lines())} ${a.blocks().join(",")}`,
      );
      stopEveryone();
    };
    const heading = (a: ReturnType<typeof desktop>, line: number) => {
      a.select([line, 0]);
      a.editor.commands.setHeading({ level: 1 });
    };
    probe("Enter in a line", LINES, (a) => a.split(1, 4));
    probe("Enter at the end of a heading (after making it one)", LINES, (a) => {
      heading(a, 1);
      a.split(1, 11);
    });
    probe("Enter at the start of a heading (after making it one)", LINES, (a) => {
      heading(a, 1);
      a.split(1, 0);
    });
    probe("Enter on a selection across two lines", LINES, (a) => {
      a.select([0, 4], [1, 4]);
      a.press("Enter");
    });
    probe("Shift-Enter in a line", LINES, (a) => {
      a.select([1, 4]);
      a.editor.commands.setHardBreak();
    });
    probe("Backspace at the start of a line", LINES, (a) => a.join(1));
    probe("Backspace at the start of a line under an empty line", ["One", "", "Three"], (a) =>
      a.join(2),
    );
    probe("Backspace at the start of a heading that is the first line", LINES, (a) => {
      heading(a, 0);
      a.select([0, 0]);
      a.press("Backspace");
    });
    probe("Delete at the end of a line", LINES, (a) => {
      a.select([0, 7]);
      a.press("Delete");
    });
    probe("Mod-a then Backspace", LINES, (a) => {
      a.editor.commands.selectAll();
      a.press("Backspace");
    });
    probe("typing over a selection across two lines", LINES, (a) => {
      a.select([0, 4], [1, 4]);
      a.type("x");
    });
    probe("selection from the start of a line into the next, Backspace", LINES, (a) => {
      a.select([0, 0], [1, 4]);
      a.press("Backspace");
    });
    probe("toggleBold on a selection", LINES, (a) => {
      a.select([0, 0], [0, 3]);
      a.editor.commands.toggleBold();
    });
    probe("setLink on a selection", LINES, (a) => {
      a.select([0, 0], [0, 3]);
      a.editor.commands.setLink({ href: "https://example.com" });
    });
    probe("toggleHeading", LINES, (a) => heading(a, 1));
    probe("toggleCodeBlock", LINES, (a) => {
      a.select([1, 0]);
      a.editor.commands.toggleCodeBlock();
    });
    probe("setHorizontalRule in the middle of a line", LINES, (a) => {
      a.select([1, 4]);
      a.editor.commands.setHorizontalRule();
    });
    probe("setHorizontalRule in an empty line", ["One", "", "Three"], (a) => {
      a.select([1, 0]);
      a.editor.commands.setHorizontalRule();
    });
    probe("clearNodes on a heading (after making it one)", LINES, (a) => {
      heading(a, 1);
      a.editor.commands.clearNodes();
    });
    probe("insertContent of text", LINES, (a) => {
      a.select([1, 4]);
      a.editor.commands.insertContent("new ");
    });
    probe("insertContentAt over a word, with text that shares letters", LINES, (a) =>
      a.editor.commands.insertContentAt({ from: 10, to: 13 }, "Twos"),
    );
    probe("insertContent of two paragraphs in a line", LINES, (a) => {
      a.select([1, 4]);
      a.editor.commands.insertContent("<p>Xx</p><p>Yy</p>");
    });
    probe("setContent with the same three lines", LINES, (a) =>
      a.editor.commands.setContent(LINES.map((line) => `<p>${line}</p>`).join("")),
    );
    probe("deleteCurrentNode", LINES, (a) => {
      a.select([1, 2]);
      a.editor.commands.deleteCurrentNode();
    });
    probe("a transaction that replaces a paragraph by a heading with the same text", LINES, (a) => {
      const { doc, schema, tr } = a.view.state;
      const second = doc.child(1);
      const from = doc.child(0).nodeSize;
      a.view.dispatch(
        tr.replaceWith(
          from,
          from + second.nodeSize,
          schema.nodes.heading!.create({ level: 1 }, second.content),
        ),
      );
    });
    probe("joinUp on a selected line", LINES, (a) => {
      a.select([1, 0], [1, 11]);
      a.editor.commands.joinUp();
    });
    probe("the italic input rule *x*", ["One", ""], (a) => {
      a.select([1, 0]);
      a.type("*it*");
    });
    probe("toggleBulletList (refused)", LINES, (a) => {
      a.select([1, 0]);
      a.editor.commands.toggleBulletList();
    });
    probe("toggleBlockquote (refused)", LINES, (a) => {
      a.select([1, 0]);
      a.editor.commands.toggleBlockquote();
    });
    probe("insertTable (refused)", ["One", "", "Three"], (a) => {
      a.select([1, 0]);
      a.editor.commands.insertTable({ rows: 2, cols: 2 });
    });
    console.log(report.join("\n"));
  },
);
