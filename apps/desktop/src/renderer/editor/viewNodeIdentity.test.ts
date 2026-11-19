// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Node } from "@tiptap/pm/model";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

const blockViews = (editor: Editor) =>
  (editor.view as unknown as { docView: { children: { node: unknown }[] } }).docView.children;

it("holds the current blocks after a keystroke that follows a replacement that only copies them", () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit.configure({ undoRedo: false, trailingNode: false })],
    content: Array.from({ length: 50 }, (_, index) => `<p>Paragraph ${index}</p>`).join(""),
  });
  editors.push(editor);
  const copy = Node.fromJSON(editor.schema, editor.state.doc.toJSON());
  editor.view.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, copy.content));

  editor.view.dispatch(editor.state.tr.insertText("!", editor.state.doc.child(0).nodeSize - 1));
  const typed = editor.state.doc;
  expect(typed.child(0).textContent).toBe("Paragraph 0!");
  expect(blockViews(editor).filter((view, i) => view.node !== typed.child(i))).toHaveLength(0);
});
