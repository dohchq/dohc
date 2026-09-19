import {expect, it} from "vitest";
import * as Y from "yjs";
import {markdownToYDoc, yDocToMarkdown, getDohcYDocBodyFragment} from "@dohc/ydoc-projection";
import {replaceLiveText} from "./liveTextEdit";

it("preserves marks, frontmatter and unrelated concurrent edits", () => {
  const left = markdownToYDoc("---\ntitle: Keep\n---\n\nHello **world**.\n\nSecond paragraph.\n"), right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  replaceLiveText(getDohcYDocBodyFragment(left), "world", "friend");
  replaceLiveText(getDohcYDocBodyFragment(right), "Second", "Another");
  const leftUpdate = Y.encodeStateAsUpdate(left), rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate); Y.applyUpdate(right, leftUpdate);
  expect(yDocToMarkdown(left)).toBe(yDocToMarkdown(right));
  expect(yDocToMarkdown(left)).toContain("**friend**"); expect(yDocToMarkdown(left)).toContain("Another paragraph"); expect(yDocToMarkdown(left)).toContain("title: Keep");
  left.destroy(); right.destroy();
});

it.each(["missing", "repeat", ""]) ("refuses stale or ambiguous text without mutation: %s", find => {
  const doc = markdownToYDoc("repeat and repeat"); const before = Y.encodeStateAsUpdate(doc);
  expect(() => replaceLiveText(getDohcYDocBodyFragment(doc), find, "new")).toThrow();
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before); doc.destroy();
});

it("refuses a match across marks before changing the document", () => {
  const doc = markdownToYDoc("Hello **world**."); const before = Y.encodeStateAsUpdate(doc);
  expect(() => replaceLiveText(getDohcYDocBodyFragment(doc), "Hello world", "Hi friend")).toThrow(/formatting/);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before); doc.destroy();
});

it.each(["**bold** plain", "**bold** plain **tail**"])("keeps replacement text unformatted after a bold run: %s", source => {
  const doc = markdownToYDoc(source);
  replaceLiveText(getDohcYDocBodyFragment(doc), " plain", " replacement");
  expect(yDocToMarkdown(doc)).toBe(source.replace(" plain", " replacement"));
  doc.destroy();
});
