// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";
import { makeMathNodeView } from "./mathRender";

/** The NodeView.update contract takes (node, decorations, innerDecorations);
 *  this NodeView only inspects the node, so the decoration args are inert. */
function pushUpdate(nodeView: NodeView, node: ProseMirrorNode): void {
  nodeView.update?.(node, [], DecorationSet.empty);
}

// The math NodeView opens an editable source field on select and commits the
// field value on blur/deselect. The regression under test: while the field is
// open, a concurrent REMOTE tex change advances the node's attrs (update()),
// and a naive commit-on-blur would overwrite that remote edit with the stale
// field value even though the local user typed nothing. The commit must gate
// on whether the FIELD actually diverged from its edit-start baseline.

type MarkupCall = { pos: number; attrs: { tex: string } };

function makeFakeView(): { view: EditorView; dispatched: MarkupCall[] } {
  const dispatched: MarkupCall[] = [];
  const tr = {
    setNodeMarkup(pos: number, _mark: unknown, attrs: { tex: string }): MarkupCall {
      return { pos, attrs };
    },
  };
  const view = {
    editable: true,
    state: { tr },
    dispatch(t: MarkupCall): void {
      dispatched.push({ pos: t.pos, attrs: t.attrs });
    },
    focus(): void {},
  };
  return { view: view as unknown as EditorView, dispatched };
}

function mathNode(tex: string): ProseMirrorNode {
  return {
    type: { name: "mathInline" },
    attrs: { tex },
  } as unknown as ProseMirrorNode;
}

function makeNodeView(
  tex: string,
): { nodeView: NodeView; view: EditorView; dispatched: MarkupCall[] } {
  const { view, dispatched } = makeFakeView();
  const nodeView = makeMathNodeView(false)(mathNode(tex), view, () => 0);
  document.body.appendChild(nodeView.dom);
  return { nodeView, view, dispatched };
}

function sourceField(nodeView: NodeView): HTMLInputElement {
  const el = nodeView.dom.querySelector<HTMLInputElement>(".dohc-math__source");
  if (!el) throw new Error("source field not open");
  return el;
}

describe("makeMathNodeView — concurrent remote edits while the source field is open", () => {
  it("does NOT overwrite a remote tex change when the user made no local edit", () => {
    const { nodeView, dispatched } = makeNodeView("a");

    // User opens the source editor (no typing).
    nodeView.selectNode?.();
    expect(sourceField(nodeView).value).toBe("a");

    // A remote collaborator changes the same node's tex to "b".
    pushUpdate(nodeView, mathNode("b"));
    // The untouched field adopts the remote value so blur can't revert it.
    expect(sourceField(nodeView).value).toBe("b");

    // User clicks away without ever typing.
    nodeView.deselectNode?.();

    // The remote edit must survive: no dispatch overwrote it.
    expect(dispatched).toHaveLength(0);
  });

  it("commits the user's edit on blur when they actually changed the field (last-writer-wins)", () => {
    const { nodeView, dispatched } = makeNodeView("a");

    nodeView.selectNode?.();
    // User types a new expression locally.
    sourceField(nodeView).value = "xyz";

    // A remote edit also lands; because the user already diverged from the
    // baseline, their text is kept in the field (not clobbered by the remote).
    pushUpdate(nodeView, mathNode("b"));
    expect(sourceField(nodeView).value).toBe("xyz");

    nodeView.deselectNode?.();

    // The local edit is committed — last writer wins.
    expect(dispatched).toEqual([{ pos: 0, attrs: { tex: "xyz" } }]);
  });

  it("does not dispatch when opened and closed with no edit and no remote change", () => {
    const { nodeView, dispatched } = makeNodeView("a");
    nodeView.selectNode?.();
    nodeView.deselectNode?.();
    expect(dispatched).toHaveLength(0);
  });
});

describe("makeMathNodeView — destroy commits an in-progress edit instead of discarding", () => {
  it("commits the field value when the node view is torn down mid-edit", () => {
    const { nodeView, dispatched } = makeNodeView("a");
    nodeView.selectNode?.();
    // User types a new expression but switches/closes the document before
    // blur or Enter fires — destroy() runs with the field still open.
    sourceField(nodeView).value = "e=mc^2";
    nodeView.destroy?.();
    // The last TeX is committed, not silently dropped.
    expect(dispatched).toEqual([{ pos: 0, attrs: { tex: "e=mc^2" } }]);
  });

  it("does not dispatch on destroy when the field was never edited", () => {
    const { nodeView, dispatched } = makeNodeView("a");
    nodeView.selectNode?.();
    nodeView.destroy?.();
    expect(dispatched).toHaveLength(0);
  });

  it("does not dispatch on destroy when not in the editing state", () => {
    const { nodeView, dispatched } = makeNodeView("a");
    nodeView.destroy?.();
    expect(dispatched).toHaveLength(0);
  });
});
