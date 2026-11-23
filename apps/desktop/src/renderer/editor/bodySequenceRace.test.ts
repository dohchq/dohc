// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { Editor, Extension } from "@tiptap/core";
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
  boundary,
  element,
  exchange,
  LINES,
  note,
  noteOf,
  onStop,
  page,
  person,
  quiet,
  raceTests,
  stopEveryone,
  withEditor,
  type Effects,
  type Page,
} from "@dohc/ydoc-projection/body-sequence-testing";
import { lookupEmoji, makeEmojiPlugin } from "./emojiTrigger";
import { desktopMarkdownExtensions } from "./extensions";
import { ListConversions } from "./listEditing";

afterEach(stopEveryone);

const BOUNDARY = { ...quiet(), boundaries: 1, attributes: 2 };

const EmojiTrigger = Extension.create({
  name: "emojiTrigger",
  addProseMirrorPlugins: () => [makeEmojiPlugin(() => {})],
});

function desktop(baseline: Uint8Array, clientID: number) {
  return desktopOn(page(baseline, clientID));
}

/** The desktop editor on a page that is already there. Two panes on one note are given one history. */
function desktopOn(base: Page, shared?: Y.UndoManager) {
  const element = window.document.createElement("div");
  window.document.body.append(element);
  const history = shared ?? createBodySequenceHistory(base.doc, { captureTimeout: 0 });
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
      EmojiTrigger,
      BodySequence.configure({ sequence: base.sequence, containers: base.containers, history }),
    ],
    onTransaction({ transaction }) {
      if (isBodySequenceChange(transaction)) shown.count += 1;
    },
  });
  onStop(() => {
    editor.destroy();
    if (!shared) history.destroy();
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

  it("gives text before the first boundary its boundary in a change of its own, which the undo command leaves", () => {
    const head = () =>
      noteOf(({ sequence }) => {
        sequence.insert(0, "hh", {});
        sequence.insertEmbed(2, boundary(), {});
        sequence.insert(3, "ab", {});
      });
    const a = desktop(head(), 10);
    const b = person(head(), 20);
    const [ab] = a.boundaryIds();
    a.select([0, 1]);
    expect(a.editor.commands.setHeading({ level: 2 })).toBe(true);
    expect(a.blocks()).toEqual(["h2", "paragraph"]);
    expect(a.sent).toHaveLength(2);
    expect(a.history.undoStack).toHaveLength(1);
    const [given] = a.boundaryIds();
    exchange(a, b);
    b.typeAt(0, 0, "B");
    exchange(b, a);
    expect(a.editor.commands.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.blocks()).toEqual(["paragraph", "paragraph"]);
      expect(each.boundaryLines()).toEqual([
        { id: given, text: "Bhh" },
        { id: ab, text: "ab" },
      ]);
    }
    expect(a.editor.commands.undo()).toBe(false);
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

describe("the desktop's commands next to a line with no boundary of its own", () => {
  const WIKILINK = () => element("wikilink", { target: "Page", label: null });
  const codeThenTextItCannotHold = () =>
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "codeBlock", language: null }), {});
      sequence.insert(1, "ab", {});
      sequence.insertEmbed(3, WIKILINK(), {});
      sequence.insert(4, "cd", {});
    });
  const mathThenText = () =>
    noteOf(({ sequence }) => {
      sequence.insertEmbed(0, boundary({ type: "mathBlock", tex: "a+b" }), {});
      sequence.insert(1, "spilled text", {});
    });

  it("sends one change for a code block's new language, and gives the paragraph after the code no boundary", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    expect(a.view.state.doc.toString()).toBe('doc(codeBlock("ab"), paragraph(wikilink, "cd"))');
    a.select([0, 1]);
    const effects = a.effects(() =>
      a.editor.commands.updateAttributes("codeBlock", { language: "js" }),
    );
    expect(a.view.state.doc.child(0).attrs.language).toBe("js");
    expect(a.sent).toHaveLength(1);
    expect(effects.madeBoundaries).toEqual([]);
    a.expectMirror();
  });

  it("sends one change for a math block's new TeX, and gives the paragraph after it no boundary", () => {
    const a = desktop(mathThenText(), 10);
    expect(a.view.state.doc.toString()).toBe('doc(mathBlock, paragraph("spilled text"))');
    const effects = a.effects(() =>
      a.view.dispatch(a.view.state.tr.setNodeMarkup(0, undefined, { tex: "a+b+c" })),
    );
    expect(a.view.state.doc.child(0).attrs.tex).toBe("a+b+c");
    expect(a.sent).toHaveLength(1);
    expect(effects.madeBoundaries).toEqual([]);
    a.expectMirror();
  });

  it("gives the paragraph after a code block its boundary first when setHorizontalRule replaces a selection in the code, so a letter typed at that paragraph's start stays there when the divider is undone", () => {
    const a = desktop(codeThenTextItCannotHold(), 10);
    const b = person(codeThenTextItCannotHold(), 20);
    a.select([0, 1], [0, 2]);
    expect(a.editor.commands.setHorizontalRule()).toBe(true);
    expect(a.view.state.doc.toString()).toBe(
      'doc(codeBlock("a"), horizontalRule, paragraph(wikilink, "cd"))',
    );
    expect(a.sent).toHaveLength(2);
    exchange(a, b);
    b.typeAt(2, 0, "P");
    exchange(b, a);
    expect(a.undo()).toBe(true);
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.view.state.doc.toString()).toBe(
        'doc(codeBlock("ab"), paragraph("P", wikilink, "cd"))',
      );
    }
  });

  it("puts setHorizontalRule's divider in front of a line's own boundary when the caret is at the line's start, so the line is still the heading someone else made it at the same moment", () => {
    const a = desktop(note(...LINES), 10);
    const b = person(note(...LINES), 20);
    const [first, second, third] = a.boundaryIds();
    a.select([1, 0]);
    const effects = a.effects(() => a.editor.commands.setHorizontalRule());
    expect(effects.goneBoundaries).toEqual([]);
    expect(effects.madeBoundaries).toHaveLength(1);
    expect(a.boundaryIds()).toEqual([first, effects.madeBoundaries[0], second, third]);
    b.select([1, 0]);
    b.retype("heading", { level: 2 });
    exchange(a, b);
    for (const each of [a, b]) {
      each.expectMirror();
      expect(each.blocks()).toEqual(["paragraph", "horizontalRule", "h2", "paragraph"]);
      expect(each.lines()).toEqual(["One one", "", "Two two two", "Three"]);
    }
  });
});

