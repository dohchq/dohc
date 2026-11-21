import { createHash } from "node:crypto";
import { LIVE_MARKDOWN_MAX_BYTES } from "@dohc/live-session-contract/limits";
import { expect, it, vi } from "vitest";
import * as Y from "yjs";
import commonmark from "./fixtures/commonmark-edit-meaning.json";
import { markdownToYDoc, yDocToMarkdown } from "./import-export.js";
import {
  isLossyDocument,
  isLossyDocumentState,
  isLossyMarkdown,
  isLossyMarkdownCached,
  lossyNoteRefusal,
  sameMarkdownMeaning,
  unreadNoteRefusal,
  witnessKeepsMeaning,
} from "./lossy-markdown.js";

vi.mock("./import-export.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./import-export.js")>();
  return { ...actual, markdownToYDoc: vi.fn(actual.markdownToYDoc) };
});

// The 646 CommonMark 0.31.2 examples the desktop can open, each with the
// Markdown dohc writes for it after an edit. Regenerate it when the reader or
// the writer learns a form.
it("flags every CommonMark example whose meaning an edit would change", () => {
  const changed = commonmark.examples.filter(
    (example) => !sameMarkdownMeaning(example.markdown, example.written),
  );
  const misses = changed
    .filter((example) => !isLossyMarkdown(example.markdown))
    .map((example) => example.example);
  const extra = commonmark.examples
    .filter((example) => !changed.includes(example) && isLossyMarkdown(example.markdown))
    .map((example) => example.example);
  expect(commonmark.examples).toHaveLength(646);
  expect(changed).toHaveLength(125);
  expect(misses).toEqual([]);
  // Example 353, `` `foo`bar` ``, differs only in a code span marked reads
  // two ways. Flagging more would open ordinary notes read-only.
  expect(extra.length).toBeLessThanOrEqual(1);
});

const lossySource = "1. Run this:\n\n       pnpm install\n\n2. Done\n";

it.each([
  ["an image with a root-relative path", "![logo](/docs/logo.png)\n"],
  ["code indented under a list item", lossySource],
  ["a comment that never closes", "<!-- draft\n\nNotes\n"],
  ["preformatted text that never closes", "<pre>\nfoo\n"],
])("flags %s", (_, markdown) => {
  expect(isLossyMarkdown(markdown)).toBe(true);
});

it.each([
  ["a raw HTML block", "# Notes\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n"],
  ["inline raw HTML", "Press <kbd>Ctrl</kbd>+<kbd>K</kbd>.\n"],
  [
    "a link through a reference and its definition",
    'See [the docs][docs].\n\n[docs]: https://example.com/docs "Docs"\n',
  ],
  ["a link on a picture", "[![build](https://img.example/b.svg)](https://ci.example/run)\n"],
])("does not flag %s, which dohc writes as the file spells it", (_, markdown) => {
  expect(yDocToMarkdown(markdownToYDoc(markdown))).toBe(markdown);
  expect(isLossyMarkdown(markdown)).toBe(false);
});

it("does not flag a note dohc wrote, with or without its final newline", () => {
  const written = yDocToMarkdown(
    markdownToYDoc("# Plan\n\n- [ ] Book flights\n- [x] Pick dates\n\n**Budget:** $1,200\n"),
  );
  expect(isLossyMarkdown(written)).toBe(false);
  expect(isLossyMarkdown(`${written}\n`)).toBe(false);
  expect(isLossyMarkdown(`${written.replaceAll("\n", "\r\n")}\r\n`)).toBe(false);
});

it("does not flag a respelling that keeps the meaning", () => {
  expect(isLossyMarkdown("Title\n=====\n\n* one\n* two\n\n_emphasis_\n")).toBe(false);
});

it("does not flag spaces after the last words of a note", () => {
  expect(isLossyMarkdown("# Plan\n\nLast words \n")).toBe(false);
  expect(isLossyMarkdown("# Plan \n")).toBe(false);
});

it("flags a note the editor cannot import", () => {
  expect(isLossyMarkdown("- a\n - b\n  - c\n   - d\n    - e\n")).toBe(true);
});

it("remembers a verdict by the digest it was given", () => {
  expect(isLossyMarkdownCached("digest-a", lossySource)).toBe(true);
  expect(isLossyMarkdownCached("digest-a", "Plain text.\n")).toBe(true);
  expect(isLossyMarkdownCached("digest-b", "Plain text.\n")).toBe(false);
});

it("names the note and the way forward when it refuses", () => {
  expect(lossyNoteRefusal("notes/readme.md")).toBe(
    "dohc can't change notes/readme.md without also changing parts it can't show. Edit the file directly instead.",
  );
});

// A note's live document as the desktop seeds it: the import, and a witness
// of the file's bytes when they differ from its canonical Markdown.
function seeded(source: string): Y.Doc {
  const doc = markdownToYDoc(source);
  const canonical = yDocToMarkdown(doc);
  if (canonical !== source) {
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    doc.getMap("meta").set("dohcMarkdownSource", source);
    doc.getMap("meta").set("dohcMarkdownSourceSha256", sha(source));
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", sha(canonical));
  }
  return doc;
}

it("judges a live note by the file its witness records", () => {
  expect(isLossyDocument(seeded(lossySource), null)).toBe(true);
  expect(isLossyDocument(seeded("Title\n=====\n\n* one\n"), null)).toBe(false);
  expect(isLossyDocument(seeded("# Plan\n\nText."), null)).toBe(false);
});

