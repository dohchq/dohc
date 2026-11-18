import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import { runDocumentProjection } from "./documentProjection";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

it("gives a note's file text with the source its last read recorded", () => {
  const source = "---\npriority: !custom high\n---\n\nText\n";
  const doc = markdownToYDoc(source);
  const meta = doc.getMap("meta");
  meta.set("dohcMarkdownSource", source);
  meta.set("dohcMarkdownSourceSha256", sha(source));
  meta.set("dohcMarkdownSourceProjectionSha256", sha(yDocToMarkdown(doc)));
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  expect(runDocumentProjection({ kind: "file", state })).toEqual({
    markdown: source,
    leftOut: false,
  });
  expect(runDocumentProjection({ kind: "read", state })).not.toBe(source);
});

it("keeps the frontmatter as written after an edit the recorded source no longer proves", () => {
  const doc = markdownToYDoc("---\n# metadata\n\n---\n# Body\n");
  doc.getXmlFragment("body").insert(0, [new Y.XmlElement("paragraph")]);
  const file = runDocumentProjection({ kind: "file", state: Y.encodeStateAsUpdate(doc) });
  doc.destroy();
  expect(file).toMatchObject({ markdown: expect.stringMatching(/^---\n# metadata\n/u) });
});

it("says the text leaves out an edit that waits for one the state lacks", () => {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, "a");
  const first = Y.encodeStateAsUpdate(doc);
  doc.getText("t").insert(1, "b");
  const second = Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(first));
  doc.destroy();
  expect(runDocumentProjection({ kind: "file", state: second })).toMatchObject({ leftOut: true });
  expect(runDocumentProjection({ kind: "file", state: first })).toMatchObject({ leftOut: false });
});
