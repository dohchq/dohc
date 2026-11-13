// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor, JSONContent, TiptapEditorHTMLElement } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { getDohcProseMirrorSchema, getDohcYDocBodyFragment, parseRichdocMarkdown, serializeRichdocBody, yDocToMarkdown as projectYDocToMarkdown } from "@dohc/ydoc-projection";
import { escapeHighlightMarkdown } from "@dohc/ydoc-projection/markdown-extensions";
import rawHtml from "../../../../../packages/ydoc-projection/src/fixtures/raw-html.json";
import { EDGE_FRONTMATTER, receivedYDoc } from "../markdown/frontmatter.edge-fixture";
import { yDocToMarkdown } from "./import-export";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";

// The desktop editor binds the documents the projection writes, so its schema
// has to read every node, mark, and attribute the projection writes. These
// tests compare the schema the mounted editor actually builds with the
// projection's, and move edge content between them through the Yjs wire.

const canonical = getDohcProseMirrorSchema();

const PARITY_BODY = [
  "See [[notes/plan|Plan \\]\\] Draft \\| v2]] beside ==marked text== and {{atom:rate 150}} with $x^2$.",
  "",
  "Mixed **bold ==both== bold**, ==*italic* highlight==, [==linked== **strong**](https://example.com) and `code` beside ==highlight==.",
  "",
  "- [ ] parent",
  "  - child one",
  "",
  "> [!warning]- Folded",
  "> callout body",
  "",
  "> [!broken header",
  "",
  "abc. not an alpha marker",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  '![alt text](assets/pic.png "Title")',
  "",
  "<!-- dohc:table row-heights=1:84 -->",
  "| A | B |",
  "| --- | :---: |",
  "| 1 | 2 |",
  "",
  "````js",
  "before",
  "```",
  "after",
  "````",
  "",
  "After.",
].join("\n");

function nodeTypes(node: JSONContent, types = new Set<string>()): Set<string> {
  if (node.type) types.add(node.type);
  for (const child of node.content ?? []) nodeTypes(child, types);
  return types;
}

/** The mark types on the first text node reading `text`, in document order. */
function marksOn(node: JSONContent, text: string): string[] | undefined {
  if (node.text === text) return (node.marks ?? []).map((mark) => mark.type);
  for (const child of node.content ?? []) {
    const marks = marksOn(child, text);
    if (marks) return marks;
  }
  return undefined;
}

// A resized column carries its width on every cell of the column, as the
// editor's column resizing writes it. The Markdown has no width syntax, so
// the width enters through the Y.Doc, the only place it lives.
function setFirstColumnWidth(doc: Y.Doc, width: number): void {
  const table = getDohcYDocBodyFragment(doc)
    .toArray()
    .find((child): child is Y.XmlElement =>
      child instanceof Y.XmlElement && child.nodeName === "table",
    );
  if (!table) throw new Error("the parity document has no table");
  for (const row of table.toArray()) {
    const cell = (row as Y.XmlElement).get(0) as Y.XmlElement<{ colwidth: number[] }>;
    cell.setAttribute("colwidth", [width]);
  }
}

