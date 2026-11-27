// @vitest-environment jsdom
import { liftListItem, wrapInList } from "@tiptap/pm/schema-list";
import { EditorState, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  mountLiveBodyEditor,
  toggleListCommand,
  type LiveBodyEditorHandle,
  type LiveEditorToolbarState,
} from "./browser-editor.js";
import {
  getDohcProseMirrorSchema,
  markdownToYDoc,
  parseRichdocMarkdown,
  yDocToMarkdown,
} from "./import-export.js";
import { admitBodySequenceNotes, liveEditRefusal } from "./liveDocumentValidation.js";

beforeAll(() => {
  const emptyRect = {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  const rectList = () =>
    Object.assign([emptyRect], { item: () => emptyRect }) as unknown as DOMRectList;
  if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
    Range.prototype.getClientRects = rectList;
    Range.prototype.getBoundingClientRect = () => emptyRect;
  }
  if (!Element.prototype.getClientRects) {
    Element.prototype.getClientRects = rectList;
  }
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = () => {};
  }
});

function setup(
  markdown: string,
  options: {
    editable?: boolean;
    resolveImage?: (src: string) => string | null;
    bodySequence?: boolean;
  } = {},
) {
  const doc = markdownToYDoc(markdown, { bodySequence: options.bodySequence ?? false });
  const mount = document.createElement("div");
  document.body.append(mount);
  let editable = options.editable ?? true;
  const editor = mountLiveBodyEditor(mount, {
    doc,
    label: "Shared file editor",
    canEdit: () => editable,
    edit(change) {
      if (!editable) return false;
      change();
      return true;
    },
    resolveImage: options.resolveImage,
  });
  const textbox = mount.querySelector<HTMLElement>('[role="textbox"]')!;

  const dispatchKey = (
    key: string,
    mods: {
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      keyCode?: number;
    } = {},
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...mods,
    });
    textbox.dispatchEvent(event);
    return event;
  };

  const paste = (text: string, html?: string) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (type: string) => {
          if (type === "text/plain") return text;
          if (type === "text/html") return html ?? "";
          return "";
        },
        files: [],
      },
    });
    textbox.dispatchEvent(event);
  };

  const selectAllText = () => {
    editor.focus();
    dispatchKey("a", { ctrlKey: true });
  };

  const setCaretAt = (node: Node, offset: number) => {
    editor.focus();
    const range = document.createRange();
    range.setStart(node, offset);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  };

  // Mutate the active paragraph's text node one step so ProseMirror's DOMObserver
  // invokes handleTextInput and runs Markdown inputRules through the real browser path.
  const typeTrigger = async (prefix: string, triggerChar: string) => {
    editor.focus();
    const paragraph = textbox.querySelector("p")!;
    if (prefix) {
      paste(prefix);
    }
    const target = textbox.querySelector("p")!;
    const existing = target.firstChild;
    if (existing && existing.nodeType === Node.TEXT_NODE) {
      existing.textContent = (existing.textContent ?? "") + triggerChar;
      setCaretAt(existing, existing.textContent.length);
    } else {
      const created = document.createTextNode(triggerChar);
      target.replaceChildren(created);
      setCaretAt(created, created.textContent!.length);
    }
    void paragraph;
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  return {
    doc,
    mount,
    textbox,
    editor,
    setEditable(value: boolean) {
      editable = value;
      editor.refresh();
    },
    dispatchKey,
    paste,
    selectAllText,
    setCaretAt,
    typeTrigger,
    cleanup() {
      editor.destroy();
      doc.destroy();
      mount.remove();
    },
  };
}

