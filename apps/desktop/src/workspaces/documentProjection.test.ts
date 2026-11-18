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
  expect(runDocumentProjection({ kind: "file", state })).toBe(source);
  expect(runDocumentProjection({ kind: "read", state })).not.toBe(source);
});
