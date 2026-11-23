// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Editor, Extension } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import { Decoration, type DecorationSet } from "@tiptap/pm/view";
import { makeCodeBlockChromePlugin, makeCodeBlockContinuationPlugin } from "./codeBlockChrome";
import { codeBlock, doc, paragraph, randomEdit, schema, seededRandom } from "./testDocs";

function toolbars(state: EditorState, plugin: Plugin) {
  return (plugin.getState(state) as DecorationSet)
    .find()
    .map((toolbar) => ({
      pos: toolbar.from,
      key: String(toolbar.spec.key),
      owner: String(toolbar.spec.ownerKey),
    }))
    .sort((a, b) => a.pos - b.pos);
}

function expected(document: PMNode) {
  const plugin = makeCodeBlockChromePlugin();
  return shown(EditorState.create({ doc: document, plugins: [plugin] }), plugin);
}

function shown(state: EditorState, plugin: Plugin) {
  return toolbars(state, plugin).map(({ pos, key, owner }) => ({
    pos,
    language: key.slice(`code-lang-${owner}-`.length),
  }));
}

describe("makeCodeBlockChromePlugin — edits", () => {
  it("matches a full rebuild after every edit", () => {
    const random = seededRandom(2260);
    const plugin = makeCodeBlockChromePlugin();
    let state = EditorState.create({
      doc: doc(
        codeBlock("const x = 1;", "typescript"),
        paragraph("plain text"),
        codeBlock("print(1)", "python"),
        codeBlock("no language"),
        paragraph("after"),
      ),
      plugins: [plugin],
    });
    for (let step = 0; step < 400; step += 1) {
      state = state.apply(randomEdit(state, random, ["a", " ", "\n", "x = 2", "``"]));
      expect(shown(state, plugin), `step ${step}`).toEqual(expected(state.doc));
    }
  });

  it("keeps a toolbar on its code block when a block is inserted right before it", () => {
    const plugin = makeCodeBlockChromePlugin();
    const lead = paragraph("lead");
    let state = EditorState.create({ doc: doc(lead, codeBlock("x", "go")), plugins: [plugin] });
    const [before] = toolbars(state, plugin);
    state = state.apply(state.tr.insert(lead.nodeSize, schema.nodes.horizontalRule.create()));
    state = state.apply(state.tr.insert(lead.nodeSize, paragraph("new")));
    expect(shown(state, plugin)).toEqual(expected(state.doc));
    // The toolbar keeps its owner, so the editor keeps its DOM.
    expect(toolbars(state, plugin)[0]!.owner).toBe(before!.owner);
  });

  it("keeps a toolbar on its code block when an identical code block is inserted right before it", () => {
    const plugin = makeCodeBlockChromePlugin();
    const lead = paragraph("lead");
    const block = codeBlock("x", "go");
    const start = EditorState.create({
      doc: doc(lead, block, paragraph("after")),
      plugins: [plugin],
    });
    const [before] = toolbars(start, plugin);
    const state = start.apply(start.tr.insert(lead.nodeSize, block));
    const [copy, original] = toolbars(state, plugin);
    expect(original!.owner).toBe(before!.owner);
    expect(copy!.owner).not.toBe(before!.owner);
    expect(shown(state, plugin)).toEqual(expected(state.doc));

    // The same insert at the note's start, with a paragraph added at its end.
    const first = EditorState.create({ doc: doc(block, paragraph("tail")), plugins: [plugin] });
    const [firstBefore] = toolbars(first, plugin);
    const tr = first.tr.insert(0, block);
    const both = first.apply(tr.insert(tr.doc.content.size, paragraph("end")));
    expect(toolbars(both, plugin).map(({ owner }) => owner === firstBefore!.owner)).toEqual([
      false,
      true,
    ]);
    expect(shown(both, plugin)).toEqual(expected(both.doc));
  });

  it("keeps a toolbar's owner through one edit on both sides of it, and through a remote update", () => {
    const plugin = makeCodeBlockChromePlugin();
    let state = EditorState.create({
      doc: doc(paragraph("lead"), codeBlock("x", "go"), paragraph("after")),
      plugins: [plugin],
    });
    const owners = toolbars(state, plugin).map(({ owner }) => owner);

    const tr = state.tr.insertText("x", 1);
    state = state.apply(tr.insertText("y", tr.doc.content.size - 1));
    expect(toolbars(state, plugin).map(({ owner }) => owner)).toEqual(owners);

    const remote = doc(paragraph("lead, edited"), codeBlock("x", "go"), paragraph("after, edited"));
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, remote.content));
    expect(toolbars(state, plugin).map(({ owner }) => owner)).toEqual(owners);
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });

  it("makes no toolbar again when typing in a note with 2,000 code blocks", () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => codeBlock(`value${i}`, "typescript"));
    const plugin = makeCodeBlockChromePlugin();
    let state = EditorState.create({ doc: doc(paragraph("lead"), ...blocks), plugins: [plugin] });
    const owners = toolbars(state, plugin).map(({ owner }) => owner);
    const widget = vi.spyOn(Decoration, "widget");
    try {
      state = state.apply(state.tr.insertText("x", 1));
      const middle =
        state.doc.child(0).nodeSize +
        blocks.slice(0, 1000).reduce((pos, block) => pos + block.nodeSize, 0);
      state = state.apply(state.tr.insertText("y", middle + 1));
      expect(widget).not.toHaveBeenCalled();
    } finally {
      widget.mockRestore();
    }
    expect(toolbars(state, plugin).map(({ owner }) => owner)).toEqual(owners);
  });
});

