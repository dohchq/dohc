import { describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import { Decoration, type DecorationSet } from "@tiptap/pm/view";
import { makeCodeBlockChromePlugin } from "./codeBlockChrome";
import { codeBlock, doc, paragraph, randomEdit, schema, seededRandom } from "./testDocs";

function toolbars(state: EditorState, plugin: Plugin) {
  return (plugin.getState(state) as DecorationSet)
    .find()
    .map((toolbar) => ({ pos: toolbar.from, key: String(toolbar.spec.key), owner: String(toolbar.spec.ownerKey) }))
    .sort((a, b) => a.pos - b.pos);
}

/** Each code block's toolbar position and language, as a full rebuild makes them. */
function expected(document: PMNode) {
  const plugin = makeCodeBlockChromePlugin();
  return shown(EditorState.create({ doc: document, plugins: [plugin] }), plugin);
}

function shown(state: EditorState, plugin: Plugin) {
  return toolbars(state, plugin).map(({ pos, key, owner }) => ({ pos, language: key.slice(`code-lang-${owner}-`.length) }));
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

  it("makes no toolbar again when typing in a note with 2,000 code blocks", () => {
    const blocks = Array.from({ length: 2000 }, (_, i) => codeBlock(`value${i}`, "typescript"));
    const plugin = makeCodeBlockChromePlugin();
    let state = EditorState.create({ doc: doc(paragraph("lead"), ...blocks), plugins: [plugin] });
    const owners = toolbars(state, plugin).map(({ owner }) => owner);
    const widget = vi.spyOn(Decoration, "widget");
    try {
      state = state.apply(state.tr.insertText("x", 1));
      const middle = state.doc.child(0).nodeSize + blocks.slice(0, 1000).reduce((pos, block) => pos + block.nodeSize, 0);
      state = state.apply(state.tr.insertText("y", middle + 1));
      // Before this bound, each key made all 2,000 toolbars again.
      expect(widget).not.toHaveBeenCalled();
    } finally {
      widget.mockRestore();
    }
    expect(toolbars(state, plugin).map(({ owner }) => owner)).toEqual(owners);
  });
});
