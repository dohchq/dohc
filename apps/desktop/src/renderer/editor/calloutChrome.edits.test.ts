import { describe, expect, it, vi } from "vitest";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import { Decoration, type DecorationSet } from "@tiptap/pm/view";
import { makeCalloutChromePlugin } from "./calloutChrome";
import { doc, paragraph, randomEdit, schema, seededRandom } from "./testDocs";

const callout = (calloutType: string, title: string, ...blocks: PMNode[]) =>
  schema.node("callout", { calloutType, title }, blocks.length ? blocks : [paragraph("body")]);

function headers(state: EditorState, plugin: Plugin) {
  return (plugin.getState(state) as DecorationSet)
    .find()
    .map((header) => ({ pos: header.from, key: String(header.spec.key), owner: String(header.spec.ownerKey) }))
    .sort((a, b) => a.pos - b.pos);
}

// Each header's position and type/fold, without the owner part of its key.
function shown(state: EditorState, plugin: Plugin) {
  return headers(state, plugin).map(({ pos, key, owner }) => ({ pos, chrome: key.slice(`callout-${owner}-`.length) }));
}

function expected(document: PMNode) {
  const plugin = makeCalloutChromePlugin();
  return shown(EditorState.create({ doc: document, plugins: [plugin] }), plugin);
}

function calloutPositions(document: PMNode): number[] {
  const positions: number[] = [];
  document.descendants((node, pos) => {
    if (node.type.name === "callout") positions.push(pos);
  });
  return positions;
}

describe("makeCalloutChromePlugin — edits", () => {
  it("matches a full rebuild after every edit", () => {
    const random = seededRandom(2260);
    const plugin = makeCalloutChromePlugin();
    let state = EditorState.create({
      doc: doc(
        paragraph("lead"),
        callout("note", "First", paragraph("one"), callout("tip", "Nested")),
        paragraph("between"),
        callout("warning", ""),
        paragraph("after"),
      ),
      plugins: [plugin],
    });
    const types = ["note", "tip", "danger"];
    for (let step = 0; step < 400; step += 1) {
      const positions = calloutPositions(state.doc);
      if (positions.length && random() < 0.15) {
        const pos = positions[Math.floor(random() * positions.length)]!;
        const node = state.doc.nodeAt(pos)!;
        const attrs =
          random() < 0.5
            ? { ...node.attrs, title: `${node.attrs.title}x` }
            : { ...node.attrs, calloutType: types[Math.floor(random() * types.length)] };
        state = state.apply(state.tr.setNodeMarkup(pos, undefined, attrs));
      } else {
        state = state.apply(randomEdit(state, random, ["a", " ", "\n", "> "]));
      }
      expect(shown(state, plugin), `step ${step}`).toEqual(expected(state.doc));
    }
  });

  it("keeps a header's owner through a new title, a block inserted before it, and a block at the start of its body", () => {
    const plugin = makeCalloutChromePlugin();
    const lead = paragraph("lead");
    let state = EditorState.create({ doc: doc(lead, callout("note", "Title")), plugins: [plugin] });
    const [first] = headers(state, plugin);

    state = state.apply(state.tr.setNodeMarkup(lead.nodeSize, undefined, { calloutType: "note", title: "Renamed" }));
    expect(headers(state, plugin)).toEqual([first]);

    state = state.apply(state.tr.insert(0, schema.nodes.horizontalRule.create()));
    const pos = calloutPositions(state.doc)[0]!;
    expect(headers(state, plugin)).toEqual([{ ...first!, pos: pos + 1 }]);

    state = state.apply(state.tr.insert(pos + 1, paragraph("new first line")));
    expect(headers(state, plugin)).toEqual([{ ...first!, pos: pos + 1 }]);
  });

  it("keeps a header's owner through one edit on both sides of it, and through a remote update", () => {
    const plugin = makeCalloutChromePlugin();
    let state = EditorState.create({
      doc: doc(paragraph("lead"), callout("note", "Title"), paragraph("after")),
      plugins: [plugin],
    });
    const owners = headers(state, plugin).map(({ owner }) => owner);

    const tr = state.tr.insertText("x", 1);
    state = state.apply(tr.insertText("y", tr.doc.content.size - 1));
    expect(headers(state, plugin).map(({ owner }) => owner)).toEqual(owners);

    const remote = doc(paragraph("lead, edited"), callout("note", "Title"), paragraph("after, edited"));
    state = state.apply(state.tr.replaceWith(0, state.doc.content.size, remote.content));
    expect(headers(state, plugin).map(({ owner }) => owner)).toEqual(owners);
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });

  it("gives no callout another callout's owner when one edit deletes a callout and adds one", () => {
    const plugin = makeCalloutChromePlugin();
    const a = callout("note", "Same", paragraph("a"));
    const b = callout("note", "Same", paragraph("b"));
    const c = callout("note", "Same", paragraph("c"));
    const start = EditorState.create({
      doc: doc(paragraph("lead"), a, b, paragraph("after")),
      plugins: [plugin],
    });
    const [ownerA, ownerB] = headers(start, plugin).map(({ owner }) => owner);
    const [posA, posB] = calloutPositions(start.doc);

    // B's title has focus. In one edit, A goes, C comes after B, and the
    // paragraph before them changes.
    let tr = start.tr.insert(posB! + b.nodeSize, c);
    tr = tr.delete(posA!, posA! + a.nodeSize);
    let state = start.apply(tr.insertText("x", 1));
    const [shownB, shownC] = headers(state, plugin);
    expect(shownB!.owner).toBe(ownerB);
    expect([ownerA, ownerB]).not.toContain(shownC!.owner);

    // The same change from another computer replaces the whole document.
    const remote = doc(paragraph("lead, edited"), b, c, paragraph("after, edited"));
    state = start.apply(start.tr.replaceWith(0, start.doc.content.size, remote.content));
    const [remoteB, remoteC] = headers(state, plugin);
    expect(remoteB!.owner).toBe(ownerB);
    expect([ownerA, ownerB]).not.toContain(remoteC!.owner);
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });

  it("makes no header again when typing in a note with 2,000 callouts", () => {
    const plugin = makeCalloutChromePlugin();
    let state = EditorState.create({
      doc: doc(...Array.from({ length: 2000 }, (_, index) => callout("note", `Callout ${index}`))),
      plugins: [plugin],
    });
    const owners = headers(state, plugin).map(({ owner }) => owner);
    const widget = vi.spyOn(Decoration, "widget");
    try {
      state = state.apply(state.tr.insertText("x", calloutPositions(state.doc)[1000]! + 3));
      expect(widget).not.toHaveBeenCalled();
    } finally {
      widget.mockRestore();
    }
    expect(headers(state, plugin).map(({ owner }) => owner)).toEqual(owners);
  });
});
