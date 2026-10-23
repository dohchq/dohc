import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

export function isCodeBlockNode(node: { type: { name: string } }): boolean {
  return node.type.name === "code_block" || node.type.name === "codeBlock";
}

export function isCodeBlock(node: { type: { name: string; spec?: { code?: boolean } } } | null): boolean {
  return !!node && (isCodeBlockNode(node) || node.type.spec?.code === true);
}

export function isCodeMark(mark: { type: { name: string; spec?: { code?: boolean } } }): boolean {
  return mark.type.name === "inlineCode" || mark.type.name === "code" || mark.type.spec?.code === true;
}

/** What changed between two documents, found by comparing them rather than
 *  reading the transaction's steps: y-tiptap applies every remote change and
 *  undo as one replacement of the whole document that reuses the unchanged
 *  nodes, so its own mapping would move nothing. Unchanged blocks keep their
 *  node identity, so the comparison is a walk over blocks to the change, not
 *  a read of the note's text. `textblocks` are the blocks of `doc` the change
 *  touched, in document order with their positions, and every textblock
 *  between the first and the last is among them. `mapping` moves every
 *  position outside them. A plugin that decorates text rescans those blocks
 *  and maps the rest. */
export function documentChange(
  before: ProseMirrorNode,
  doc: ProseMirrorNode,
): { textblocks: Array<{ node: ProseMirrorNode; pos: number }>; mapping: Mapping } {
  const start = doc.content.findDiffStart(before.content);
  if (start === null) return { textblocks: [], mapping: new Mapping() };
  const ends = doc.content.findDiffEnd(before.content)!;
  // A repeated character can make the common prefix and suffix overlap; the
  // suffix shrinks until both ends sit at or after the start.
  const overlap = Math.max(0, start - Math.min(ends.a, ends.b));
  const end = ends.a + overlap;
  const endBefore = ends.b + overlap;
  const textblocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  doc.nodesBetween(start, end, (node, pos) => {
    if (!node.isTextblock) return true;
    textblocks.push({ node, pos });
    return false;
  });
  return { textblocks, mapping: new Mapping([new StepMap([start, endBefore - start, end - start])]) };
}

export function normalizeLanguage(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function stopEditorMouseEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

export function isEditableEditor(editor: Editor | null | undefined): boolean {
  return !!editor && editor.isEditable !== false && editor.view.editable !== false;
}

export function ownerWindow(element: Element) {
  return element.ownerDocument.defaultView ?? window;
}

export function shadowHost(view: EditorView): ShadowRoot | HTMLElement {
  const root = view.dom.getRootNode();
  return root instanceof ownerWindow(view.dom).ShadowRoot ? root : view.dom.ownerDocument.body;
}
