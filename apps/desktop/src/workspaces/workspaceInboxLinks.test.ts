import { describe, expect, it } from "vitest";
import { formatInboxRecordMarkdown } from "@dohc/workspace-contracts/inbox";
import {
  extractInboxAttachmentLinks,
  rewriteInboxMovedNoteMarkdown,
  rewriteInboxRestoredNoteMarkdown,
} from "./workspaceInboxLinks";

describe("workspaceInboxLinks (CommonMark AST)", () => {
  it("extracts and rewrites multi-attachment links including escaped brackets, backticks, titles, angle brackets, and multiline labels", () => {
    const markdown = formatInboxRecordMarkdown({
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Complex links",
      source: "capture",
      kind: "file",
      receivedIso: "2026-11-23T12:00:00Z",
      attachments: [
        { path: "Inbox/files/my receipt.txt", isImage: false, label: "my receipt.txt" },
        { path: "Inbox/files/back-2.png", isImage: true, label: "back [2].png" },
        { path: "Inbox/files/notes.pdf", isImage: false, label: "notes `v1.pdf" },
      ],
      body: [
        '[line 1\nline 2](files/multiline.pdf "Quarterly report")',
        "",
        "![spaced](<files/with space.png>)",
        "",
        "[ref link][r1]",
        "",
        "[r1]: files/referenced.txt",
      ].join("\n"),
    });

    expect(extractInboxAttachmentLinks(markdown)).toEqual([
      "Inbox/files/my receipt.txt",
      "Inbox/files/back-2.png",
      "Inbox/files/notes.pdf",
      "Inbox/files/multiline.pdf",
      "Inbox/files/with space.png",
      "Inbox/files/referenced.txt",
    ]);

    const moves = [
      { fromPath: "Inbox/files/my receipt.txt", toPath: "Projects/my receipt.txt" },
      { fromPath: "Inbox/files/back-2.png", toPath: "Projects/back-2-renamed.png" },
      { fromPath: "Inbox/files/notes.pdf", toPath: "Projects/notes.pdf" },
      { fromPath: "Inbox/files/multiline.pdf", toPath: "Projects/multiline.pdf" },
      { fromPath: "Inbox/files/with space.png", toPath: "Projects/with space.png" },
      { fromPath: "Inbox/files/referenced.txt", toPath: "Projects/referenced.txt" },
    ];

    const moved = rewriteInboxMovedNoteMarkdown(markdown, moves);
    expect(moved).toContain("Attachment: Projects/my receipt.txt");
    expect(moved).toContain("[my receipt.txt](my%20receipt.txt)");
    expect(moved).toContain("![back \\[2\\].png](back-2-renamed.png)");
    expect(moved).toContain("[notes \\`v1.pdf](notes.pdf)");
    expect(moved).toContain('[line 1\nline 2](multiline.pdf "Quarterly report")');
    expect(moved).toContain("![spaced](with%20space.png)");
    expect(moved).toContain("[r1]: referenced.txt");

    const editedAfterMove = `${moved}\nFollow-up edit after filing.\n`;
    const restored = rewriteInboxRestoredNoteMarkdown(editedAfterMove, moves);
    expect(restored).toContain("Attachment: Inbox/files/my receipt.txt");
    expect(restored).toContain("[my receipt.txt](files/my%20receipt.txt)");
    expect(restored).toContain("![back \\[2\\].png](files/back-2.png)");
    expect(restored).toContain('[line 1\nline 2](files/multiline.pdf "Quarterly report")');
    expect(restored).toContain("![spaced](files/with%20space.png)");
    expect(restored).toContain("[r1]: files/referenced.txt");
    expect(restored).toContain("Follow-up edit after filing.");
  });

  it("ignores attachment-like text inside multiline inline code, blockquoted fences, indented code blocks, and fenced blocks", () => {
    const markdown = [
      "---",
      "id: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      "Title: Code examples",
      "Status: New",
      "---",
      "",
      "Example `sample",
      "[example](files/multiline-code.png)`",
      "",
      "> ~~~md",
      "> ![quoted fence](files/quoted-fence.png)",
      "> ~~~",
      "",
      "    [indented code](files/indented.png)",
      "",
      "```md",
      "[fenced](files/fenced.png)",
      "```",
      "",
      "Real attachment: ![real](files/real.png)",
      "",
    ].join("\n");

    expect(extractInboxAttachmentLinks(markdown)).toEqual(["Inbox/files/real.png"]);

    const moved = rewriteInboxMovedNoteMarkdown(markdown, [
      { fromPath: "Inbox/files/multiline-code.png", toPath: "Projects/multiline-code.png" },
      { fromPath: "Inbox/files/quoted-fence.png", toPath: "Projects/quoted-fence.png" },
      { fromPath: "Inbox/files/indented.png", toPath: "Projects/indented.png" },
      { fromPath: "Inbox/files/fenced.png", toPath: "Projects/fenced.png" },
      { fromPath: "Inbox/files/real.png", toPath: "Projects/real.png" },
    ]);
    expect(moved).toContain("[example](files/multiline-code.png)`");
    expect(moved).toContain("> ![quoted fence](files/quoted-fence.png)");
    expect(moved).toContain("    [indented code](files/indented.png)");
    expect(moved).toContain("[fenced](files/fenced.png)");
    expect(moved).toContain("Real attachment: ![real](real.png)");
  });

  it("handles blockquoted multiline definitions, blockquoted multiline titles, empty titles, and unbalanced parens in filenames", () => {
    const markdown = [
      "---",
      "id: rec_cccccccccccccccccccccccccc",
      "Title: Edge cases",
      "Status: New",
      "---",
      "",
      "> [r]:",
      ">   files/receipt.pdf",
      ">",
      "> [r]",
      "",
      "> [quoted title](files/quoted.png",
      '>   "t")',
      "",
      '[empty title](files/empty.png "")',
      "",
      "[unbalanced](<files/receipt(1.pdf>)",
      "",
      "[entity inline](files/A&amp;B.pdf)",
      "",
      "[entity-def]: files/A&amp;B.pdf",
      "",
      "> [tight quote](",
      ">files/tight.png",
      '>"t")',
      "",
      `[deep-parens]: files/${"(".repeat(33)}a${")".repeat(33)}.pdf`,
      "",
    ].join("\n");

    const deepParensName = `${"(".repeat(33)}a${")".repeat(33)}.pdf`;
    expect(extractInboxAttachmentLinks(markdown)).toEqual([
      "Inbox/files/receipt.pdf",
      "Inbox/files/quoted.png",
      "Inbox/files/empty.png",
      "Inbox/files/receipt(1.pdf",
      "Inbox/files/A&B.pdf",
      "Inbox/files/tight.png",
      `Inbox/files/${deepParensName}`,
    ]);

    const moves = [
      { fromPath: "Inbox/files/receipt.pdf", toPath: "Projects/receipt.pdf" },
      { fromPath: "Inbox/files/quoted.png", toPath: "Projects/quoted.png" },
      { fromPath: "Inbox/files/empty.png", toPath: "Projects/empty.png" },
      { fromPath: "Inbox/files/receipt(1.pdf", toPath: "Projects/receipt(1.pdf" },
      { fromPath: "Inbox/files/A&B.pdf", toPath: "Projects/A&B.pdf" },
      { fromPath: "Inbox/files/tight.png", toPath: "Projects/tight.png" },
      { fromPath: `Inbox/files/${deepParensName}`, toPath: `Projects/${deepParensName}` },
    ];

    const moved = rewriteInboxMovedNoteMarkdown(markdown, moves);
    expect(moved).toContain("> [r]:\n>   receipt.pdf");
    expect(moved).toContain('> [quoted title](quoted.png\n>   "t")');
    expect(moved).toContain('[empty title](empty.png "")');
    expect(moved).toContain("[unbalanced](receipt%281.pdf)");
    expect(moved).toContain("[entity inline](A%26B.pdf)");
    expect(moved).toContain("[entity-def]: A%26B.pdf");
    expect(moved).toContain('> [tight quote](\n>tight.png\n>"t")');
    const deepParensEncoded = `${"%28".repeat(33)}a${"%29".repeat(33)}.pdf`;
    expect(moved).toContain(`[deep-parens]: ${deepParensEncoded}`);

    const restored = rewriteInboxRestoredNoteMarkdown(moved, moves);
    expect(restored).toContain("> [r]:\n>   files/receipt.pdf");
    expect(restored).toContain('> [quoted title](files/quoted.png\n>   "t")');
    expect(restored).toContain('[empty title](files/empty.png "")');
    expect(restored).toContain("[unbalanced](files/receipt%281.pdf)");
    expect(restored).toContain("[entity inline](files/A%26B.pdf)");
    expect(restored).toContain("[entity-def]: files/A%26B.pdf");
    expect(restored).toContain('> [tight quote](\n>files/tight.png\n>"t")');
    expect(restored).toContain(`[deep-parens]: files/${deepParensEncoded}`);
    expect(extractInboxAttachmentLinks(restored)).toEqual([
      "Inbox/files/receipt.pdf",
      "Inbox/files/quoted.png",
      "Inbox/files/empty.png",
      "Inbox/files/receipt(1.pdf",
      "Inbox/files/A&B.pdf",
      "Inbox/files/tight.png",
      `Inbox/files/${deepParensName}`,
    ]);
  });

  it("rebases ordinary relative Markdown links and images across folder depths and restores them on Undo", () => {
    const markdown = [
      "---",
      "id: rec_dddddddddddddddddddddddddd",
      "Title: Relative links",
      "Status: New",
      "---",
      "",
      "See [Brief](../Docs/brief.md#budget) and ![Logo](../assets/logo.png).",
      "Also [Sibling](sibling.md) and [External](https://example.com) and [Top](#top) and [Outside](../../escape.md).",
      "",
      "[ref-brief]: ../Docs/spec.md?v=1",
      "",
    ].join("\n");

    const movedToRoot = rewriteInboxMovedNoteMarkdown(markdown, [], {
      fromPath: "Inbox/2026-11-23-rel.md",
      toPath: "2026-11-23-rel.md",
    });
    expect(movedToRoot).toContain(
      "See [Brief](Docs/brief.md#budget) and ![Logo](assets/logo.png).",
    );
    expect(movedToRoot).toContain(
      "Also [Sibling](Inbox/sibling.md) and [External](https://example.com) and [Top](#top) and [Outside](../escape.md).",
    );
    expect(movedToRoot).toContain("[ref-brief]: Docs/spec.md?v=1");

    const restoredFromRoot = rewriteInboxRestoredNoteMarkdown(movedToRoot, [], {
      fromPath: "Inbox/2026-11-23-rel.md",
      toPath: "2026-11-23-rel.md",
    });
    expect(restoredFromRoot).toBe(markdown);

    const movedDeep = rewriteInboxMovedNoteMarkdown(markdown, [], {
      fromPath: "Inbox/2026-11-23-rel.md",
      toPath: "Projects/Q4/2026-11-23-rel.md",
    });
    expect(movedDeep).toContain(
      "See [Brief](../../Docs/brief.md#budget) and ![Logo](../../assets/logo.png).",
    );
    expect(movedDeep).toContain(
      "Also [Sibling](../../Inbox/sibling.md) and [External](https://example.com) and [Top](#top) and [Outside](../../../escape.md).",
    );
    expect(movedDeep).toContain("[ref-brief]: ../../Docs/spec.md?v=1");

    const restoredFromDeep = rewriteInboxRestoredNoteMarkdown(movedDeep, [], {
      fromPath: "Inbox/2026-11-23-rel.md",
      toPath: "Projects/Q4/2026-11-23-rel.md",
    });
    expect(restoredFromDeep).toBe(markdown);
  });
});