describe("codeBlockChrome — Tab indent/outdent and word wrap", () => {
  function makeCodeEditor(content: string): Editor {
    const ext = Extension.create({
      name: "testCodeChrome",
      addProseMirrorPlugins() {
        return [makeCodeBlockChromePlugin(), makeCodeBlockContinuationPlugin()];
      },
    });
    return new Editor({
      extensions: [StarterKit, ext],
      content,
    });
  }

  it("indents with Tab and outdents with Shift+Tab inside a code block", () => {
    const editor = makeCodeEditor("<pre><code>alpha\nbeta</code></pre>");
    try {
      // Caret at start of "alpha" (pos 1)
      editor.commands.setTextSelection(1);
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        cancelable: true,
        bubbles: true,
      });
      editor.view.dom.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(editor.state.doc.child(0).textContent).toBe("  alpha\nbeta");

      // Shift+Tab outdents the two spaces
      const shiftTab = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      });
      editor.view.dom.dispatchEvent(shiftTab);
      expect(shiftTab.defaultPrevented).toBe(true);
      expect(editor.state.doc.child(0).textContent).toBe("alpha\nbeta");

      // Multi-line selection indents and outdents every selected line
      editor.commands.setTextSelection({ from: 2, to: 10 });
      const multiTab = new KeyboardEvent("keydown", {
        key: "Tab",
        cancelable: true,
        bubbles: true,
      });
      editor.view.dom.dispatchEvent(multiTab);
      expect(editor.state.doc.child(0).textContent).toBe("  alpha\n  beta");

      const multiShiftTab = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        cancelable: true,
        bubbles: true,
      });
      editor.view.dom.dispatchEvent(multiShiftTab);
      expect(editor.state.doc.child(0).textContent).toBe("alpha\nbeta");
    } finally {
      editor.destroy();
    }
  });

  it("toggles word wrap on the code block toolbar and preserves it across language change", () => {
    const editor = makeCodeEditor('<pre><code class="language-ts">const x = 1;</code></pre>');
    try {
      const toolbar = editor.view.dom.querySelector(
        ".dohc-code-block-toolbar",
      ) as HTMLElement | null;
      expect(toolbar).not.toBeNull();
      const wrapBtn = toolbar!.querySelector(
        'button[aria-label="Wrap lines"]',
      ) as HTMLButtonElement | null;
      expect(wrapBtn).not.toBeNull();
      expect(wrapBtn!.getAttribute("aria-pressed")).toBe("false");
      expect(toolbar!.classList.contains("is-wrapped")).toBe(false);

      wrapBtn!.click();
      expect(wrapBtn!.getAttribute("aria-pressed")).toBe("true");
      expect(toolbar!.classList.contains("is-wrapped")).toBe(true);

      // Change language -> toolbar rebuilds for same owner and restores wrapped state
      const select = toolbar!.querySelector(
        'select[aria-label="Code language"]',
      ) as HTMLSelectElement;
      select.value = "python";
      select.dispatchEvent(new Event("change", { bubbles: true }));

      const rebuiltToolbar = editor.view.dom.querySelector(
        ".dohc-code-block-toolbar",
      ) as HTMLElement;
      const rebuiltWrapBtn = rebuiltToolbar.querySelector(
        'button[aria-label="Wrap lines"]',
      ) as HTMLButtonElement;
      expect(rebuiltWrapBtn.getAttribute("aria-pressed")).toBe("true");
      expect(rebuiltToolbar.classList.contains("is-wrapped")).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
