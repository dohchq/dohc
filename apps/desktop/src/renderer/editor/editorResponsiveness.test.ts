// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, TextSelection, type Plugin } from "@tiptap/pm/state";
import { DecorationSet, EditorView } from "@tiptap/pm/view";
import { history, undo, redo } from "@tiptap/pm/history";
import { splitBlock } from "@tiptap/pm/commands";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { boldText, codeBlock, codeMarkText, doc, hardBreak, paragraph, schema } from "./testDocs";
import {
  detectAutocomplete,
  makeWikilinkPlugin,
  wikilinkPluginKey,
  type WikilinkFile,
} from "./wikilinkPlugin";
import { detectMentionAutocomplete } from "./mentionTrigger";
import { detectCompleteEmojiShortcode, detectEmojiAutocomplete } from "./emojiTrigger";
import { makeBlockControlsPlugin } from "./blockControls";
import { makeCodeBlockChromePlugin } from "./codeBlockChrome";
import { makeCalloutChromePlugin } from "./calloutChrome";
import { makeSlashCommandPlugin, CLOSED_SLASH_COMMAND_STATE } from "./slashCommands";
import { makeHeadingFlashPlugin } from "./OutlinePanel";
import { makeLinkMenuPlugin, CLOSED_LINK_MENU_STATE } from "./linkMenu";
import { makeBlockExitPlugin } from "./blockExit";
import { makeCodeBlockContinuationPlugin, makeEmptyListItemFocusPlugin } from "./codeBlockChrome";
import { makeCodeHighlightPlugin } from "./codeHighlight";
import { makeMermaidPreviewPlugin } from "./mermaidRender";
import { makeInlineAtomPlugin } from "./inlineAtomPlugin";
import { makeTableControlsPlugin } from "./tableControls";
import { makeMentionPlugin } from "./mentionTrigger";
import { makeEmojiPlugin } from "./emojiTrigger";
import { isCodeBlock, isCodeMark } from "./pmHelpers";

const views: EditorView[] = [];
const blockControls = () =>
  makeBlockControlsPlugin({
    onInsertRef: { current: () => {} },
    onOpenMenuRef: { current: () => {} },
  });
function chromePlugins(): Plugin[] {
  return [
    makeSlashCommandPlugin({
      stateRef: { current: CLOSED_SLASH_COMMAND_STATE },
      setState: () => {},
      runCommandRef: { current: () => {} },
    }),
    blockControls(),
    makeWikilinkPlugin(
      () => new Map(),
      () => {},
    ),
    makeMentionPlugin(() => {}),
    makeEmojiPlugin(() => {}),
    makeHeadingFlashPlugin(),
    makeLinkMenuPlugin({ stateRef: { current: CLOSED_LINK_MENU_STATE }, setState: () => {} }),
    makeCodeBlockChromePlugin(),
    makeBlockExitPlugin(),
    makeCodeBlockContinuationPlugin(),
    makeCalloutChromePlugin(),
    makeCodeHighlightPlugin(),
    makeMermaidPreviewPlugin(),
    makeEmptyListItemFocusPlugin(),
    makeInlineAtomPlugin(),
    makeTableControlsPlugin(),
  ];
}
function expectSameElements(actual: NodeListOf<Element>, expected: Element[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, index) => expect(node).toBe(expected[index]));
}
/** How often `run` calls `object[method]`. A spy would keep every call, and a
 * quadratic path makes millions of them. */
