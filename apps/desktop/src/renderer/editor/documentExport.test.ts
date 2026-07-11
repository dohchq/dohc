// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildStandaloneDocumentHtml, resolveDocumentTitle } from "./documentExport";

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
    expect(html).toContain('class="dohc-wikilink-pill"');
    expect(html).toContain("Roadmap");
    expect(html).not.toContain('<a href="team/roadmap.md"');
  });

  it("renders a callout as a styled div carrying its type and title", () => {
    expect(html).toContain("dohc-callout");
    expect(html).toContain('data-callout-type="tip"');
    expect(html).toContain('data-callout-title="Remember"');
    expect(html).toContain("Callout body text.");
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
});
