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

  it("keys the headers an edit changes by their place among the callouts, as a full rebuild did", () => {
    const plugin = makeCalloutChromePlugin();
    const a = callout("note", "Same", paragraph("a"));
    const b = callout("note", "Same", paragraph("b"));
    const c = callout("note", "Same", paragraph("c"));
    let start = EditorState.create({ doc: doc(paragraph("lead"), b, a, paragraph("after")), plugins: [plugin] });
    let [ownerB, ownerA] = headers(start, plugin).map(({ owner }) => owner);
    const [posB] = calloutPositions(start.doc);

    // A's title has focus. In one edit, C and a copy of A come before B, A
    // goes, and the paragraph before them changes. The copy is second, as A was.
    let tr = start.tr.insert(posB!, [c, a]);
    const moved = posB! + c.nodeSize + a.nodeSize + b.nodeSize;
    tr = tr.delete(moved, moved + a.nodeSize);
    let state = start.apply(tr.insertText("x", 1));
    expect(headers(state, plugin).map(({ owner }) => owner)[1]).toBe(ownerA);
    expect(shown(state, plugin)).toEqual(expected(state.doc));

    // In one edit, A goes, B takes A's body, a copy of B follows, and the
    // paragraph before them changes. The callouts end as they began.
    start = EditorState.create({ doc: doc(paragraph("lead"), a, b, paragraph("after")), plugins: [plugin] });
    [ownerA, ownerB] = headers(start, plugin).map(({ owner }) => owner);
    const [posA, posSecond] = calloutPositions(start.doc);
    tr = start.tr.insert(posSecond! + b.nodeSize, b);
    tr = tr.replaceWith(posSecond! + 1, posSecond! + b.nodeSize - 1, a.content);
    tr = tr.delete(posA!, posA! + a.nodeSize);
    state = start.apply(tr.insertText("x", 1));
    expect(headers(state, plugin).map(({ owner }) => owner)).toEqual([ownerA, ownerB]);
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });

  it("keeps the focused callout's owner when the same edit sets its attributes again, or moves it, and adds a callout", () => {
    const plugin = makeCalloutChromePlugin();
    const a = callout("note", "Title", paragraph("body"));
    const after = paragraph("after");
    const start = EditorState.create({ doc: doc(paragraph("lead"), a, after), plugins: [plugin] });
    const [ownerA] = headers(start, plugin).map(({ owner }) => owner);
    const [posA] = calloutPositions(start.doc);

    // Setting the same attributes replaces the callout's opening.
    let state = start.apply(
      start.tr
        .setNodeMarkup(posA!, undefined, a.attrs)
        .insert(posA! + a.nodeSize, callout("tip", "New"))
        .insertText("x", 1),
    );
    expect(headers(state, plugin).map(({ owner }) => owner)[0]).toBe(ownerA);
    expect(shown(state, plugin)).toEqual(expected(state.doc));

    // The callout moves below the next paragraph, and a callout is added at the end.
    const end = posA! + a.nodeSize + after.nodeSize;
    const move = start.tr.insert(end, a).delete(posA!, posA! + a.nodeSize);
    state = start.apply(move.insert(move.doc.content.size, callout("tip", "New")));
    expect(headers(state, plugin).map(({ owner }) => owner)[0]).toBe(ownerA);
    expect(shown(state, plugin)).toEqual(expected(state.doc));
  });

  it("keeps the focused callout's owner when the same edit adds a callout and a line at the start of its body", () => {
    const plugin = makeCalloutChromePlugin();
    const a = callout("note", "Title");
    const start = EditorState.create({
      doc: doc(paragraph("lead"), a, paragraph("after")),
      plugins: [plugin],
    });
    const [ownerA] = headers(start, plugin).map(({ owner }) => owner);
    const [posA] = calloutPositions(start.doc);

    let tr = start.tr.insert(posA! + a.nodeSize, callout("tip", "New"));
    tr = tr.insert(posA! + 1, paragraph("new first line"));
    const state = start.apply(tr.insertText("x", 1));
    const [shownA, shownC] = headers(state, plugin);
    expect(shownA!.owner).toBe(ownerA);
    expect(shownC!.owner).not.toBe(ownerA);
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