describe("toggleListCommand", () => {
  const schema = getDohcProseMirrorSchema();
  type Kind = "bulletList" | "orderedList" | "taskList";

  const liftThenWrap = (state: EditorState, target: Kind): Transaction | null => {
    const { $from } = state.selection;
    let depth = $from.depth;
    while (depth > 0 && !$from.node(depth).type.name.endsWith("List")) depth--;
    const current = $from.node(depth).type === schema.nodes.taskList ? "taskItem" : "listItem";
    let lifted: Transaction | null = null;
    liftListItem(schema.nodes[current]!)(state, (tr) => (lifted = tr));
    if (!lifted) return null;
    let wrapped: Transaction | null = null;
    wrapInList(schema.nodes[target]!)(state.apply(lifted), (tr) => (wrapped = tr));
    if (!wrapped) return null;
    const combined = state.tr;
    for (const step of [...(lifted as Transaction).steps, ...(wrapped as Transaction).steps])
      combined.step(step);
    return combined.setSelection(
      Selection.fromJSON(combined.doc, (wrapped as Transaction).selection.toJSON()),
    );
  };

  const selecting = (markdown: string, from: string, to: string) => {
    const doc = schema.nodeFromJSON(parseRichdocMarkdown(markdown));
    const find = (text: string) => {
      let found = -1;
      doc.descendants((node, pos) => {
        const at = node.isText ? node.text!.indexOf(text) : -1;
        if (found < 0 && at >= 0) found = pos + at;
        return found < 0;
      });
      return found;
    };
    return EditorState.create({
      doc,
      selection: TextSelection.create(doc, find(from), find(to) + to.length),
    });
  };

  it.each([
    ["- one\n- two\n- three\n", "one", "three", "taskList", true],
    ["- one\n- two\n- three\n", "two", "two", "taskList", true],
    ["- one\n- two\n- three\n", "one", "two", "orderedList", true],
    ["- one\n- two\n- three\n", "two", "three", "taskList", true],
    ["1. one\n2. two\n", "one", "two", "bulletList", true],
    ["3. one\n4. two\n5. three\n", "two", "two", "taskList", true],
    ["- [x] one\n- [ ] two\n", "one", "one", "bulletList", true],
    ["> - one\n> - two\n> - three\n", "two", "three", "taskList", true],
    ["- one\n\n  more\n- two\n", "one", "two", "taskList", false],
    ["- one\n  - two\n  - three\n", "two", "three", "taskList", false],
    ["- # one\n- two\n", "one", "two", "taskList", false],
  ] as const)(
    "in %j from %s to %s, makes a %s as a lift and a wrap do",
    (markdown, from, to, kind, oneStep) => {
      const state = selecting(markdown, from, to);
      let made: Transaction | null = null;
      toggleListCommand(schema, kind)(state, (tr) => (made = tr));
      const expected = liftThenWrap(state, kind);
      expect(made === null).toBe(expected === null);
      if (!made || !expected) return;
      const tr = made as Transaction;
      expect(tr.doc.toJSON()).toEqual(expected.doc.toJSON());
      expect(tr.selection.toJSON()).toEqual(expected.selection.toJSON());
      expect(tr.scrolledIntoView).toBe(true);
      expect(tr.steps.length === 1).toBe(oneStep);
    },
  );
});