function countCalls<T extends object, K extends keyof T>(
  object: T,
  method: K,
  run: () => void,
): number {
  const original = object[method];
  if (typeof original !== "function") throw new Error(`${String(method)} is not a method`);
  let calls = 0;
  object[method] = function (this: unknown, ...args: unknown[]) {
    calls++;
    return original.apply(this, args);
  } as T[K];
  try {
    run();
  } finally {
    object[method] = original;
  }
  return calls;
}
function mount(document: PMNode, plugins: Plugin[]) {
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: document, plugins }),
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
    },
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const view of views.splice(0)) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cursor-local trigger semantics", () => {
  const cases = [
    { detect: detectAutocomplete, pattern: /\\?\[\\?\[([^\]\n[]*)$/, complete: false },
    { detect: detectMentionAutocomplete, pattern: /(?<=^|\s)@([^\s@[]*)$/, complete: false },
    {
      detect: detectEmojiAutocomplete,
      pattern: /(?<=^|\s):([a-zA-Z0-9_+-]{2,})$/,
      complete: false,
    },
    {
      detect: detectCompleteEmojiShortcode,
      pattern: /(?<=^|\s):([a-zA-Z0-9_+-]{2,}):$/,
      complete: true,
    },
  ];

  it("matches the previous full scan at every cursor position across marks, atoms, and nested blocks", () => {
    const document = doc(
      paragraph(
        "prefix [[one @two :smile: ",
        boldText("[[bold @bold :fire:"),
        "[[plain",
        codeMarkText("@code :smile: [[code"),
      ),
      paragraph(
        "[[before",
        hardBreak(),
        "@after",
        schema.nodes.wikilink.create({ target: "a", label: "A" }),
        ":wave:",
      ),
      codeBlock("[[no @no :smile:"),
      schema.nodes.blockquote.create(null, paragraph("\\[\\[escaped @nested :heart:")),
      paragraph(),
      paragraph(codeMarkText("code"), boldText("@yes"), " [[yes"),
    );
    for (let cursor = 0; cursor <= document.content.size; cursor++) {
      for (const { detect, pattern, complete } of cases) {
        let expected: unknown = complete ? null : { active: false };
        document.descendants((node, pos, parent) => {
          if (!node.isText || !node.text || isCodeBlock(parent) || node.marks.some(isCodeMark))
            return;
          if (cursor < pos || cursor > pos + node.text.length) return;
          const before = node.text.slice(0, cursor - pos);
          const match = pattern.exec(before);
          if (!match) return;
          const from = pos + before.length - match[0].length;
          expected = complete
            ? { from, to: cursor, shortcode: match[1] }
            : { active: true, from, query: match[1] };
        });
        expect(detect(document, cursor), `${detect.name} at ${cursor}`).toEqual(expected);
      }
    }
  });

  it("does not visit document descendants to detect a trigger", () => {
    const document = doc(
      ...Array.from({ length: 20 }, () => paragraph("text")),
      paragraph("[[yes @yes :smile:"),
    );
    const scan = vi.spyOn(document, "descendants");
    for (const { detect } of cases) detect(document, document.content.size - 1);
    expect(scan).not.toHaveBeenCalled();
  });
});

describe("wikilink decoration reuse", () => {
  it("keeps pills and decorations during plain selection moves without scanning document text", () => {
    const files = vi.fn(() => new Map<string, WikilinkFile>());
    const view = mount(
      doc(
        paragraph("plain text"),
        ...Array.from({ length: 10 }, (_, i) => paragraph(`[[file-${i}]]`)),
      ),
      [makeWikilinkPlugin(files, () => {})],
    );
    const pills = [...view.dom.querySelectorAll(".dohc-wikilink-pill")];
    const original = wikilinkPluginKey.getState(view.state)?.decorations;
    const scan = vi.spyOn(view.state.doc, "descendants");
    for (let i = 2; i < 9; i++)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, i)));
    expect(scan).not.toHaveBeenCalled();
    expect(wikilinkPluginKey.getState(view.state)?.decorations).toBe(original);
    expectSameElements(view.dom.querySelectorAll(".dohc-wikilink-pill"), pills);
    const reads = files.mock.calls.length;
    view.dispatch(view.state.tr.setMeta("presence", true));
    expect(files).toHaveBeenCalledTimes(reads);
    view.dispatch(view.state.tr.insertText("x", 2));
    expectSameElements(view.dom.querySelectorAll(".dohc-wikilink-pill"), pills);
  });
});