it("still needs consent after an edit while the head holds the unsafe source", () => {
  const doc = seeded(lossySource);
  const source = doc.getMap("meta").get("dohcMarkdownSourceSha256") as string;
  expect(isLossyDocument(doc, source)).toBe(true);
  doc.getMap("frontmatter").set("status", "done");
  expect(isLossyDocument(doc, source)).toBe(true);
  expect(isLossyDocument(doc, null)).toBe(true);
  expect(isLossyDocument(doc, "converted-head")).toBe(false);
});

it("judges a session state as its live note", () => {
  const lossy = seeded(lossySource);
  const plain = seeded("# Plan\n\nText.");
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true);
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(plain), null)).toBe(false);
});

it("settles a session by its witness when the source keeps its meaning, edited or not", () => {
  const respelled = seeded("Title\n=====\n\n* one\n");
  expect(witnessKeepsMeaning(respelled)).toBe(true);
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(respelled), null)).toBe(false);
  respelled.getMap("frontmatter").set("status", "done");
  expect(witnessKeepsMeaning(respelled)).toBe(true);
  expect(witnessKeepsMeaning(seeded("# Plan\n\nText."))).toBe(true);
});

it("keeps a note editable after an update changes how dohc writes it, while its file keeps its meaning", () => {
  // A hand-padded table, first opened by a build whose writer padded each
  // column wider than today's writer does.
  const source = "| name |\n|---|\n| snake_case |\n";
  const today = yDocToMarkdown(markdownToYDoc(source));
  const older = today.replaceAll(" |", "    |");
  expect(older).not.toBe(today);
  expect(sameMarkdownMeaning(source, older)).toBe(true);
  const doc = seeded(source);
  const meta = doc.getMap("meta");
  meta.set("dohcMarkdownSourceProjectionSha256", createHash("sha256").update(older).digest("hex"));

  expect(witnessKeepsMeaning(doc)).toBe(true);
  expect(isLossyDocument(doc, meta.get("dohcMarkdownSourceSha256") as string)).toBe(false);
  // The meaning check still holds a source today's writer would change.
  const lossy = seeded(lossySource);
  lossy.getMap("meta").set("dohcMarkdownSourceProjectionSha256", "0".repeat(64));
  expect(witnessKeepsMeaning(lossy)).toBe(false);
});

it("holds a note an older build read before dohc kept its raw HTML as the file spells it", () => {
  const source = "* one\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n";
  const doc = seeded(source);
  const meta = doc.getMap("meta");
  expect(witnessKeepsMeaning(doc)).toBe(true);
  const older =
    "- one\n\n&lt;details&gt;\n&lt;summary&gt;More&lt;/summary&gt;\n\nHidden.\n\n&lt;/details&gt;\n";
  meta.set("dohcMarkdownSourceProjectionSha256", createHash("sha256").update(older).digest("hex"));
  expect(witnessKeepsMeaning(doc)).toBe(false);
  expect(isLossyDocument(doc, meta.get("dohcMarkdownSourceSha256") as string)).toBe(true);
});

it("checks the whole session when its witness records a lossy source", () => {
  const lossy = seeded(lossySource);
  expect(witnessKeepsMeaning(lossy)).toBe(false);
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true);
  lossy.getMap("frontmatter").set("status", "done");
  expect(isLossyDocumentState(Y.encodeStateAsUpdate(lossy), null)).toBe(true);
  const reopened = new Y.Doc();
  Y.applyUpdate(reopened, Y.encodeStateAsUpdate(lossy));
  expect(isLossyDocument(reopened, null)).toBe(true);
  expect(isLossyDocument(reopened, "converted-head")).toBe(false);
  const partial = seeded("Title\n=====\n\n* one\n");
  partial.getMap("meta").delete("dohcMarkdownSourceProjectionSha256");
  expect(witnessKeepsMeaning(partial)).toBe(false);
  // As the engine reads a witness, a projection must be a digest.
  for (const malformed of ["", "invalid", "g".repeat(64), "A".repeat(64)]) {
    const doc = seeded("Title\n=====\n\n* one\n");
    doc.getMap("meta").set("dohcMarkdownSourceProjectionSha256", malformed);
    expect(witnessKeepsMeaning(doc)).toBe(false);
  }
  const mismatched = seeded("Title\n=====\n\n* one\n");
  mismatched.getMap("meta").set("dohcMarkdownSource", "Title\n=====\n\n* two\n");
  expect(witnessKeepsMeaning(mismatched)).toBe(false);
});

it("checks a note up to the engine's size limit, and holds a larger one without importing it", () => {
  // A respelled heading keeps its meaning, so only the size can hold it.
  const respelled = "Title\n=====\n\n";
  const atLimit = respelled + "a".repeat(LIVE_MARKDOWN_MAX_BYTES - respelled.length);
  const overLimit = `${atLimit}a`;
  const multibyte = respelled + "é".repeat((LIVE_MARKDOWN_MAX_BYTES + 1 - respelled.length) / 2);
  expect(multibyte.length).toBeLessThan(LIVE_MARKDOWN_MAX_BYTES);
  expect(new TextEncoder().encode(multibyte).length).toBe(LIVE_MARKDOWN_MAX_BYTES + 1);

  expect(isLossyMarkdown(atLimit)).toBe(false);
  expect(witnessKeepsMeaning(seeded(atLimit))).toBe(true);
  for (const oversized of [overLimit, multibyte]) {
    const doc = seeded(oversized);
    vi.mocked(markdownToYDoc).mockClear();
    expect(isLossyMarkdown(oversized)).toBe(true);
    expect(witnessKeepsMeaning(doc)).toBe(false);
    expect(markdownToYDoc).not.toHaveBeenCalled();
  }
});

it("names the note when it could not be read to check", () => {
  expect(unreadNoteRefusal("notes/readme.md")).toBe(
    "dohc couldn't read notes/readme.md to check it, so nothing changed. Try again.",
  );
});
