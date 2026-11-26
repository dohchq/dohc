import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { markdownToYDoc, yDocToMarkdown } from "@dohc/ydoc-projection";
import {
  admitBodySequenceNotes,
  liveEditRefusal,
} from "@dohc/ydoc-projection/live-journal-validation";
import { replaceLiveText } from "./liveTextEdit";

const replace = (doc: Y.Doc, find: string, replacement: string) =>
  replaceLiveText(doc, find, replacement);

it("preserves marks, frontmatter and unrelated concurrent edits", () => {
  const left = markdownToYDoc("---\ntitle: Keep\n---\n\nHello **world**.\n\nSecond paragraph.\n"),
    right = new Y.Doc();
  Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
  replace(left, "world", "friend");
  replace(right, "Second", "Another");
  const leftUpdate = Y.encodeStateAsUpdate(left),
    rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
  expect(yDocToMarkdown(left)).toBe(yDocToMarkdown(right));
  expect(yDocToMarkdown(left)).toContain("**friend**");
  expect(yDocToMarkdown(left)).toContain("Another paragraph");
  expect(yDocToMarkdown(left)).toContain("title: Keep");
  left.destroy();
  right.destroy();
});

it.each(["missing", "repeat", ""])(
  "refuses stale or ambiguous text without mutation: %s",
  (find) => {
    const doc = markdownToYDoc("repeat and repeat");
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => replace(doc, find, "new")).toThrow();
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  },
);

it("refuses a match across marks before changing the document", () => {
  const doc = markdownToYDoc("Hello **world**.");
  const before = Y.encodeStateAsUpdate(doc);
  expect(() => replace(doc, "Hello world", "Hi friend")).toThrow(/formatting/);
  expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  doc.destroy();
});

it.each(["**bold** plain", "**bold** plain **tail**"])(
  "keeps replacement text unformatted after a bold run: %s",
  (source) => {
    const doc = markdownToYDoc(source);
    replace(doc, " plain", " replacement");
    expect(yDocToMarkdown(doc)).toBe(`${source.replace(" plain", " replacement")}\n`);
    doc.destroy();
  },
);

describe("a format-2 note", () => {
  beforeAll(() => admitBodySequenceNotes(true));
  afterAll(() => admitBodySequenceNotes(false));

  const note = (markdown: string) => markdownToYDoc(markdown, { bodySequence: true });
  /** Replaces in the note, and checks each change it makes as the relay checks a page's edit. */
  function replaced(markdown: string, find: string, replacement: string) {
    const doc = note(markdown);
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    replace(doc, find, replacement);
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect(liveEditRefusal(copy, update)).toBeUndefined();
      Y.applyUpdate(copy, update);
    }
    const markdownAfter = yDocToMarkdown(doc);
    expect(yDocToMarkdown(copy)).toBe(markdownAfter);
    doc.destroy();
    copy.destroy();
    return markdownAfter;
  }
  function refused(markdown: string, find: string, replacement: string, words: RegExp) {
    const doc = note(markdown);
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => replace(doc, find, replacement)).toThrow(words);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    doc.destroy();
  }

  it.each([
    [
      "plain text",
      "Hello world.\n\nSecond line.",
      "world",
      "friend",
      "Hello friend.\n\nSecond line.\n",
    ],
    ["bold text", "Hello **world**.", "world", "friend", "Hello **friend**.\n"],
    ["text after an image", "See ![a](a.png) here.", " here", " there", "See ![a](a.png) there.\n"],
    ["text taken away", "Hello cruel world.", " cruel", "", "Hello world.\n"],
  ])("replaces %s and keeps its marks", (_, markdown, find, replacement, expected) => {
    expect(replaced(markdown, find, replacement)).toBe(expected);
  });

  it("replaces text in a code block", () => {
    const after = replaced("~~~\nlet a = 1\n~~~", "a = 1", "b = 2");
    expect(after).toContain("let b = 2\n");
    expect(after).not.toContain("a = 1");
  });

  it("replaces text that stands before the note's first boundary", () => {
    const doc = note("Second line.");
    doc.transact(() => doc.getText("sequence").insert(0, "First "));
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    const updates: Uint8Array[] = [];
    doc.on("update", (update: Uint8Array) => updates.push(update));
    replace(doc, "First", "Opening");
    for (const update of updates) {
      expect(liveEditRefusal(copy, update)).toBeUndefined();
      Y.applyUpdate(copy, update);
    }
    expect(yDocToMarkdown(doc)).toContain("Opening ");
    expect(yDocToMarkdown(doc)).not.toContain("First");
    doc.destroy();
    copy.destroy();
  });

  it.each([
    ["a match across marks", "Hello **world**.", "Hello world", /formatting/],
    ["a match across an image", "See ![a](a.png) here.", "See \uFFFC here", /formatting/],
    ["an ambiguous match", "Hello **world**.\n\nHello world.", "world", /exactly once/],
    ["a missing match", "Hello world.", "friend", /exactly once/],
    ["half a letter", "Smile \u{1F600} now.", "\uDE00", /surrogate/],
  ])("refuses %s without changing the note", (_, markdown, find, words) => {
    refused(markdown, find, "new", words);
  });
});
