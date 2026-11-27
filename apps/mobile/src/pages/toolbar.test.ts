import { documentWords } from "@dohc/interface-words/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEditorToolbar,
  type ToolbarEditor,
  type ToolbarMark,
  type ToolbarState,
} from "../../editor/toolbar";

const EMPTY_STATE: ToolbarState = {
  bold: false,
  italic: false,
  strike: false,
  code: false,
  heading: 0,
  bulletList: false,
  orderedList: false,
  taskList: false,
  blockquote: false,
  codeBlock: false,
  canUndo: false,
  canRedo: false,
};

class FakeNode {
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  offsetHeight = 0;
  parent: FakeNode | null = null;
  readonly children: FakeNode[] = [];
  readonly siblings: FakeNode[] = [];
  readonly attrs = new Map<string, string>();
  readonly props = new Map<string, string>();
  readonly listeners = new Map<string, ((event: FakeEvent) => void)[]>();
  removed = false;

  readonly style = {
    setProperty: (name: string, value: string) => {
      this.props.set(name, value);
    },
  };

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  append(...nodes: FakeNode[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  after(...nodes: FakeNode[]) {
    for (const node of nodes) this.siblings.push(node);
  }

  remove() {
    this.removed = true;
  }

  addEventListener(type: string, listener: (event: FakeEvent) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: FakeEvent) {
    let current: FakeNode | null = this;
    while (current) {
      for (const listener of current.listeners.get(event.type) ?? []) listener(event);
      current = event.bubbles ? current.parent : null;
    }
  }

  getBoundingClientRect() {
    return { height: this.offsetHeight };
  }
}

class FakeEvent {
  defaultPrevented = false;
  constructor(
    readonly type: string,
    readonly bubbles = true,
  ) {}
  preventDefault() {
    this.defaultPrevented = true;
  }
}

function findButtons(node: FakeNode): FakeNode[] {
  const result: FakeNode[] = [];
  if (node.tag === "button") result.push(node);
  for (const child of node.children) result.push(...findButtons(child));
  return result;
}

function makeEditor(initial: Partial<ToolbarState> = {}) {
  let listener: ((state: ToolbarState) => void) | null = null;
  let state: ToolbarState = { ...EMPTY_STATE, ...initial };
  const unsubscribe = vi.fn(() => {
    listener = null;
  });
  const calls: string[] = [];
  const editor: ToolbarEditor = {
    subscribeToolbar(next) {
      listener = next;
      next(state);
      return unsubscribe;
    },
    toggleMark(mark: ToolbarMark) {
      calls.push(`mark:${mark}`);
      return true;
    },
    setHeading(level) {
      calls.push(`heading:${level}`);
      return true;
    },
    toggleBulletList() {
      calls.push("bulletList");
      return true;
    },
    toggleOrderedList() {
      calls.push("orderedList");
      return true;
    },
    toggleTaskList() {
      calls.push("taskList");
      return true;
    },
    toggleBlockquote() {
      calls.push("blockquote");
      return true;
    },
    toggleCodeBlock() {
      calls.push("codeBlock");
      return true;
    },
    undo() {
      calls.push("undo");
      return true;
    },
    redo() {
      calls.push("redo");
      return true;
    },
  };
  return {
    editor,
    calls,
    unsubscribe,
    emit(patch: Partial<ToolbarState>) {
      state = { ...state, ...patch };
      listener?.(state);
    },
  };
}

let root: FakeNode;

beforeEach(() => {
  root = new FakeNode("div");
  vi.stubGlobal("document", {
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("the page formatting toolbar", () => {
  it("mounts every formatting and undo/redo button with shared labels and icons, hidden by default", () => {
    const toolbar = createEditorToolbar({ root: root as unknown as HTMLElement });
    const bar = root.siblings[0]!;
    expect(bar.className).toBe("toolbar");
    expect(bar.hidden).toBe(true);
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe(documentWords.toolbar.label);
    expect(toolbar.height()).toBe(0);

    const buttons = findButtons(bar);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      documentWords.toolbar.bold,
      documentWords.toolbar.italic,
      documentWords.toolbar.strike,
      documentWords.toolbar.code,
      documentWords.toolbar.heading1,
      documentWords.toolbar.heading2,
      documentWords.toolbar.heading3,
      documentWords.toolbar.bulletList,
      documentWords.toolbar.orderedList,
      documentWords.toolbar.taskList,
      documentWords.toolbar.blockquote,
      documentWords.toolbar.codeBlock,
      documentWords.toolbar.undo,
      documentWords.toolbar.redo,
    ]);
    for (const button of buttons) {
      expect(button.type).toBe("button");
      expect(button.children[0]?.tag).toBe("svg");
      expect(button.children[0]?.children[0]?.tag).toBe("path");
    }
  });

  it("shows only while editable with the keyboard up, and hides on read-only or keyboard close", () => {
    const onLayout = vi.fn();
    const toolbar = createEditorToolbar({ root: root as unknown as HTMLElement, onLayout });
    const bar = root.siblings[0]!;
    bar.offsetHeight = 53;

    // Keyboard open without an attached editor stays hidden.
    toolbar.setKeyboard(336, 336);
    expect(bar.hidden).toBe(true);
    expect(toolbar.height()).toBe(0);

    // Read-only editor stays hidden even with the keyboard open.
    let editable = false;
    const mock = makeEditor();
    toolbar.attach(mock.editor, () => editable);
    expect(bar.hidden).toBe(true);
    expect(toolbar.height()).toBe(0);

    // Turning editable on reveals the bar at the keyboard inset.
    editable = true;
    toolbar.refresh();
    expect(bar.hidden).toBe(false);
    expect(bar.props.get("--keyboard")).toBe("336px");
    expect(toolbar.height()).toBe(53);
    expect(onLayout).toHaveBeenCalledTimes(1);

    // Closing the keyboard hides the bar and clears the height.
    toolbar.setKeyboard(0, 0);
    expect(bar.hidden).toBe(true);
    expect(bar.props.get("--keyboard")).toBe("0px");
    expect(toolbar.height()).toBe(0);

    // Reopening the keyboard shows it again, then going read-only hides it immediately.
    toolbar.setKeyboard(340, 340);
    expect(bar.hidden).toBe(false);
    expect(bar.props.get("--keyboard")).toBe("340px");
    editable = false;
    toolbar.refresh();
    expect(bar.hidden).toBe(true);
    expect(toolbar.height()).toBe(0);
    expect(onLayout).toHaveBeenCalledTimes(2);
  });

  it("syncs aria-pressed and undo/redo disabled state from subscribeToolbar", () => {
    const toolbar = createEditorToolbar({ root: root as unknown as HTMLElement });
    const bar = root.siblings[0]!;
    const button = (label: string) =>
      findButtons(bar).find((item) => item.getAttribute("aria-label") === label)!;

    const mock = makeEditor();
    toolbar.attach(mock.editor, () => true);

    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);
    expect(button("Bold").getAttribute("aria-pressed")).toBe("false");
    expect(button("Heading 2").getAttribute("aria-pressed")).toBe("false");

    mock.emit({
      bold: true,
      code: true,
      heading: 2,
      taskList: true,
      canUndo: true,
      canRedo: false,
    });
    expect(button("Bold").getAttribute("aria-pressed")).toBe("true");
    expect(button("Italic").getAttribute("aria-pressed")).toBe("false");
    expect(button("Inline code").getAttribute("aria-pressed")).toBe("true");
    expect(button("Heading 1").getAttribute("aria-pressed")).toBe("false");
    expect(button("Heading 2").getAttribute("aria-pressed")).toBe("true");
    expect(button("Heading 3").getAttribute("aria-pressed")).toBe("false");
    expect(button("To-do list").getAttribute("aria-pressed")).toBe("true");
    expect(button("Undo").disabled).toBe(false);
    expect(button("Redo").disabled).toBe(true);

    mock.emit({ heading: 0, canUndo: false, canRedo: true });
    expect(button("Heading 2").getAttribute("aria-pressed")).toBe("false");
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
  });

  it("prevents default on pointerdown and mousedown so taps never blur the editor", () => {
    createEditorToolbar({ root: root as unknown as HTMLElement });
    const bar = root.siblings[0]!;
    const bold = findButtons(bar)[0]!;

    const pointerDown = new FakeEvent("pointerdown", true);
    bold.dispatchEvent(pointerDown);
    expect(pointerDown.defaultPrevented).toBe(true);

    const mouseDown = new FakeEvent("mousedown", true);
    bold.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);

    const barPointerDown = new FakeEvent("pointerdown", true);
    bar.dispatchEvent(barPointerDown);
    expect(barPointerDown.defaultPrevented).toBe(true);
  });

  it("runs every command on click while editable and refuses commands when read-only or disabled", () => {
    const onCommand = vi.fn();
    const toolbar = createEditorToolbar({ root: root as unknown as HTMLElement, onCommand });
    const bar = root.siblings[0]!;
    const buttons = findButtons(bar);

    let editable = true;
    const mock = makeEditor({ canUndo: true, canRedo: true });
    toolbar.attach(mock.editor, () => editable);

    for (const button of buttons) button.dispatchEvent(new FakeEvent("click", true));
    expect(mock.calls).toEqual([
      "mark:bold",
      "mark:italic",
      "mark:strike",
      "mark:code",
      "heading:1",
      "heading:2",
      "heading:3",
      "bulletList",
      "orderedList",
      "taskList",
      "blockquote",
      "codeBlock",
      "undo",
      "redo",
    ]);
    expect(onCommand).toHaveBeenCalledTimes(14);

    // Disabled Undo/Redo do not invoke the editor.
    mock.calls.length = 0;
    mock.emit({ canUndo: false, canRedo: false });
    buttons.at(-2)!.dispatchEvent(new FakeEvent("click", true));
    buttons.at(-1)!.dispatchEvent(new FakeEvent("click", true));
    expect(mock.calls).toEqual([]);

    // Read-only refuses every button click.
    editable = false;
    buttons[0]!.dispatchEvent(new FakeEvent("click", true));
    expect(mock.calls).toEqual([]);
  });

  it("unsubscribes the previous editor when re-attached and on detach", () => {
    const toolbar = createEditorToolbar({ root: root as unknown as HTMLElement });
    const bar = root.siblings[0]!;
    const first = makeEditor();
    const second = makeEditor({ italic: true });

    toolbar.attach(first.editor, () => true);
    toolbar.setKeyboard(336, 336);
    expect(bar.hidden).toBe(false);

    toolbar.attach(second.editor, () => true);
    expect(first.unsubscribe).toHaveBeenCalledOnce();
    expect(second.unsubscribe).not.toHaveBeenCalled();
    expect(bar.hidden).toBe(false);

    const italic = findButtons(bar).find(
      (item) => item.getAttribute("aria-label") === documentWords.toolbar.italic,
    )!;
    expect(italic.getAttribute("aria-pressed")).toBe("true");

    toolbar.detach();
    expect(second.unsubscribe).toHaveBeenCalledOnce();
    expect(bar.hidden).toBe(true);
  });

  it("styles checked tasks on direct paragraphs only and falls back to 48 px targets when touchSize is omitted", async () => {
    const { pageHtml } = await import("../editorHtml.generated");
    expect(pageHtml).toContain(
      '.markdown li[data-type="taskItem"][data-checked="true"] > div > p {',
    );
    expect(pageHtml).toContain("var(--touch, 48px)");
  });
});
