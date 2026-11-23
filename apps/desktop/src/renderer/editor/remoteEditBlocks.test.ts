// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import * as Y from "yjs";
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Collaboration } from "@tiptap/extension-collaboration";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function paragraphs(count: number): Y.Doc {
  const doc = new Y.Doc();
  doc.getXmlFragment("body").insert(
    0,
    Array.from({ length: count }, (_, index) => {
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(`Paragraph ${index}`)]);
      return paragraph;
    }),
  );
  return doc;
}

it("keeps every block a remote edit did not touch, so the next keystroke compares only what changed", () => {
  const remote = paragraphs(50);
  const local = new Y.Doc();
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false, trailingNode: false }),
      Collaboration.configure({ document: local, field: "body" }),
    ],
  });
  editors.push(editor);
  const before = editor.state.doc;

  const vector = Y.encodeStateVector(remote);
  const target = remote.getXmlFragment("body").get(20) as Y.XmlElement;
  (target.get(0) as Y.XmlText).insert(0, "Edited ");
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, vector));

  const after = editor.state.doc;
  expect(after.child(20).textContent).toBe("Edited Paragraph 20");
  const kept = [...Array(after.childCount).keys()].filter(
    (i) => after.child(i) === before.child(i),
  );
  expect(kept).toEqual([...Array(50).keys()].filter((i) => i !== 20));
  const views = (editor.view as unknown as { docView: { children: { node: unknown }[] } }).docView
    .children;
  expect(views.every((view, i) => view.node === after.child(i))).toBe(true);
});