describe("mountLiveBodyEditor", () => {
  it("applies formatting commands and updates toolbar state", () => {
    const ctx = setup("Hello");
    const observed: LiveEditorToolbarState[] = [];
    const unsubscribe = ctx.editor.subscribeToolbar((state) => observed.push(state));
    try {
      ctx.selectAllText();
      expect(ctx.editor.toggleMark("bold")).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("**Hello**\n");
      expect(ctx.editor.getToolbarState().bold).toBe(true);

      expect(ctx.editor.toggleMark("italic")).toBe(true);
      expect(ctx.editor.getToolbarState().italic).toBe(true);

      expect(ctx.editor.toggleMark("strike")).toBe(true);
      expect(ctx.editor.getToolbarState().strike).toBe(true);

      expect(ctx.editor.toggleMark("code")).toBe(true);
      expect(ctx.editor.getToolbarState().code).toBe(true);

      expect(ctx.editor.setHeading(2)).toBe(true);
      expect(ctx.editor.getToolbarState().heading).toBe(2);
      expect(yDocToMarkdown(ctx.doc).startsWith("## ")).toBe(true);

      expect(ctx.editor.setHeading(2)).toBe(true);
      expect(ctx.editor.getToolbarState().heading).toBe(0);

      expect(observed.length).toBeGreaterThan(2);
    } finally {
      unsubscribe();
      ctx.cleanup();
    }
  });

  it("supports keyboard shortcuts for marks, headings, and hard break", () => {
    const ctx = setup("Alpha");
    try {
      ctx.selectAllText();
      ctx.dispatchKey("b", { ctrlKey: true });
      expect(yDocToMarkdown(ctx.doc)).toBe("**Alpha**\n");

      ctx.dispatchKey("i", { ctrlKey: true });
      expect(ctx.editor.getToolbarState().italic).toBe(true);

      ctx.dispatchKey("x", { ctrlKey: true, shiftKey: true });
      expect(ctx.editor.getToolbarState().strike).toBe(true);

      ctx.dispatchKey("e", { ctrlKey: true });
      expect(ctx.editor.getToolbarState().code).toBe(true);

      ctx.dispatchKey("1", { ctrlKey: true, altKey: true });
      expect(ctx.editor.getToolbarState().heading).toBe(1);

      ctx.dispatchKey("2", { ctrlKey: true, altKey: true });
      expect(ctx.editor.getToolbarState().heading).toBe(2);

      ctx.dispatchKey("3", { ctrlKey: true, altKey: true });
      expect(ctx.editor.getToolbarState().heading).toBe(3);

      let leaf: Node = ctx.textbox.querySelector("h3")!;
      while (leaf.firstChild) leaf = leaf.firstChild;
      ctx.setCaretAt(leaf, (leaf.textContent ?? "").length);
      ctx.dispatchKey("Enter", { shiftKey: true });
      expect(ctx.textbox.querySelector("br")).not.toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("toggles lists, blockquotes, code blocks, and supports undo/redo", () => {
    const ctx = setup("Item one");
    try {
      const p = ctx.textbox.querySelector("p")!;
      ctx.setCaretAt(p.firstChild!, 4);

      expect(ctx.editor.toggleBulletList()).toBe(true);
      expect(ctx.editor.getToolbarState().bulletList).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- Item one\n");

      expect(ctx.editor.toggleOrderedList()).toBe(true);
      expect(ctx.editor.getToolbarState().orderedList).toBe(true);
      expect(ctx.editor.getToolbarState().bulletList).toBe(false);
      expect(yDocToMarkdown(ctx.doc)).toBe("1. Item one\n");

      expect(ctx.editor.toggleTaskList()).toBe(true);
      expect(ctx.editor.getToolbarState().taskList).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- [ ] Item one\n");

      expect(ctx.editor.toggleTaskList()).toBe(true);
      expect(ctx.editor.getToolbarState().taskList).toBe(false);
      expect(yDocToMarkdown(ctx.doc)).toBe("Item one\n");

      expect(ctx.editor.toggleBlockquote()).toBe(true);
      expect(ctx.editor.getToolbarState().blockquote).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("> Item one\n");

      expect(ctx.editor.toggleBlockquote()).toBe(true);
      expect(ctx.editor.getToolbarState().blockquote).toBe(false);

      expect(ctx.editor.toggleCodeBlock()).toBe(true);
      expect(ctx.editor.getToolbarState().codeBlock).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("```\nItem one\n```\n");

      expect(ctx.editor.getToolbarState().canUndo).toBe(true);
      expect(ctx.editor.undo()).toBe(true);
      expect(ctx.editor.getToolbarState().canRedo).toBe(true);
      expect(ctx.editor.redo()).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  it("splits, sinks, and lifts bullet and task list items via Enter, Tab, and Shift-Tab", () => {
    const ctx = setup("- First\n- Second\n");
    try {
      const items = ctx.textbox.querySelectorAll("li");
      const secondText = items[1]!.querySelector("p")!.firstChild!;
      ctx.setCaretAt(secondText, 6);

      ctx.dispatchKey("Tab");
      expect(yDocToMarkdown(ctx.doc)).toBe("- First\n  - Second\n");

      ctx.dispatchKey("Tab", { shiftKey: true });
      expect(yDocToMarkdown(ctx.doc)).toBe("- First\n- Second\n");

      ctx.dispatchKey("Enter");
      expect(ctx.textbox.querySelectorAll("li")).toHaveLength(3);
    } finally {
      ctx.cleanup();
    }

    const taskCtx = setup("- [x] Done\n- [ ] Next\n");
    try {
      const items = taskCtx.textbox.querySelectorAll('li[data-type="taskItem"]');
      const secondText = items[1]!.querySelector("p")!.firstChild!;
      taskCtx.setCaretAt(secondText, 4);

      taskCtx.dispatchKey("Tab");
      expect(yDocToMarkdown(taskCtx.doc)).toBe("- [x] Done\n  - [ ] Next\n");

      taskCtx.dispatchKey("Tab", { shiftKey: true });
      expect(yDocToMarkdown(taskCtx.doc)).toBe("- [x] Done\n- [ ] Next\n");

      taskCtx.dispatchKey("Enter");
      expect(taskCtx.textbox.querySelectorAll('li[data-type="taskItem"]')).toHaveLength(3);

      // Pressing Enter at the end of a checked task creates an unchecked next task.
      const checkedItems = taskCtx.textbox.querySelectorAll('li[data-type="taskItem"]');
      const firstText = checkedItems[0]!.querySelector("p")!.firstChild!;
      taskCtx.setCaretAt(firstText, 4);
      taskCtx.dispatchKey("Enter");
      const afterSplit = taskCtx.textbox.querySelectorAll('li[data-type="taskItem"]');
      expect(afterSplit[0]?.getAttribute("data-checked")).toBe("true");
      expect(afterSplit[1]?.getAttribute("data-checked")).toBe("false");
    } finally {
      taskCtx.cleanup();
    }
  });

  it("converts Markdown input rules for headings, lists, tasks, quotes, fences, and rules", async () => {
    const h1 = setup("");
    try {
      await h1.typeTrigger("#", " ");
      await vi.waitFor(() => expect(h1.textbox.querySelector("h1")).not.toBeNull());
    } finally {
      h1.cleanup();
    }

    const h2 = setup("");
    try {
      await h2.typeTrigger("##", " ");
      await vi.waitFor(() => expect(h2.textbox.querySelector("h2")).not.toBeNull());
    } finally {
      h2.cleanup();
    }

    const h3 = setup("");
    try {
      await h3.typeTrigger("###", " ");
      await vi.waitFor(() => expect(h3.textbox.querySelector("h3")).not.toBeNull());
    } finally {
      h3.cleanup();
    }

    const bullet = setup("");
    try {
      await bullet.typeTrigger("-", " ");
      await vi.waitFor(() => expect(bullet.textbox.querySelector("ul > li")).not.toBeNull());
      // Typing "[x] " inside the bullet item converts it into a checked task item.
      await bullet.typeTrigger("[x]", " ");
      await vi.waitFor(() => {
        const item = bullet.textbox.querySelector('li[data-type="taskItem"]');
        expect(item).not.toBeNull();
        expect(item?.getAttribute("data-checked")).toBe("true");
      });
    } finally {
      bullet.cleanup();
    }

    const ordered = setup("");
    try {
      await ordered.typeTrigger("1.", " ");
      await vi.waitFor(() => expect(ordered.textbox.querySelector("ol > li")).not.toBeNull());
    } finally {
      ordered.cleanup();
    }

    const directTask = setup("");
    try {
      await directTask.typeTrigger("- [ ]", " ");
      await vi.waitFor(() =>
        expect(directTask.textbox.querySelector('li[data-type="taskItem"]')).not.toBeNull(),
      );
    } finally {
      directTask.cleanup();
    }

    const quote = setup("");
    try {
      await quote.typeTrigger(">", " ");
      await vi.waitFor(() => expect(quote.textbox.querySelector("blockquote")).not.toBeNull());
    } finally {
      quote.cleanup();
    }

    const fenceSpace = setup("");
    try {
      await fenceSpace.typeTrigger("```js", " ");
      await vi.waitFor(() => expect(fenceSpace.textbox.querySelector("pre > code")).not.toBeNull());
    } finally {
      fenceSpace.cleanup();
    }

    const fenceEnter = setup("");
    try {
      fenceEnter.editor.focus();
      fenceEnter.paste("```ts");
      fenceEnter.dispatchKey("Enter");
      expect(fenceEnter.textbox.querySelector("pre > code")).not.toBeNull();
      expect(yDocToMarkdown(fenceEnter.doc)).toBe("```ts\n\n```\n");
    } finally {
      fenceEnter.cleanup();
    }

    const hrEnter = setup("");
    try {
      hrEnter.editor.focus();
      hrEnter.paste("---");
      hrEnter.dispatchKey("Enter");
      expect(hrEnter.textbox.querySelector("hr")).not.toBeNull();
      expect(yDocToMarkdown(hrEnter.doc)).toContain("***");
    } finally {
      hrEnter.cleanup();
    }

    const hrSpace = setup("");
    try {
      await hrSpace.typeTrigger("---", " ");
      await vi.waitFor(() => expect(hrSpace.textbox.querySelector("hr")).not.toBeNull());
    } finally {
      hrSpace.cleanup();
    }

    // Typing "--- " before existing text must never replace the paragraph and drop that text.
    const hrBeforeText = setup("Keep this text");
    try {
      const textNode = hrBeforeText.textbox.querySelector("p")!.firstChild!;
      hrBeforeText.setCaretAt(textNode, 0);
      await hrBeforeText.typeTrigger("---", " ");
      expect(hrBeforeText.textbox.querySelector("hr")).toBeNull();
      expect(yDocToMarkdown(hrBeforeText.doc)).toContain("Keep this text");
    } finally {
      hrBeforeText.cleanup();
    }
  });

  it("splits multi-line plain-text paste into paragraphs without injecting HTML", () => {
    const ctx = setup("");
    try {
      ctx.paste("First paragraph\n\nSecond paragraph\n\n<b>Not bold</b>", "<b>Injected</b>");
      expect(ctx.textbox.querySelector("b")).toBeNull();
      expect(yDocToMarkdown(ctx.doc)).toBe(
        "First paragraph\n\nSecond paragraph\n\n&lt;b&gt;Not bold&lt;/b&gt;\n",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("renders resolved safe blob images and keeps unresolved or unsafe images as text", () => {
    const sha = "a".repeat(64);
    const safeUrl = `/api/view/blob/${sha}?session=AbCdEfGhIjKl`;
    const ctx = setup(
      `![Safe](assets/ok.png)\n\n![Remote](https://attacker.example/pixel.png)\n\n![Evil](assets/evil.png)`,
      {
        resolveImage: (src) => {
          if (src === "assets/ok.png") return safeUrl;
          if (src === "assets/evil.png") return "javascript:alert(1)";
          return null;
        },
      },
    );
    try {
      const images = ctx.textbox.querySelectorAll("img[src]");
      expect(images).toHaveLength(1);
      expect(images[0]!.getAttribute("src")).toBe(safeUrl);
      expect(images[0]!.getAttribute("alt")).toBe("Safe");
      expect(ctx.textbox.textContent).toContain("[Image: Remote]");
      expect(ctx.textbox.textContent).toContain("[Image: Evil]");
    } finally {
      ctx.cleanup();
    }
  });

  it("takes Redo with nothing left to redo without bringing back a deleted paragraph", () => {
    const ctx = setup("Start line.\n\nDoomed block.\n\nEnd line.");
    try {
      const [, doomed, end] = ctx.textbox.querySelectorAll("p");
      ctx.editor.focus();
      const range = document.createRange();
      range.setStart(doomed!.firstChild!, 0);
      range.setEnd(end!.firstChild!, 0);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      ctx.dispatchKey("Backspace");
      const edited = "Start line.\n\nEnd line.\n";
      expect(yDocToMarkdown(ctx.doc)).toBe(edited);

      ctx.dispatchKey("z", { ctrlKey: true, keyCode: 90 });
      expect(yDocToMarkdown(ctx.doc)).toContain("Doomed block.");
      ctx.dispatchKey("Z", { ctrlKey: true, shiftKey: true, keyCode: 90 });
      expect(yDocToMarkdown(ctx.doc)).toBe(edited);

      // Caps Lock reports a lowercase key under Shift.
      for (const [key, mods] of [
        ["z", { ctrlKey: true, shiftKey: true, keyCode: 90 }],
        ["Z", { ctrlKey: true, shiftKey: true, keyCode: 90 }],
        ["y", { ctrlKey: true, keyCode: 89 }],
      ] as const) {
        expect(ctx.dispatchKey(key, mods).defaultPrevented).toBe(true);
        expect(yDocToMarkdown(ctx.doc)).toBe(edited);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("refuses shortcuts, toolbar commands, and paste when read-only", () => {
    const ctx = setup("Locked text", { editable: false });
    try {
      const before = Y.encodeStateAsUpdate(ctx.doc);
      ctx.selectAllText();

      const editor: LiveBodyEditorHandle = ctx.editor;
      expect(editor.toggleMark("bold")).toBe(false);
      expect(editor.setHeading(1)).toBe(false);
      expect(editor.toggleBulletList()).toBe(false);
      expect(editor.toggleOrderedList()).toBe(false);
      expect(editor.toggleTaskList()).toBe(false);
      expect(editor.toggleBlockquote()).toBe(false);
      expect(editor.toggleCodeBlock()).toBe(false);
      expect(editor.undo()).toBe(false);
      expect(editor.redo()).toBe(false);

      ctx.dispatchKey("b", { ctrlKey: true });
      ctx.dispatchKey("1", { ctrlKey: true, altKey: true });
      ctx.paste("Blocked\n\nParagraph");

      expect(Y.encodeStateAsUpdate(ctx.doc)).toEqual(before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("mountLiveBodyEditor on a note in format 2", () => {
  beforeAll(() => admitBodySequenceNotes(true));
  afterAll(() => admitBodySequenceNotes(false));

  function sequenceNote(markdown: string, options: { editable?: boolean } = {}) {
    const ctx = setup(markdown, { ...options, bodySequence: true });
    const stored = new Y.Doc();
    Y.applyUpdate(stored, Y.encodeStateAsUpdate(ctx.doc));
    const refusals: unknown[] = [];
    ctx.doc.on("update", (update: Uint8Array) => refusals.push(liveEditRefusal(stored, update)));
    return { ...ctx, stored, refusals };
  }

  it("shows the note's text and writes typing, list toggles, Markdown shortcuts and a tick that the save takes", async () => {
    const ctx = sequenceNote("Item one");
    try {
      expect(ctx.textbox.textContent).toBe("Item one");
      ctx.setCaretAt(ctx.textbox.querySelector("p")!.firstChild!, 8);
      ctx.paste(" and two");
      expect(yDocToMarkdown(ctx.doc)).toBe("Item one and two\n");
      expect(ctx.editor.toggleBulletList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- Item one and two\n");
      expect(ctx.editor.toggleOrderedList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("1. Item one and two\n");
      expect(ctx.editor.toggleTaskList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- [ ] Item one and two\n");
      const box = ctx.textbox.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      expect(yDocToMarkdown(ctx.doc)).toBe("- [x] Item one and two\n");
      expect(ctx.editor.toggleTaskList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("Item one and two\n");
      expect(ctx.refusals).toHaveLength(6);
      expect(ctx.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      ctx.cleanup();
    }

    const task = sequenceNote("");
    try {
      await task.typeTrigger("-", " ");
      await vi.waitFor(() => expect(task.textbox.querySelector("ul > li")).not.toBeNull());
      await task.typeTrigger("[x]", " ");
      await vi.waitFor(() =>
        expect(
          task.textbox.querySelector('li[data-type="taskItem"]')?.getAttribute("data-checked"),
        ).toBe("true"),
      );
      expect(yDocToMarkdown(task.doc)).toBe("- [x]\n");
      expect(task.refusals.length).toBeGreaterThan(0);
      expect(task.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      task.cleanup();
    }

    const rule = sequenceNote("");
    try {
      await rule.typeTrigger("---", " ");
      await vi.waitFor(() => expect(rule.textbox.querySelector("hr")).not.toBeNull());
      expect(yDocToMarkdown(rule.doc)).toContain("***");
      expect(rule.refusals.length).toBeGreaterThan(0);
      expect(rule.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      rule.cleanup();
    }
  });

  it("takes Redo with nothing left to redo without bringing back a deleted paragraph", () => {
    const ctx = sequenceNote("Start line.\n\nDoomed block.\n\nEnd line.");
    try {
      const [, doomed, end] = ctx.textbox.querySelectorAll("p");
      ctx.editor.focus();
      const range = document.createRange();
      range.setStart(doomed!.firstChild!, 0);
      range.setEnd(end!.firstChild!, 0);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      ctx.dispatchKey("Backspace");
      const edited = "Start line.\n\nEnd line.\n";
      expect(yDocToMarkdown(ctx.doc)).toBe(edited);

      ctx.dispatchKey("z", { ctrlKey: true, keyCode: 90 });
      expect(yDocToMarkdown(ctx.doc)).toContain("Doomed block.");
      ctx.dispatchKey("Z", { ctrlKey: true, shiftKey: true, keyCode: 90 });
      expect(yDocToMarkdown(ctx.doc)).toBe(edited);

      for (const [key, mods] of [
        ["z", { ctrlKey: true, shiftKey: true, keyCode: 90 }],
        ["Z", { ctrlKey: true, shiftKey: true, keyCode: 90 }],
        ["y", { ctrlKey: true, keyCode: 89 }],
      ] as const) {
        expect(ctx.dispatchKey(key, mods).defaultPrevented).toBe(true);
        expect(yDocToMarkdown(ctx.doc)).toBe(edited);
      }
      expect(ctx.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  it("adds no format-1 body to the note when it mounts", () => {
    const ctx = sequenceNote("Item one");
    try {
      expect(ctx.textbox.textContent).toBe("Item one");
      expect(ctx.doc.share.has("body")).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes typing, Enter and list toggles in a browser that has no toSorted or toReversed", () => {
    const missing = ["toSorted", "toReversed"] as const;
    const kept = missing.map((name) => Object.getOwnPropertyDescriptor(Array.prototype, name)!);
    for (const name of missing) Reflect.deleteProperty(Array.prototype, name);
    const ctx = sequenceNote("Item one\n\nItem two");
    try {
      ctx.setCaretAt(ctx.textbox.querySelector("p")!.firstChild!, 8);
      ctx.paste(" and more");
      expect(yDocToMarkdown(ctx.doc)).toBe("Item one and more\n\nItem two\n");
      expect(ctx.editor.toggleBulletList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- Item one and more\n\nItem two\n");
      ctx.dispatchKey("Enter");
      ctx.paste("new");
      expect(yDocToMarkdown(ctx.doc)).toBe("- Item one and more\n- new\n\nItem two\n");
      expect(ctx.editor.toggleOrderedList()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("- Item one and more\n\n1. new\n\nItem two\n");
      expect(ctx.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      ctx.cleanup();
      missing.forEach((name, at) => Object.defineProperty(Array.prototype, name, kept[at]!));
    }
  });

  it("undoes and redoes from the toolbar, which says when each can", () => {
    const ctx = sequenceNote("Item one");
    try {
      const seen: LiveEditorToolbarState[] = [];
      ctx.editor.subscribeToolbar((state) => seen.push(state));
      expect(ctx.editor.getToolbarState().canUndo).toBe(false);
      ctx.setCaretAt(ctx.textbox.querySelector("p")!.firstChild!, 4);
      expect(ctx.editor.toggleBlockquote()).toBe(true);
      expect(seen.at(-1)?.canUndo).toBe(true);
      expect(ctx.editor.undo()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("Item one\n");
      expect(seen.at(-1)).toMatchObject({ canUndo: false, canRedo: true });
      expect(ctx.editor.redo()).toBe(true);
      expect(yDocToMarkdown(ctx.doc)).toBe("> Item one\n");
      expect(seen.at(-1)).toMatchObject({ canUndo: true, canRedo: false });
      expect(ctx.refusals.every((refusal) => refusal === undefined)).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes nothing for Undo or Redo, by key or from the toolbar, while the page takes no edits", () => {
    const ctx = sequenceNote("Item one");
    try {
      ctx.setCaretAt(ctx.textbox.querySelector("p")!.firstChild!, 4);
      expect(ctx.editor.toggleBlockquote()).toBe(true);
      const refuses = (markdown: string) => {
        ctx.setEditable(false);
        const before = Y.encodeStateAsUpdate(ctx.doc);
        expect(ctx.editor.undo()).toBe(false);
        expect(ctx.editor.redo()).toBe(false);
        for (const [key, mods] of [
          ["z", { ctrlKey: true, keyCode: 90 }],
          ["Z", { ctrlKey: true, shiftKey: true, keyCode: 90 }],
          ["y", { ctrlKey: true, keyCode: 89 }],
        ] as const)
          ctx.dispatchKey(key, mods);
        expect(Y.encodeStateAsUpdate(ctx.doc)).toEqual(before);
        expect(yDocToMarkdown(ctx.doc)).toBe(markdown);
        ctx.setEditable(true);
      };
      refuses("> Item one\n");
      expect(ctx.editor.undo()).toBe(true);
      refuses("Item one\n");
    } finally {
      ctx.cleanup();
    }
  });
});
