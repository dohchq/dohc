import { describe, expect, it } from "vitest";
import { parseCollectionSchema } from "./collectionValues";
import {
  defaultInboxCaptureTitle,
  formatInboxRecordMarkdown,
  INBOX_COLLECTION_YAML,
  InboxMoveResult,
  InboxUndoMoveInput,
  isInboxAttachmentPath,
  isInboxRecordPath,
  MAX_INBOX_IMAGE_BYTES,
  safeCodeFence,
  safeInboxSlug,
  sanitizeInboxSingleLine,
  validateInboxUrl,
} from "./inbox";

describe("inbox contracts", () => {
  it("defines a valid Inbox collection.yaml schema", () => {
    const parsed = parseCollectionSchema(INBOX_COLLECTION_YAML);
    expect(parsed.status).toBe("valid");
    expect(parsed.reasons).toEqual([]);
    expect(parsed.schema.name).toBe("Inbox");
    expect(parsed.schema.fields.map((field) => field.name)).toEqual([
      "Title",
      "Status",
      "Source",
      "Kind",
      "Received",
      "URL",
      "Attachment",
      "Filed to",
    ]);
    expect(parsed.schema.views.map((view) => view.name)).toEqual(["Table", "By status"]);
  });

  it("produces safe slugs including Windows reserved device names", () => {
    expect(safeInboxSlug("Hello, World! 2026")).toBe("hello-world-2026");
    expect(safeInboxSlug("CON")).toBe("item-con");
    expect(safeInboxSlug("nul")).toBe("item-nul");
    expect(safeInboxSlug("COM1")).toBe("item-com1");
    expect(safeInboxSlug("   ...   ")).toBe("item");
    expect(safeInboxSlug("Café résumé")).toBe("cafe-resume");
  });

  it("rejects non-http(s) and malformed URLs", () => {
    expect(validateInboxUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(validateInboxUrl("http://example.org")).toBe("http://example.org/");
    expect(() => validateInboxUrl("javascript:alert(1)")).toThrow(/http:\/\/ and https:\/\//);
    expect(() => validateInboxUrl("file:///etc/passwd")).toThrow(/http:\/\/ and https:\/\//);
    expect(() => validateInboxUrl("data:text/html,hi")).toThrow(/http:\/\/ and https:\/\//);
    expect(() => validateInboxUrl("https://example.com/\nEvil: true")).toThrow(/control/);
  });

  it("prevents YAML frontmatter injection in title, id, and URL", () => {
    const markdown = formatInboxRecordMarkdown({
      recordId: "rec-1",
      title: 'Evil: true\n---\n# Injected\nStatus: "Filed"',
      source: "webhook",
      kind: "webhook",
      receivedIso: "2026-11-23T12:00:00Z",
      body: "---\nStatus: Filed\n---\nPayload with ``` triple backticks",
      quarantineBodyAsCodeBlock: true,
      quarantineBodyInfo: "json",
    });

    const frontmatterMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(markdown);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    const body = frontmatterMatch![2]!;
    // Title is serialized as a single YAML string value, never injecting a Status line.
    expect(frontmatter.match(/^Status:/gmu)).toHaveLength(1);
    expect(frontmatter).toContain("Status: New");
    // Body is wrapped in a fence longer than the triple backticks inside it.
    expect(body).toContain("````json\n");
    expect(body).toContain("\n````\n");
  });

  it("computes dynamic code fences longer than any backtick run in content", () => {
    const fenced = safeCodeFence("hello\n``````\nworld", "json");
    expect(fenced.startsWith("```````json\n")).toBe(true);
    expect(fenced.endsWith("\n```````")).toBe(true);
  });

  it("validates Inbox record and attachment paths strictly", () => {
    expect(isInboxRecordPath("Inbox/note.md")).toBe(true);
    expect(isInboxRecordPath("Inbox/collection.yaml")).toBe(false);
    expect(isInboxRecordPath("Inbox/files/note.md")).toBe(false);
    expect(isInboxRecordPath("Notes/note.md")).toBe(false);
    expect(isInboxAttachmentPath("Inbox/files/receipt.pdf")).toBe(true);
    expect(isInboxAttachmentPath("Inbox/files/sub/receipt.pdf")).toBe(true);
    expect(isInboxAttachmentPath("Inbox/files/../secret.txt")).toBe(false);
    expect(isInboxAttachmentPath("Notes/receipt.pdf")).toBe(false);
    expect(sanitizeInboxSingleLine("a\u0000b\nc\td")).toBe("a b c d");
    expect(MAX_INBOX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("escapes parentheses in Markdown URL targets and brackets/backticks in attachment labels", () => {
    const markdown = formatInboxRecordMarkdown({
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Wiki note",
      source: "capture",
      kind: "link",
      receivedIso: "2026-11-23T12:00:00Z",
      url: "https://en.wikipedia.org/wiki/Markdown_(markup)",
      attachments: [
        { path: "Inbox/files/my receipt.txt", isImage: false, label: "my receipt.txt" },
        { path: "Inbox/files/back-2.png", isImage: true, label: "back [2] `v1.png" },
      ],
      body: "Attached both files.",
    });
    expect(markdown).toContain("(https://en.wikipedia.org/wiki/Markdown_%28markup%29)");
    expect(markdown).toContain("[my receipt.txt](files/my%20receipt.txt)");
    expect(markdown).toContain("![back \\[2\\] \\`v1.png](files/back-2.png)");
  });

  it("keeps InboxMoveResult and InboxUndoMoveInput bounds aligned for large batches and long paths", () => {
    const longFolder = `Projects/${"a".repeat(250)}/${"b".repeat(250)}`;
    const attachments = Array.from({ length: 105 }, (_, i) => ({
      fromPath: `Inbox/files/file-${i}.txt`,
      toPath: `${longFolder}/file-${i}.txt`,
    }));
    const payload = {
      fromPath: "Inbox/2026-11-23-bundle.md",
      toPath: `${longFolder}/2026-11-23-bundle.md`,
      attachments,
    };
    expect(payload.toPath.length).toBeGreaterThan(512);
    expect(InboxMoveResult.parse(payload)).toEqual(payload);
    expect(InboxUndoMoveInput.parse(payload)).toEqual(payload);
  });

  it("derives default Inbox capture titles from explicit title, URL, body, or fallback", () => {
    expect(defaultInboxCaptureTitle({ title: "  My\nTitle  ", body: "ignored" })).toBe("My Title");
    expect(defaultInboxCaptureTitle({ url: "https://example.com/docs/intro/" })).toBe(
      "example.com/docs/intro",
    );
    expect(defaultInboxCaptureTitle({ body: "\n\n  First real line\nSecond line" })).toBe(
      "First real line",
    );
    expect(defaultInboxCaptureTitle({})).toBe("Captured item");
    expect(defaultInboxCaptureTitle({ fallback: "Empty note" })).toBe("Empty note");
  });
});
