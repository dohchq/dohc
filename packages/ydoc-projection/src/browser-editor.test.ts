// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getDohcYDocBodyFragment } from "./body-fragment.js";
import {
  mountLiveBodyEditor,
  type LiveBodyEditorHandle,
  type LiveEditorToolbarState,
} from "./browser-editor.js";
import { markdownToYDoc, yDocToMarkdown } from "./import-export.js";

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
  } = {},
) {
  const doc = markdownToYDoc(markdown);
  const mount = document.createElement("div");
  document.body.append(mount);
  let editable = options.editable ?? true;
  const editor = mountLiveBodyEditor(mount, {
    body: getDohcYDocBodyFragment(doc),
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
    mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
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
