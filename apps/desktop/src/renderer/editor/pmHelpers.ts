import type { Editor } from "@tiptap/core";
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
