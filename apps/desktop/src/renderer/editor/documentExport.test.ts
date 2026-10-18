// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildStandaloneDocumentHtml, resolveDocumentTitle } from "./documentExport";
import { markdownBodyToHtml } from "./import-export";
import { measureParseWork } from "./markdownParseWork";

const FIXTURE_MARKDOWN = `---
title: My Doc
---

# Heading

Some ==highlighted== text and a [[team/roadmap.md|Roadmap]] link.

> [!tip] Remember
> Callout body text.

- [ ] todo one
- [x] done one
`;

describe("resolveDocumentTitle", () => {
  it("prefers the frontmatter title", () => {
    expect(resolveDocumentTitle(FIXTURE_MARKDOWN, "fallback")).toBe("My Doc");
  });

  it("falls back to the caller-provided title when frontmatter has none", () => {
    expect(resolveDocumentTitle("# Just a heading, no frontmatter", "untitled")).toBe(
      "untitled",
    );
  });

  it("falls back when the frontmatter title is blank", () => {
    expect(
      resolveDocumentTitle("---\ntitle: \"\"\n---\nbody", "untitled"),
    ).toBe("untitled");
  });
});

describe("buildStandaloneDocumentHtml", () => {
  const html = buildStandaloneDocumentHtml(FIXTURE_MARKDOWN, "fallback");

  it("is a self-contained document: doctype, inline style, no external assets", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link[^>]+rel=["']stylesheet["']/);
    expect(html).not.toContain("<script");
  });

  it("titles the document from frontmatter, both in <title> and the visible heading", () => {
    expect(html).toContain("<title>My Doc</title>");
    expect(html).toContain('<h1 class="dohc-export-title">My Doc</h1>');
  });

  it("renders the highlight mark", () => {
    expect(html).toMatch(/<mark class="dohc-highlight"[^>]*>highlighted<\/mark>/);
  });

  it("renders a wikilink as a styled, non-interactive pill (never an <a> tag)", () => {
    expect(html).toMatch(/<span class="dohc-wikilink-pill"[^>]*>Roadmap<\/span>/);
    expect(html).not.toContain('<a href="team/roadmap.md"');
  });

  it("styles the wikilink as the reference chip: hairline, 4px radius, inset, body face", () => {
    const rule = /\.dohc-wikilink-pill \{([^}]*)\}/.exec(html)?.[1] ?? "";
    expect(rule).toContain("border: 1px solid var(--line)");
    expect(rule).toContain("border-radius: 4px");
    expect(rule).toContain("background: var(--panel-2)");
    expect(rule).not.toContain("font-family");
  });

  it("renders a callout as a styled div carrying its type and title", () => {
    expect(html).toContain("dohc-callout");
    expect(html).toContain('data-callout-type="tip"');
    expect(html).toContain('data-callout-title="Remember"');
    expect(html).toContain("Callout body text.");
  });

  it("renders a resized table row at its height and hides the annotation", () => {
    const exported = buildStandaloneDocumentHtml(
      "<!-- dohc:table row-heights=1:84 -->\n| A |\n| --- |\n| a |\n",
      "fallback",
    );
    expect(exported).toContain('<tr data-row-height="84" style="height: 84px;">');
    expect(exported).not.toContain("dohc:table");
  });

  it("renders task list items as checkboxes with their checked state", () => {
    expect(html).toContain('data-type="taskItem"');
    expect(html).toMatch(/data-checked="false"[^>]*>[\s\S]*?todo one/);
    expect(html).toMatch(/data-checked="true"[^>]*>[\s\S]*?done one/);
    expect(html).toContain('type="checkbox"');
  });

  it("escapes an untrusted title so it cannot break out of <title> or an attribute", () => {
    const malicious = buildStandaloneDocumentHtml(
      '---\ntitle: "</title><script>evil()</script>"\n---\nbody',
      "fallback",
    );
    expect(malicious).not.toContain("<script>evil()</script>");
    expect(malicious).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  });

  // EXPORT IMAGE CONTRACT (documentExport.ts): an exported document may only
  // reference images at or below its own folder. The editor can serve a
  // workspace-relative src over dohc-file:// because it knows the document's
  // place in the workspace; an export has no such base — it is opened from
  // wherever the user saved it, or (for PDF) from a throwaway temp dir that
  // printToPDF loads over file://. So a `../` src, which is legitimate inside
  // the workspace (global-folder attachments), must not survive into the
  // exported artifact, where it would point at the real filesystem.
  describe("image srcs", () => {
    const bodyOf = (markdown: string) =>
      buildStandaloneDocumentHtml(markdown, "fallback");

    it("keeps a plain relative src (it still resolves beside the exported file)", () => {
      expect(bodyOf("![shot](assets/pic.png)")).toContain(
        'src="assets/pic.png"',
      );
    });

    it("keeps remote http(s) images", () => {
      expect(bodyOf("![remote](https://example.com/x.png)")).toContain(
        'src="https://example.com/x.png"',
      );
    });

    it("emits NO src for a `..` traversal, keeping the alt text", () => {
      const html = bodyOf("![escape](../../outside.png)");
      expect(html).not.toContain("../../outside.png");
      expect(html).not.toContain('src=""');
      expect(html).toContain('alt="escape"');
    });

    it("emits NO src for a single-level `..` (a global-folder attachment src)", () => {
      expect(bodyOf("![att](../assets/pic.png)")).not.toContain(
        "../assets/pic.png",
      );
    });

    it("emits NO src for absolute and protocol-relative paths", () => {
      expect(bodyOf("![abs](/etc/passwd.png)")).not.toContain("/etc/passwd.png");
      expect(bodyOf("![pr](//evil.example.com/x.png)")).not.toContain(
        "//evil.example.com/x.png",
      );
    });

    it("never emits an empty src (which browsers re-request as the page itself)", () => {
      // `data:` is already stripped to '' by the markdown sanitizer; the export
      // pass must drop the attribute rather than leave src="".
      expect(bodyOf("![data](data:image/svg+xml;base64,PHN2Zz4=)")).not.toContain(
        'src=""',
      );
    });
  });

  it("typesets inline math with KaTeX instead of emitting raw TeX", () => {
    const withMath = buildStandaloneDocumentHtml(
      "Euler: $x^2$ done.",
      "fallback",
    );
    // Rendered KaTeX markup, not the literal `$x^2$` source.
    expect(withMath).toContain('class="katex"');
    expect(withMath).not.toContain("$x^2$");
    // The KaTeX layout CSS is inlined (self-contained, no <link>/font url()).
    expect(withMath).toContain(".katex");
    expect(withMath).not.toMatch(/@font-face/);
    expect(withMath).not.toContain("url(");
  });

  it("typesets block math with KaTeX in display mode", () => {
    const withBlock = buildStandaloneDocumentHtml(
      "$$\n\\frac{a}{b}\n$$",
      "fallback",
    );
    expect(withBlock).toContain('class="katex');
    expect(withBlock).toContain("katex-display");
    expect(withBlock).not.toContain("$$");
  });

  it("omits the KaTeX stylesheet when the document has no math", () => {
    // The base fixture carries no math — the large KaTeX CSS must not be shipped.
    expect(html).not.toContain(".katex");
    expect(html).not.toContain("katex-display");
  });

  // The export reads Markdown with the projection's parser, which keeps the
  // lines Tiptap's own reader drops, so the exported page shows what the file
  // holds.
  it("exports raw HTML as the text the file holds, never as elements", () => {
    const exported = buildStandaloneDocumentHtml(
      '<script>alert(1)</script>\n\nText <b onclick="steal()">bold</b> <!-- note -->',
      "fallback",
    );
    expect(exported).not.toContain("<script");
    expect(exported).not.toContain("<b onclick");
    expect(exported).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(exported).toContain("&lt;!-- note --&gt;");
  });

  it("keeps a reference definition and an empty link as visible text", () => {
    const exported = buildStandaloneDocumentHtml(
      'Intro\n\n[docs]: https://e.com\n\nSee [](https://example.com "title").',
      "fallback",
    );
    expect(exported).toContain("[docs]: https://e.com");
    expect(exported).toContain('[](https://example.com "title")');
  });
});

describe("markdownBodyToHtml", () => {
  // Counting newline splits alone missed the block-marker searches, which read
  // the rest of the document for every paragraph.
  it("reads a linear amount of text when rejecting block tokenizers for paragraphs", async () => {
    const measure = (paragraphs: number) =>
      measureParseWork(() => {
        const html = markdownBodyToHtml(Array(paragraphs).fill("Ordinary paragraph.").join("\n\n"));
        expect(html.match(/<p>/g)).toHaveLength(paragraphs);
      });
    const small = await measure(64);
    const large = await measure(128);
    expect(small.search).toBeGreaterThan(0);
    expect(large.split, `newline split characters: ${small.split} -> ${large.split}`).toBeLessThan(small.split * 2.2);
    expect(large.search, `searched characters: ${small.search} -> ${large.search}`).toBeLessThan(small.search * 2.2);
  });
});
