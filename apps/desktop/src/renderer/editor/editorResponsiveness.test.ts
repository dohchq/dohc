// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, PluginKey, TextSelection, type Plugin } from "@tiptap/pm/state";
import { DecorationSet, EditorView } from "@tiptap/pm/view";
import { history, undo, redo } from "@tiptap/pm/history";
import { Node as PMNode } from "@tiptap/pm/model";
import { boldText, codeBlock, codeMarkText, doc, hardBreak, paragraph, schema } from "./testDocs";
import { detectAutocomplete, makeWikilinkPlugin, wikilinkPluginKey, type WikilinkFile } from "./wikilinkPlugin";
import { detectMentionAutocomplete } from "./mentionTrigger";
import { detectCompleteEmojiShortcode, detectEmojiAutocomplete } from "./emojiTrigger";
import { makeTriggerPlugin } from "./triggerPlugin";
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
const blockControls = () => makeBlockControlsPlugin({ onInsertRef: { current: () => {} }, onOpenMenuRef: { current: () => {} } });
function chromePlugins(): Plugin[] {
  return [
    makeSlashCommandPlugin({ stateRef: { current: CLOSED_SLASH_COMMAND_STATE }, setState: () => {}, runCommandRef: { current: () => {} } }),
    blockControls(), makeWikilinkPlugin(() => new Map(), () => {}), makeMentionPlugin(() => {}), makeEmojiPlugin(() => {}),
    makeHeadingFlashPlugin(), makeLinkMenuPlugin({ stateRef: { current: CLOSED_LINK_MENU_STATE }, setState: () => {} }),
    makeCodeBlockChromePlugin(), makeBlockExitPlugin(), makeCodeBlockContinuationPlugin(), makeCalloutChromePlugin(),
    makeCodeHighlightPlugin(), makeMermaidPreviewPlugin(), makeEmptyListItemFocusPlugin(), makeInlineAtomPlugin(), makeTableControlsPlugin(),
  ];
}
function expectSameElements(actual: NodeListOf<Element>, expected: Element[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((node, index) => expect(node).toBe(expected[index]));
}
function mount(document: PMNode, plugins: Plugin[]) {
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: document, plugins }),
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); },
  });
  views.push(view);
  return view;
}
afterEach(() => {
  for (const view of views.splice(0)) { const parent = view.dom.parentElement; view.destroy(); parent?.remove(); }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("cursor-local trigger semantics", () => {
  const cases = [
    { detect: detectAutocomplete, pattern: /\\?\[\\?\[([^\]\n[]*)$/, complete: false },
    { detect: detectMentionAutocomplete, pattern: /(?<=^|\s)@([^\s@[]*)$/, complete: false },
    { detect: detectEmojiAutocomplete, pattern: /(?<=^|\s):([a-zA-Z0-9_+-]{2,})$/, complete: false },
    { detect: detectCompleteEmojiShortcode, pattern: /(?<=^|\s):([a-zA-Z0-9_+-]{2,}):$/, complete: true },
  ];

  it("matches the previous full scan at every cursor position across marks, atoms, and nested blocks", () => {
    const document = doc(
      paragraph("prefix [[one @two :smile: ", boldText("[[bold @bold :fire:"), "[[plain", codeMarkText("@code :smile: [[code")),
      paragraph("[[before", hardBreak(), "@after", schema.nodes.wikilink.create({ target: "a", label: "A" }), ":wave:"),
      codeBlock("[[no @no :smile:"),
      schema.nodes.blockquote.create(null, paragraph("\\[\\[escaped @nested :heart:")),
      paragraph(), paragraph(codeMarkText("code"), boldText("@yes"), " [[yes"),
    );
    for (let cursor = 0; cursor <= document.content.size; cursor++) {
      for (const { detect, pattern, complete } of cases) {
        let expected: unknown = complete ? null : { active: false };
        document.descendants((node, pos, parent) => {
          if (!node.isText || !node.text || isCodeBlock(parent) || node.marks.some(isCodeMark)) return;
          if (cursor < pos || cursor > pos + node.text.length) return;
          const before = node.text.slice(0, cursor - pos);
          const match = pattern.exec(before);
          if (!match) return;
          const from = pos + before.length - match[0].length;
          expected = complete ? { from, to: cursor, shortcode: match[1] } : { active: true, from, query: match[1] };
        });
        expect(detect(document, cursor), `${detect.name} at ${cursor}`).toEqual(expected);
      }
    }
  });

  it("does not visit document descendants to detect a trigger", () => {
    const document = doc(...Array.from({ length: 1000 }, () => paragraph("text")), paragraph("[[yes @yes :smile:"));
    const scan = vi.spyOn(document, "descendants");
    for (const { detect } of cases) detect(document, document.content.size - 1);
    expect(scan).not.toHaveBeenCalled();
  });

  it("skips detector work for metadata and selection-extent-only changes", () => {
    const detect = vi.fn(() => ({ active: false as const }));
    const view = mount(doc(paragraph("hello")), [makeTriggerPlugin({ key: new PluginKey("probe") }, detect, () => {})]);
    expect(detect).toHaveBeenCalledTimes(1);
    view.dispatch(view.state.tr.setMeta("remote-presence", 1));
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
    expect(detect).toHaveBeenCalledTimes(1);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    view.dispatch(view.state.tr.insertText("x", 2));
    expect(detect).toHaveBeenCalledTimes(3);
  });
});

describe("wikilink decoration reuse", () => {
  it("keeps pills and decorations during plain selection moves without scanning document text", () => {
    const files = vi.fn(() => new Map<string, WikilinkFile>());
    const view = mount(doc(paragraph("plain text"), ...Array.from({ length: 200 }, (_, i) => paragraph(`[[file-${i}]]`))), [makeWikilinkPlugin(files, () => {})]);
    const pills = [...view.dom.querySelectorAll(".dohc-wikilink-pill")];
    const original = wikilinkPluginKey.getState(view.state)?.decorations;
    const scan = vi.spyOn(view.state.doc, "descendants");
    for (let i = 2; i < 9; i++) view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, i)));
    expect(scan).not.toHaveBeenCalled();
    expect(wikilinkPluginKey.getState(view.state)?.decorations).toBe(original);
    expectSameElements(view.dom.querySelectorAll(".dohc-wikilink-pill"), pills);
    const reads = files.mock.calls.length;
    view.dispatch(view.state.tr.setMeta("presence", true));
    expect(files).toHaveBeenCalledTimes(reads);
    view.dispatch(view.state.tr.insertText("x", 2));
    expectSameElements(view.dom.querySelectorAll(".dohc-wikilink-pill"), pills);
  });

  it("refreshes an in-place title, resolution, and replacement map at the same cursor", () => {
    const file: WikilinkFile = { path: "a.md", title: "Before" };
    let files = new Map([["a", file]]);
    const view = mount(doc(paragraph("plain"), paragraph("[[a]]")), [makeWikilinkPlugin(() => files, () => {})]);
    expect(view.dom.querySelector(".dohc-wikilink-pill")?.textContent).toBe("Before");
    file.title = "After";
    view.dispatch(view.state.tr.setSelection(view.state.selection));
    expect(view.dom.querySelector(".dohc-wikilink-pill")?.textContent).toBe("After");
    files.delete("a");
    view.dispatch(view.state.tr.setSelection(view.state.selection));
    expect(view.dom.querySelector(".dohc-wikilink-pill--broken")?.textContent).toBe("a");
    files = new Map([["a", { path: "a.md", title: "Restored" }]]);
    view.dispatch(view.state.tr.setSelection(view.state.selection));
    expect(view.dom.querySelector(".dohc-wikilink-pill")?.textContent).toBe("Restored");
    expect(view.dom.querySelector(".dohc-wikilink-pill--broken")).toBeNull();
  });

  it("toggles only the link under the cursor and preserves duplicate pills elsewhere", () => {
    const view = mount(doc(paragraph("lead"), paragraph("[[a]]"), paragraph("[[a]]")), [makeWikilinkPlugin(() => new Map(), () => {})]);
    const before = [...view.dom.querySelectorAll(".dohc-wikilink-pill")];
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)));
    expect(view.dom.querySelectorAll(".dohc-wikilink-source")).toHaveLength(1);
    expectSameElements(view.dom.querySelectorAll(".dohc-wikilink-pill"), [before[1]]);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    expect(view.dom.querySelectorAll(".dohc-wikilink-pill")).toHaveLength(2);
    expect(view.dom.querySelectorAll(".dohc-wikilink-pill")[1]).toBe(before[1]);
  });

  it("keeps duplicate links correct when a source toggle splits their shared text run", () => {
    const view = mount(doc(paragraph("lead"), paragraph("[[a]] and [[a]]")), [makeWikilinkPlugin(() => new Map(), () => {})]);
    for (const position of [7, 12]) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, position)));
      expect(view.dom.querySelectorAll(".dohc-wikilink-source")).toHaveLength(1);
      expect(view.dom.querySelectorAll(".dohc-wikilink-pill")).toHaveLength(1);
      expect(view.dom.querySelector(".dohc-wikilink-pill")?.getAttribute("data-wikilink-target")).toBe("a");
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
      expect(view.dom.querySelectorAll(".dohc-wikilink-source")).toHaveLength(0);
      expect(view.dom.querySelectorAll(".dohc-wikilink-pill")).toHaveLength(2);
    }
  });
});