function mountedEditor(): Editor {
  const { editor } = screen.getByTestId("markdown-editor") as TiptapEditorHTMLElement;
  if (!editor) throw new Error("The editor surface has no Tiptap editor mounted.");
  return editor;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    Number(setTimeout(() => callback(performance.now()), 16)),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Raw HTML is the text the file holds. Tiptap reads it through the DOM when one
// exists, so the projection's parser keeps it as text itself. The projection's
// own Node test reads the same fixture to the same document.
describe("raw HTML in a browser", () => {
  it("saves its comments and tags as text after an edit", async () => {
    const onDirty = vi.fn<(materialize?: () => string) => void>();
    render(
      createElement(MarkdownEditor, {
        value: rawHtml.markdown,
        onDirty,
        workspaceId: "workspace-1",
        path: "notes/raw.md",
        knownFiles: [],
      }),
    );
    await screen.findByTestId("markdown-editor");
    const editor = mountedEditor();
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, "!");
    });
    const materialize = onDirty.mock.calls.at(-1)?.[0];
    expect(materialize).toBeTypeOf("function");
    const edited = {
      ...rawHtml.document,
      content: [
        ...rawHtml.document.content.slice(0, -1),
        { type: "paragraph", content: [{ type: "text", text: "After.!" }] },
      ],
    };
    expect(parseRichdocMarkdown(materialize!())).toEqual(edited);
  });

  // A block added at the end just before the restore is a history event the
  // restore, which also replaces through the end, could join. Raw HTML in
  // either text is source the editor saves in another spelling.
  it.each([
    ["restored", "after an edit at the end", true, "Old.", rawHtml.markdown],
  ])("is where one undo of a pending restore with raw HTML in its %s text lands %s, and redo returns", async (_side, _name, edited, undoText, restoredText) => {
    const ref = createRef<MarkdownEditorHandle>();
    const onDirty = vi.fn<(materialize?: () => string) => void>();
    const props = {
      ref,
      value: "Start.",
      onDirty,
      workspaceId: "workspace-1",
      path: "notes/raw.md",
      knownFiles: [],
    };
    const view = render(createElement(MarkdownEditor, props));
    await screen.findByTestId("markdown-editor");
    const editor = mountedEditor();
    if (edited) {
      act(() => {
        editor.commands.insertContentAt(editor.state.doc.content.size, "<p>More.</p>");
      });
      expect(onDirty).toHaveBeenCalledTimes(1);
      onDirty.mockClear();
    }
    // A restore reaches the editor as a replacement, then as a pending undo.
    act(() => ref.current?.replaceMarkdown(restoredText));
    const depth = undoDepth(editor.state);
    const onPendingUndoConsumed = vi.fn();
    const pendingUndo = { token: 1, undoText, restoredText };
    view.rerender(createElement(MarkdownEditor, { ...props, pendingUndo, onPendingUndoConsumed }));
    await waitFor(() => expect(onPendingUndoConsumed).toHaveBeenCalledWith(1));
    const restored = canonical.nodeFromJSON(parseRichdocMarkdown(restoredText)).toJSON();
    expect(editor.getJSON()).toEqual(restored);
    // The same token again is already spent.
    view.rerender(createElement(MarkdownEditor, { ...props, pendingUndo, onPendingUndoConsumed }));
    expect(onPendingUndoConsumed).toHaveBeenCalledTimes(1);
    expect(onDirty).not.toHaveBeenCalled();
    // The restore is one undo step of its own, not part of the edit before it.
    expect(undoDepth(editor.state)).toBe(depth + 1);

    act(() => {
      editor.commands.undo();
    });
    expect(editor.getJSON()).toEqual(
      canonical.nodeFromJSON(parseRichdocMarkdown(undoText)).toJSON(),
    );
    const materialize = onDirty.mock.calls.at(-1)?.[0];
    expect(materialize).toBeTypeOf("function");
    expect(parseRichdocMarkdown(materialize!())).toEqual(parseRichdocMarkdown(undoText));

    act(() => {
      editor.commands.redo();
    });
    expect(editor.getJSON()).toEqual(restored);
  });

  // The collaboration extensions load after the first render. Until then no
  // editor exists to take the pending undo, whatever text the caller holds,
  // and a bound editor leaves it to the shared history through a lost and
  // recovered connection and a rebind to the recovered document.
  it.each([
    ["that matches the restore", "Shared."],
  ])("keeps a pending undo out of a shared document from loading through recovery, with local text %s", async (_name, value) => {
    const first = receivedYDoc("Shared.");
    const recovered = receivedYDoc("Shared.");
    const updates: Uint8Array[] = [];
    const recordUpdate = (update: Uint8Array) => updates.push(update);
    first.on("update", recordUpdate);
    recovered.on("update", recordUpdate);
    const onDirty = vi.fn();
    const onPendingUndoConsumed = vi.fn();
    const props = (
      ydoc: Y.Doc,
      status: "connecting" | "connected" | "disconnected",
      synced: boolean,
    ) => createElement(MarkdownEditor, {
      value,
      onDirty,
      workspaceId: "workspace-1",
      path: "notes/raw.md",
      knownFiles: [],
      collab: { ydoc, status, peerCount: 0, synced },
      pendingUndo: { token: 1, undoText: rawHtml.markdown, restoredText: "Shared." },
      onPendingUndoConsumed,
    });
    const shared = canonical.nodeFromJSON(parseRichdocMarkdown("Shared.")).toJSON();
    const boundEditor = (previous?: Editor) => waitFor(() => {
      const bound = mountedEditor();
      expect(bound).not.toBe(previous);
      expect(
        bound.extensionManager.extensions.some(
          (extension) => extension.name === "collaboration",
        ),
      ).toBe(true);
      expect(bound.getJSON()).toEqual(shared);
      return bound;
    });
    const expectUntouched = (editor: Editor) => {
      expect(editor.getJSON()).toEqual(shared);
      expect(updates).toEqual([]);
      expect(onDirty).not.toHaveBeenCalled();
      expect(onPendingUndoConsumed).not.toHaveBeenCalled();
    };
    const view = render(props(first, "connecting", false));
    try {
      const editor = await boundEditor();
      expect(editor.can().undo()).toBe(false);
      expectUntouched(editor);

      view.rerender(props(first, "disconnected", false));
      expectUntouched(editor);
      view.rerender(props(first, "connected", true));
      expectUntouched(editor);

      view.rerender(props(recovered, "connected", true));
      const rebound = await boundEditor(editor);
      expect(rebound.can().undo()).toBe(false);
      expectUntouched(rebound);
    } finally {
      first.off("update", recordUpdate);
      recovered.off("update", recordUpdate);
      view.unmount();
      first.destroy();
      recovered.destroy();
    }
  });
});

