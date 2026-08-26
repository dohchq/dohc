// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { MARKDOWN_SANITIZE_CONFIG, renderSafeMarkdown } from "./markdown";

describe("renderSafeMarkdown", () => {
  it("preserves tag-shaped text in fenced code blocks", () => {
    const html = renderSafeMarkdown("```html\n<div>hello</div>\n```");

    expect(html).toContain("<pre><code>");
    expect(html).toContain("&lt;div&gt;hello&lt;/div&gt;");
  });

  it("preserves tag-shaped text in inline code spans", () => {
    const html = renderSafeMarkdown("`<b>x</b>`");

    expect(html).toContain("<code>&lt;b&gt;x&lt;/b&gt;</code>");
  });

  it("escapes raw HTML so event handlers never become attributes", () => {
    const html = renderSafeMarkdown(
      'Before <span onmouseover="window.__shareAttack = true">click</span> after.',
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(html).toContain(
      '&lt;span onmouseover="window.__shareAttack = true"&gt;click&lt;/span&gt;',
    );
    expect(template.content.querySelector("span")).toBeNull();
    expect(template.content.querySelector("[onmouseover]")).toBeNull();
  });

  it("renders hostile Markdown inert in the viewer component", async () => {
    const markdown = `
# Shared note

<script>window.__shareAttack = true</script>
<img src=x onerror="window.__shareAttack = true">
<iframe srcdoc="<script>window.__shareAttack = true</script>"></iframe>
<object data="data:text/html,attack"></object>
[run](javascript:alert(document.domain))
![remote](https://attacker.example/tracker.png)
![inline](data:image/svg+xml,<svg onload=alert(1) />)
![safe](/api/view/blob/${"a".repeat(64)})
`;
    const html = renderSafeMarkdown(markdown);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(() => {
      root.render(createElement(MarkdownContent, { markdown }));
    });

    expect(container.querySelector("script, iframe, object")).toBeNull();
    expect(container.querySelector("[onerror], [onload]")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('img[src^="http"]')).toBeNull();
    expect(container.querySelector('img[src^="data:"]')).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      `/api/view/blob/${"a".repeat(64)}`,
    );
    expect(MARKDOWN_SANITIZE_CONFIG.FORBID_TAGS).toEqual(
      expect.arrayContaining(["script", "iframe", "object", "svg"]),
    );
    expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_ATTR).not.toContain("onerror");
    expect(container.innerHTML).toContain(html);

    await act(() => root.unmount());
    container.remove();
  });

  it("keeps ordinary text and escapes forbidden elements", () => {
    const html = renderSafeMarkdown(`
Plain paragraph text.

- a list item

<script>leakedScriptBody</script>

<style>leakedStyleBody</style>
`);
    const template = document.createElement("template");
    template.innerHTML = html;

    // A custom ALLOWED_TAGS list must name "#text": without it, KEEP_CONTENT:false
    // strips every text node and the viewer renders empty elements.
    expect(html).toContain("Plain paragraph text.");
    expect(html).toContain("a list item");
    expect(html).toContain("&lt;script&gt;leakedScriptBody&lt;/script&gt;");
    expect(html).toContain("&lt;style&gt;leakedStyleBody&lt;/style&gt;");
    expect(template.content.querySelector("script, style")).toBeNull();
    expect(MARKDOWN_SANITIZE_CONFIG.ALLOWED_TAGS).toContain("#text");
    expect(MARKDOWN_SANITIZE_CONFIG.KEEP_CONTENT).toBe(false);
  });
});
