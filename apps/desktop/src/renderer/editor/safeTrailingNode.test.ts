// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { canAppendTrailingNode } from "./safeTrailingNode";

describe("canAppendTrailingNode", () => {
  it("refuses an invalid transient document instead of calling canReplace", () => {
    const editor = new Editor({ extensions: [StarterKit] });
    try {
      const { schema } = editor;
      const invalidDoc = schema.nodes.doc!.create(null, schema.text("inline at root"));

      expect(invalidDoc.type.validContent(invalidDoc.content)).toBe(false);
      expect(canAppendTrailingNode(invalidDoc, schema.nodes.paragraph!)).toBe(false);
    } finally {
      editor.destroy();
    }
  });

  it("allows a valid document ending in a non-paragraph block", () => {
    const editor = new Editor({ extensions: [StarterKit] });
    try {
      const { schema } = editor;
      const doc = schema.nodes.doc!.create(null, schema.nodes.horizontalRule!.create());

      expect(canAppendTrailingNode(doc, schema.nodes.paragraph!)).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