describe("desktop editor schema parity", () => {

  it("carries edge content and shared frontmatter exactly through the wire and both schemas", async () => {
    const doc = receivedYDoc(`${EDGE_FRONTMATTER}${PARITY_BODY}`);
    setFirstColumnWidth(doc, 120);
    const expected = yXmlFragmentToProseMirrorRootNode(
      getDohcYDocBodyFragment(doc),
      canonical,
    ).toJSON() as JSONContent;
    expect([...nodeTypes(expected)]).toEqual(
      expect.arrayContaining([
        "wikilink",
        "inlineAtom",
        "taskList",
        "callout",
        "blockquote",
        "mathInline",
        "mathBlock",
        "image",
        "table",
        "codeBlock",
      ]),
    );
    // Text carrying two marks, whose order in the document is their rank.
    expect(marksOn(expected, "both")?.sort()).toEqual(["bold", "highlight"]);
    expect(marksOn(expected, "italic")?.sort()).toEqual(["highlight", "italic"]);
    expect(marksOn(expected, "linked")?.sort()).toEqual(["highlight", "link"]);
    expect(marksOn(expected, "strong")?.sort()).toEqual(["bold", "link"]);
    // The lone image sits in a paragraph, where the schema allows it, so the
    // writer's document is valid as written and an editor has nothing to fix.
    expect(
      expected.content?.find((block) => block.content?.[0]?.type === "image")?.type,
    ).toBe("paragraph");
    expect(() => canonical.nodeFromJSON(expected).check()).not.toThrow();
    // Yjs reports an update for every change, deletions included, and none for
    // a transaction that changes nothing.
    const updates: Uint8Array[] = [];
    const recordUpdate = (update: Uint8Array) => updates.push(update);
    doc.on("update", recordUpdate);
    const view = render(
      createElement(MarkdownEditor, {
        value: "",
        onDirty: vi.fn(),
        workspaceId: "workspace-1",
        path: "notes/parity.md",
        knownFiles: [],
        collab: { ydoc: doc, status: "connected", peerCount: 0, synced: true },
      }),
    );
    try {
      // The collaboration extensions load before the bound editor mounts. Once
      // it has, it reads the received document as the projection does.
      const editor = await waitFor(() => {
        const bound = mountedEditor();
        expect(
          bound.extensionManager.extensions.some(
            (extension) => extension.name === "collaboration",
          ),
        ).toBe(true);
        expect(bound.getJSON()).toEqual(expected);
        return bound;
      });
      // Opening the document wrote nothing to it.
      expect(updates).toEqual([]);
      doc.off("update", recordUpdate);

      // A document the editor's schema writes reads back unchanged with the
      // projection's schema, after its own trip over the wire.
      const written = new Y.Doc();
      prosemirrorJSONToYXmlFragment(editor.schema, editor.getJSON(), getDohcYDocBodyFragment(written));
      const received = new Y.Doc();
      Y.applyUpdate(received, Y.encodeStateAsUpdate(written));
      expect(
        yXmlFragmentToProseMirrorRootNode(getDohcYDocBodyFragment(received), canonical).toJSON(),
      ).toEqual(expected);
      written.destroy();
      received.destroy();

      // The source view, the editor's copy, and the projector write the same
      // Markdown.
      const projected = projectYDocToMarkdown(doc);
      expect(yDocToMarkdown(doc)).toBe(projected);
      expect(projected.startsWith(EDGE_FRONTMATTER)).toBe(true);
      expect(`${serializeRichdocBody(escapeHighlightMarkdown(editor.getJSON())).trimEnd()}\n`).toBe(
        projected.slice(EDGE_FRONTMATTER.length),
      );

      // The writer's shared types, literal special keys, and native Any
      // bigints are untouched by every step above.
      const frontmatter = doc.getMap<unknown>("frontmatter");
      expect(frontmatter.get("exact")).toBe(9007199254740993n);
      expect(frontmatter.get("nested")).toEqual({ exact: 9007199254740993n });
      const hostile = frontmatter.get("hostile") as Y.Map<unknown>;
      expect(hostile).toBeInstanceOf(Y.Map);
      expect([...hostile.keys()].sort()).toEqual(["__proto__", "constructor"]);
      expect(hostile.get("__proto__")).toBe("nested-value");
      expect(hostile.get("constructor")).toBe("own");
      const literal = frontmatter.get("literal") as Y.Array<Y.Map<unknown>>;
      expect(literal).toBeInstanceOf(Y.Array);
      expect(literal.get(0).get("constructor")).toBe("hostile-constructor");
      // A literal key spelled like the bigint marker keeps one escape `$`.
      expect([...literal.get(1).keys()]).toEqual(["$$dohcBigInt"]);
      expect(literal.get(1).get("$$dohcBigInt")).toBe(9007199254740993n);
      const mixed = frontmatter.get("mixed") as Y.Array<Y.Map<unknown>>;
      expect(mixed).toBeInstanceOf(Y.Array);
      // A Y.Array cannot hold a bigint, so the writer wraps it in the marker map.
      expect(mixed.get(1).get("$dohcBigInt")).toBe(9007199254740993n);
    } finally {
      view.unmount();
      doc.destroy();
    }
  });
});
