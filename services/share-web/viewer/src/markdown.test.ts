// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import {
  MARKDOWN_SANITIZE_CONFIG,
  RAW_HTML_STRIP_CONFIG,
  renderSafeMarkdown,
} from "./markdown";

describe("renderSafeMarkdown", () => {
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
    expect(RAW_HTML_STRIP_CONFIG.ALLOWED_TAGS).toEqual([]);
    expect(RAW_HTML_STRIP_CONFIG.ALLOWED_ATTR).toEqual([]);
    expect(container.innerHTML).toContain(html);

    await act(() => root.unmount());
    container.remove();
  });
});