describe("the desktop editor's own plugins, which add to a change", () => {
  const ADDRESS = "https://example.com";
  const twoPanes = (line: string) => {
    const base = page(note(line), 10);
    const history = createBodySequenceHistory(base.doc, { captureTimeout: 0 });
    onStop(() => history.destroy());
    return { base, first: desktopOn(base, history), second: desktopOn(base, history) };
  };

  it("write no link when a pane shows an address a peer typed, also a pane nobody can edit", () => {
    const { base, first, second } = twoPanes("see ");
    second.editor.setEditable(false);
    const peer = person(note("see "), 20);
    peer.typeAt(0, 4, `${ADDRESS} and`);
    exchange(peer, base);
    expect(base.sent).toEqual([]);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual([`see ${ADDRESS} and`]);
    }
    expect(first.lettersMarked("link")).toBe("");
  });

  it("still link an address the person types, once, and show it in the other pane", () => {
    const { first, second } = twoPanes("see ");
    first.select([0, 4]);
    first.type(`${ADDRESS} `);
    expect(first.lettersMarked("link")).toBe(ADDRESS);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual([`see ${ADDRESS} `]);
    }
  });

  it("expand no shortcode when a peer makes one bold just before the caret", () => {
    const a = desktop(note("say :smile:"), 10);
    const b = person(note("say :smile:"), 20);
    a.select([0, 11]);
    b.select([0, 4], [0, 11]);
    b.toggle("bold");
    exchange(b, a);
    expect(a.sent).toEqual([]);
    expect(a.lines()).toEqual(["say :smile:"]);
    expect(a.lettersMarked("bold")).toBe(":smile:");
    a.expectMirror();
  });

  it("still expand a shortcode the person types", () => {
    const a = desktop(note("say "), 10);
    a.select([0, 4]);
    a.type(":smile:");
    expect(a.lines()).toEqual([`say ${lookupEmoji("smile")!.emoji}`]);
    a.expectMirror();
  });

  it("share undo between two panes on one note", () => {
    const { first, second } = twoPanes("ab");
    first.typeAt(0, 1, "A");
    second.typeAt(0, 2, "B");
    expect(first.editor.commands.undo()).toBe(true);
    for (const pane of [first, second]) expect(pane.lines()).toEqual(["aAb"]);
    expect(second.editor.commands.undo()).toBe(true);
    for (const pane of [first, second]) expect(pane.lines()).toEqual(["ab"]);
    expect(first.editor.commands.redo()).toBe(true);
    expect(second.editor.commands.redo()).toBe(true);
    for (const pane of [first, second]) {
      pane.expectMirror();
      expect(pane.lines()).toEqual(["aABb"]);
    }
  });
});