describe("editor chrome reuse", () => {
  it.each([
    { name: "insert at start", from: 1, to: 1, text: "prefix " },
    { name: "insert at end", from: 6, to: 6, text: " suffix" },
    { name: "replace marked text", from: 2, to: 5, text: "🙂" },
    { name: "clear paragraph", from: 1, to: 6, text: "" },
  ])("maps gutter positions for $name without rebuilding decorations", ({ from, to, text }) => {
    const insert = vi.fn();
    const plugin = makeBlockControlsPlugin({ onInsertRef: { current: insert }, onOpenMenuRef: { current: () => {} } });
    const view = mount(doc(paragraph(boldText("first")), paragraph("second"), codeBlock("third")), [history(), plugin]);
    view.setProps({ handleScrollToSelection: () => true });
    const controls = [...view.dom.querySelectorAll(".dohc-block-affordance")];
    const build = vi.spyOn(DecorationSet, "create");
    view.dispatch(view.state.tr.insertText(text, from, to).setMeta("remote-origin", true));
    expect(build).not.toHaveBeenCalled();
    const assertControls = () => {
      expectSameElements(view.dom.querySelectorAll(".dohc-block-affordance"), controls);
      view.state.doc.forEach((node, position, index) => {
        expect(controls[index].getAttribute("data-dohc-block-index")).toBe(String(index));
        expect((view.nodeDOM(position) as HTMLElement).getAttribute("data-dohc-block-index")).toBe(String(index));
        (controls[index].querySelector(".dohc-block-plus") as HTMLButtonElement).click();
        expect(insert).toHaveBeenLastCalledWith(position);
      });
    };
    assertControls();
    expect(undo(view.state, view.dispatch)).toBe(true);
    assertControls();
    expect(redo(view.state, view.dispatch)).toBe(true);
    assertControls();
  });

  it("rebuilds gutters for structural slices, nested changes, and node markup", () => {
    const view = mount(doc(paragraph("first"), schema.nodes.blockquote.create(null, paragraph("nested")), codeBlock("code")), [blockControls()]);
    const build = vi.spyOn(DecorationSet, "create");
    view.dispatch(view.state.tr.split(3));
    expect(build).toHaveBeenCalled();
    build.mockClear();
    let quotePosition = 0;
    view.state.doc.forEach((node, position) => { if (node.type.name === "blockquote") quotePosition = position; });
    view.dispatch(view.state.tr.insertText("x", quotePosition + 2));
    expect(build).toHaveBeenCalled();
    build.mockClear();
    const codePosition = view.state.doc.content.size - view.state.doc.lastChild!.nodeSize;
    view.dispatch(view.state.tr.setNodeMarkup(codePosition, undefined, { language: "python" }));
    expect(build).toHaveBeenCalled();
    expect(view.dom.querySelectorAll(".dohc-block-affordance")).toHaveLength(view.state.doc.childCount);
  });

  it("rebuilds when a replacement crosses duplicate block objects", () => {
    const duplicate = paragraph("same");
    const view = mount(doc(duplicate, duplicate, paragraph("last")), [blockControls()]);
    view.dispatch(view.state.tr.insertText("joined", 2, duplicate.nodeSize + 3));
    expect(view.state.doc.childCount).toBe(2);
    expect(view.dom.querySelectorAll(".dohc-block-affordance")).toHaveLength(2);
    expect([...view.dom.querySelectorAll(".dohc-block-affordance")].map((control) => control.getAttribute("data-dohc-block-index"))).toEqual(["0", "1"]);
  });

  it("does not reconcile callout titles during selection-only or metadata updates", () => {
    const callout = schema.nodes.callout.create({ title: "Before" }, paragraph("body"));
    const view = mount(doc(paragraph("lead"), callout), [makeCalloutChromePlugin()]);
    const scan = vi.spyOn(view.state.doc, "descendants");
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 2)));
    view.dispatch(view.state.tr.setMeta("presence", 1));
    expect(scan).not.toHaveBeenCalled();
    view.dispatch(view.state.tr.setNodeMarkup(6, undefined, { ...callout.attrs, title: "After" }));
    expect(view.dom.querySelector<HTMLInputElement>(".dohc-callout-title-input")?.value).toBe("After");
  });

  it("preserves 50 toolbars through preceding text edits, code edits, undo, and redo", () => {
    const view = mount(doc(paragraph("lead"), ...Array.from({ length: 50 }, (_, i) => codeBlock(`code ${i}`, "javascript"))), [history(), ...chromePlugins()]);
    const toolbars = [...view.dom.querySelectorAll(".dohc-code-block-toolbar")];
    view.dispatch(view.state.tr.insertText("x", 2));
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
    view.dispatch(view.state.tr.insertText("changed ", 8));
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
    undo(view.state, view.dispatch);
    redo(view.state, view.dispatch);
    expectSameElements(view.dom.querySelectorAll(".dohc-code-block-toolbar"), toolbars);
  });

  it("retained block controls use current positions for insert, menu, and drag after edits and reorder", () => {
    const onInsert = vi.fn();
    const onMenu = vi.fn();
    const view = mount(doc(paragraph("lead"), codeBlock("first", "javascript"), codeBlock("second", "javascript")), [
      makeBlockControlsPlugin({ onInsertRef: { current: onInsert }, onOpenMenuRef: { current: onMenu } }),
      makeCodeBlockChromePlugin(),
    ]);
    const controls = [...view.dom.querySelectorAll(".dohc-block-affordance")];
    view.dispatch(view.state.tr.insertText("extra ", 2));
    expectSameElements(view.dom.querySelectorAll(".dohc-block-affordance"), controls);
    const checkActions = () => {
      const currentPos = view.state.doc.child(0).nodeSize;
      const control = view.dom.querySelectorAll(".dohc-block-affordance")[1];
      (control.querySelector(".dohc-block-plus") as HTMLButtonElement).click();
      expect(onInsert).toHaveBeenLastCalledWith(currentPos);
      const handle = control.querySelector(".dohc-block-handle") as HTMLButtonElement;
      handle.click();
      expect(onMenu.mock.lastCall?.[0]).toBe(currentPos);
      expect(view.state.selection.from).toBe(currentPos);
      const dataTransfer = { clearData: vi.fn(), setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: "" };
      const event = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      handle.dispatchEvent(event);
      expect(view.dragging?.slice.content.firstChild?.textContent).toBe(view.state.doc.child(1).textContent);
      expect(view.state.selection.from).toBe(currentPos);
      handle.dispatchEvent(new Event("dragend", { bubbles: true }));
    };
    checkActions();
    const start = view.state.doc.child(0).nodeSize;
    view.dispatch(view.state.tr.insert(start, paragraph("inserted")));
    checkActions();
    view.dispatch(view.state.tr.delete(start, start + view.state.doc.child(1).nodeSize));
    checkActions();
    const first = view.state.doc.child(1), second = view.state.doc.child(2);
    view.dispatch(view.state.tr.replaceWith(start, view.state.doc.content.size, [second, first]));
    checkActions();
  });

  it.each(["insert", "remove", "reorder", "replace", "split", "join", "multi-step"].flatMap(
    (operation) => ["language", "gutter"].map((control) => ({ operation, control })),
  ))("does not retarget focused $control after $operation", ({ operation, control }) => {
    const onInsert = vi.fn();
    const view = mount(doc(paragraph("lead"), codeBlock("first", "javascript"), codeBlock("second", "javascript")), [
      makeBlockControlsPlugin({ onInsertRef: { current: onInsert }, onOpenMenuRef: { current: () => {} } }),
      makeCodeBlockChromePlugin(),
    ]);
    view.setProps({ handleScrollToSelection: () => true });
    const select = view.dom.querySelectorAll<HTMLSelectElement>(".dohc-code-language-select")[1];
    const plus = view.dom.querySelectorAll<HTMLButtonElement>(".dohc-block-plus")[2];
    const focused = control === "language" ? select : plus;
    focused.focus();
    const start = view.state.doc.child(0).nodeSize;
    const first = view.state.doc.child(1), second = view.state.doc.child(2);
    const target = start + first.nodeSize;
    const tr = view.state.tr;
    if (operation === "insert") tr.insert(target, codeBlock("inserted", "javascript"));
    if (operation === "remove") tr.delete(start, target);
    if (operation === "reorder") tr.replaceWith(start, tr.doc.content.size, [second, first]);
    if (operation === "replace") tr.replaceWith(start, tr.doc.content.size, [codeBlock("second", "javascript"), codeBlock("first", "javascript")]);
    if (operation === "split") tr.split(start + 3);
    if (operation === "join") tr.join(target);
    if (operation === "multi-step") tr.insertText("extra", 2).insert(target + 5, codeBlock("inserted", "javascript"));
    view.dispatch(tr);
    if (select.isConnected) {
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      const changed: string[] = [];
      view.state.doc.forEach((node) => { if (node.attrs.language === "python") changed.push(node.textContent); });
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

  it.each([false, true])("updates retained language controls when initial editability %s changes", (initialEditable) => {
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
    const readonlySelect = view.dom.querySelector<HTMLSelectElement>(".dohc-code-language-select")!;
    expect(readonlySelect.disabled).toBe(true);
    readonlySelect.value = "rust";
    readonlySelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.child(1).attrs.language).toBe("python");
    expect(view.dom.querySelector<HTMLButtonElement>(".dohc-code-copy-btn")!.disabled).toBe(false);
  });

  it("copy and language actions target the current blocks after insertion, removal, and reorder", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const view = mount(doc(paragraph("lead"), codeBlock("first", "javascript"), codeBlock("second", "javascript")), [blockControls(), makeCodeBlockChromePlugin()]);
    const assertCopies = (expected: string[]) => {
      writeText.mockClear();
      for (const button of view.dom.querySelectorAll<HTMLButtonElement>(".dohc-code-copy-btn")) button.click();
      expect(writeText.mock.calls.map(([text]) => text)).toEqual(expected);
    };
    view.dispatch(view.state.tr.insertText("new ", 2));
    assertCopies(["first", "second"]);
    const start = view.state.doc.child(0).nodeSize;
    view.dispatch(view.state.tr.insert(start, codeBlock("inserted", "javascript")));
    assertCopies(["inserted", "first", "second"]);
    view.dispatch(view.state.tr.delete(start, start + view.state.doc.child(1).nodeSize));
    assertCopies(["first", "second"]);
    const first = view.state.doc.child(1);
    const second = view.state.doc.child(2);
    view.dispatch(view.state.tr.replaceWith(start, view.state.doc.content.size, [second, first]));
    assertCopies(["second", "first"]);
    const select = view.dom.querySelector<HTMLSelectElement>(".dohc-code-language-select")!;
    select.value = "python";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.child(1).attrs.language).toBe("python");
    expect(view.state.doc.child(2).attrs.language).toBe("javascript");
    view.setProps({ editable: () => false });
    const readonlySelect = view.dom.querySelector<HTMLSelectElement>(".dohc-code-language-select")!;
    readonlySelect.value = "rust";
    readonlySelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(view.state.doc.child(1).attrs.language).toBe("python");
  });
});
