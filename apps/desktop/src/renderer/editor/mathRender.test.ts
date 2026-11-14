// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { DecorationSet, type EditorView, type NodeView } from "@tiptap/pm/view";
import { makeMathNodeView, renderMathInto } from "./mathRender";

describe("renderMathInto", () => {
  it("renders TeX through the real KaTeX package", async () => {
    const target = document.createElement("span");

    renderMathInto(target, String.raw`\frac{x^2}{y}`, false);

    await vi.waitFor(() => {
      expect(target.querySelector(":scope > .katex")).not.toBeNull();
    });
    expect(target.querySelector("math")).not.toBeNull();
    expect(target.classList.contains("dohc-math--error")).toBe(false);
  });
});

/** The NodeView.update contract takes (node, decorations, innerDecorations);
 *  this NodeView only inspects the node, so the decoration args are inert. */
function pushUpdate(nodeView: NodeView, node: ProseMirrorNode): void {
  nodeView.update?.(node, [], DecorationSet.empty);
}

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

function makeNodeView(tex: string): {
  nodeView: NodeView;
  view: EditorView;
  dispatched: MarkupCall[];
} {
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
  it("does not overwrite a remote tex change when the user made no local edit", () => {
    const { nodeView, dispatched } = makeNodeView("a");

    nodeView.selectNode?.();
    expect(sourceField(nodeView).value).toBe("a");

    pushUpdate(nodeView, mathNode("b"));
    expect(sourceField(nodeView).value).toBe("b");

    nodeView.deselectNode?.();

    expect(dispatched).toHaveLength(0);
  });

  it("commits the user's edit on blur when they actually changed the field (last-writer-wins)", () => {
    const { nodeView, dispatched } = makeNodeView("a");

    nodeView.selectNode?.();
    sourceField(nodeView).value = "xyz";

    pushUpdate(nodeView, mathNode("b"));
    expect(sourceField(nodeView).value).toBe("xyz");

    nodeView.deselectNode?.();

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
    sourceField(nodeView).value = "e=mc^2";
    nodeView.destroy?.();
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