describe("editor chrome reuse", () => {
  it.each([{ name: "replace marked text", from: 2, to: 5, text: "🙂" }])(
    "maps gutter positions for $name without rebuilding decorations",
    ({ from, to, text }) => {
      const insert = vi.fn();
      const plugin = makeBlockControlsPlugin({
        onInsertRef: { current: insert },
        onOpenMenuRef: { current: () => {} },
      });
      const view = mount(
        doc(paragraph(boldText("first")), paragraph("second"), codeBlock("third")),
        [history(), plugin],
      );
      view.setProps({ handleScrollToSelection: () => true });
      const controls = [...view.dom.querySelectorAll(".dohc-block-affordance")];
      const build = vi.spyOn(DecorationSet, "create");
      view.dispatch(view.state.tr.insertText(text, from, to).setMeta("remote-origin", true));
      expect(build).not.toHaveBeenCalled();
      const assertControls = () => {
        expectSameElements(view.dom.querySelectorAll(".dohc-block-affordance"), controls);
        view.state.doc.forEach((node, position, index) => {
          view.nodeDOM(position)!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
          expectSameElements(view.dom.querySelectorAll(".dohc-block-affordance.is-visible"), [
            controls[index],
          ]);
          (controls[index].querySelector(".dohc-block-plus") as HTMLButtonElement).click();
          expect(insert).toHaveBeenLastCalledWith(position);
        });
      };
      assertControls();
      expect(undo(view.state, view.dispatch)).toBe(true);
      assertControls();
      expect(redo(view.state, view.dispatch)).toBe(true);
      assertControls();
    },
  );

  it("rebuilds gutters for structural slices, nested changes, and node markup", () => {
    const view = mount(
      doc(
        paragraph("first"),
        schema.nodes.blockquote.create(null, paragraph("nested")),
        codeBlock("code"),
      ),
      [blockControls()],
    );
    const build = vi.spyOn(DecorationSet, "create");
    view.dispatch(view.state.tr.split(3));
    expect(build).toHaveBeenCalled();
    build.mockClear();
    let quotePosition = 0;
    view.state.doc.forEach((node, position) => {
      if (node.type.name === "blockquote") quotePosition = position;
    });
    view.dispatch(view.state.tr.insertText("x", quotePosition + 2));
    expect(build).toHaveBeenCalled();
    build.mockClear();
    const codePosition = view.state.doc.content.size - view.state.doc.lastChild!.nodeSize;
    view.dispatch(view.state.tr.setNodeMarkup(codePosition, undefined, { language: "python" }));
    expect(build).toHaveBeenCalled();
    expect(view.dom.querySelectorAll(".dohc-block-affordance")).toHaveLength(
      view.state.doc.childCount,
    );
  });

  it("types into a 100-block document with work linear in its blocks", () => {
    const blocks = 100;
    const plugin = blockControls();
    const view = mount(
      doc(...Array.from({ length: blocks }, (_, i) => paragraph(`Paragraph ${i}`))),
      [history(), plugin],
    );
    view.setProps({ handleScrollToSelection: () => true });
    // One widget per block and no node decorations: ProseMirror checks each
    // node decoration it maps with a scan from the document's first block.
    expect((plugin.getState(view.state) as DecorationSet).find()).toHaveLength(blocks);
    const middle = view.state.doc.child(0).nodeSize * (blocks / 2) + 3;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, middle)));
    // A quadratic scan exceeds this bound even with 100 blocks.
    expect(
      countCalls(Fragment.prototype, "child", () => view.dispatch(view.state.tr.insertText("x"))),
    ).toBeLessThan(blocks * 4);
    expect((plugin.getState(view.state) as DecorationSet).find()).toHaveLength(blocks);
  });

  it("presses Enter in a 100-block document with work linear in its blocks", () => {
    const blocks = 100;
    const plugin = blockControls();
    const view = mount(
      doc(...Array.from({ length: blocks }, (_, i) => paragraph(`Paragraph ${i}`))),
      [history(), plugin],
    );
    view.setProps({ handleScrollToSelection: () => true });
    const middle = view.state.doc.child(0).nodeSize * (blocks / 2) + 3;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, middle)));
    // DecorationSet.create checks each decoration against each block of the
    // document it is given.
    let checks = 0;
    const create = DecorationSet.create;
    vi.spyOn(DecorationSet, "create").mockImplementation((document, decorations) => {
      checks += document.childCount * decorations.length;
      return create(document, decorations);
    });
    const reads = countCalls(Fragment.prototype, "child", () =>
      splitBlock(view.state, view.dispatch),
    );
    // A full decoration rebuild exceeds this bound even with 100 blocks.
    expect(checks).toBeLessThan(blocks * 4);
    // ProseMirror itself reads each block about six times to split one.
    expect(reads).toBeLessThan(blocks * 8);
    expect(view.state.doc.childCount).toBe(blocks + 1);
    const starts: number[] = [];
    view.state.doc.forEach((_node, position) => starts.push(position));
    expect(
      (plugin.getState(view.state) as DecorationSet).find().map((widget) => widget.from),
    ).toEqual(starts);
  });

  it("preserves 3 toolbars through preceding text edits, code edits, undo, and redo", () => {
    const view = mount(
      doc(
        paragraph("lead"),
        ...Array.from({ length: 3 }, (_, i) => codeBlock(`code ${i}`, "javascript")),
      ),
      [history(), ...chromePlugins()],
    );
    const toolbars = [...view.dom.querySelectorAll(".dohc-code-block-toolbar")];
    view.dispatch(view.state.tr.insertText("x", 2));
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
    view.dispatch(view.state.tr.insertText("changed ", 8));
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
    undo(view.state, view.dispatch);
    redo(view.state, view.dispatch);
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
  });

  it.each(
    ["insert", "reorder", "join"].flatMap((operation) =>
      ["language"].map((control) => ({ operation, control })),
    ),
  )("does not retarget focused $control after $operation", ({ operation, control }) => {
    const onInsert = vi.fn();
    const view = mount(
      doc(paragraph("lead"), codeBlock("first", "javascript"), codeBlock("second", "javascript")),
      [
        makeBlockControlsPlugin({
          onInsertRef: { current: onInsert },
          onOpenMenuRef: { current: () => {} },
        }),
        makeCodeBlockChromePlugin(),
      ],
    );
    view.setProps({ handleScrollToSelection: () => true });
    const select = view.dom.querySelectorAll<HTMLSelectElement>(".dohc-code-language-select")[1];
    const plus = view.dom.querySelectorAll<HTMLButtonElement>(".dohc-block-plus")[2];
    const focused = control === "language" ? select : plus;
    focused.focus();
    const start = view.state.doc.child(0).nodeSize;
    const first = view.state.doc.child(1),
      second = view.state.doc.child(2);
    const target = start + first.nodeSize;
    const tr = view.state.tr;
    if (operation === "insert") tr.insert(target, codeBlock("inserted", "javascript"));
    if (operation === "remove") tr.delete(start, target);
    if (operation === "reorder") tr.replaceWith(start, tr.doc.content.size, [second, first]);
    if (operation === "replace")
      tr.replaceWith(start, tr.doc.content.size, [
        codeBlock("second", "javascript"),
        codeBlock("first", "javascript"),
      ]);
    if (operation === "split") tr.split(start + 3);
    if (operation === "join") tr.join(target);
    if (operation === "multi-step")
      tr.insertText("extra", 2).insert(target + 5, codeBlock("inserted", "javascript"));
    view.dispatch(tr);
    if (select.isConnected) {
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const changed: string[] = [];
      view.state.doc.forEach((node) => {
        if (node.attrs.language === "python") changed.push(node.textContent);
      });
      expect(changed).toEqual(["second"]);
    } else {
      const document = view.state.doc;
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(view.state.doc).toBe(document);
    }
    if (!focused.isConnected) expect(document.activeElement).not.toBe(focused);
    if (plus.isConnected) {
      plus.click();
      expect(view.state.doc.nodeAt(onInsert.mock.lastCall![0])?.textContent).toBe("second");
    } else {
      plus.click();
      expect(onInsert).not.toHaveBeenCalled();
    }
    if (operation === "reorder" || operation === "replace" || operation === "join") {
      expect(select.isConnected).toBe(false);
      expect(plus.isConnected).toBe(false);
    }
  });

  it.each([false])(
    "updates retained language controls when initial editability %s changes",
    (initialEditable) => {
      const host = document.body.appendChild(document.createElement("div"));
      const view = new EditorView(host, {
        state: EditorState.create({
          doc: doc(paragraph("lead"), codeBlock("first", "javascript")),
          plugins: [blockControls(), makeCodeBlockChromePlugin()],
        }),
        editable: () => initialEditable,
      });
      views.push(view);
      const select = view.dom.querySelector<HTMLSelectElement>(".dohc-code-language-select")!;
      const toolbar = view.dom.querySelector(".dohc-code-block-toolbar");
      expect(select.disabled).toBe(!initialEditable);
      const scan = vi.spyOn(view.dom, "querySelectorAll");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      view.dispatch(view.state.tr.insertText("x", 2));
      expect(scan).not.toHaveBeenCalled();
      view.setProps({ editable: () => !initialEditable });
      expect(select.disabled).toBe(initialEditable);
      expect(scan).toHaveBeenCalledTimes(1);
      view.dispatch(view.state.tr.insertText("y", 2));
      expect(view.dom.querySelector(".dohc-code-block-toolbar")).toBe(toolbar);
      expect(view.dom.querySelector(".dohc-code-language-select")).toBe(select);
      expect(scan).toHaveBeenCalledTimes(1);
      view.setProps({ editable: () => true });
      expect(select.disabled).toBe(false);
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      expect(view.state.doc.child(1).attrs.language).toBe("python");
      view.setProps({ editable: () => false });
      const readonlySelect = view.dom.querySelector<HTMLSelectElement>(
        ".dohc-code-language-select",
      )!;
      expect(readonlySelect.disabled).toBe(true);
      readonlySelect.value = "rust";
      readonlySelect.dispatchEvent(new Event("change", { bubbles: true }));
      expect(view.state.doc.child(1).attrs.language).toBe("python");
      expect(view.dom.querySelector<HTMLButtonElement>(".dohc-code-copy-btn")!.disabled).toBe(
        false,
      );
    },
  );
});
