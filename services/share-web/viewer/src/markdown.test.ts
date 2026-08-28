// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { MARKDOWN_SANITIZE_CONFIG, renderSafeMarkdown } from "./markdown";
import { resolveSharedImage, type SharedFile } from "./model";

function trackImageSourceRequests(image: HTMLImageElement): {
  sources: string[];
  times: number[];
} {
  let source = image.getAttribute("src") ?? "";
  const sources = [source];
  const times = [Date.now()];
  Object.defineProperty(image, "src", {
    configurable: true,
    get: () => source,
    set: (value: string) => {
      source = value;
      image.setAttribute("src", value);
      sources.push(value);
      times.push(Date.now());
    },
  });
  return { sources, times };
}

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

  it("rewrites an authored blob session to the current viewer session", () => {
    const blobSha256 = "a".repeat(64);
    const authoredSession = "ForeignSes01";
    const currentSession = "CurrentSes01";
    const files = new Map<string, SharedFile>();
    const html = renderSafeMarkdown(
      `![private](/api/view/blob/${blobSha256}?session=${authoredSession})`,
      (href) => resolveSharedImage(href, "note.md", files, currentSession),
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelector("img")?.getAttribute("src")).toBe(
      `/api/view/blob/${blobSha256}?session=${currentSession}`,
    );
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

describe("MarkdownContent link navigation", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("handles a ctrl-click on a resolved shared file but passes through an unresolved link", async () => {
    const navigatedPaths: string[] = [];
    await act(() => {
      root?.render(createElement(MarkdownContent, {
        markdown: [
          "[Shared file](/docs/next.md)",
          "[Unresolved](#section)",
        ].join("\n\n"),
        resolveLink: (href: string) => href === "/docs/next.md" ? "docs/next.md" : null,
        onNavigate: (path: string) => navigatedPaths.push(path),
      }));
    });

    const sharedFileLink = [...container.querySelectorAll("a")]
      .find((anchor) => anchor.textContent === "Shared file");
    const unresolvedLink = [...container.querySelectorAll("a")]
      .find((anchor) => anchor.textContent === "Unresolved");
    if (!sharedFileLink || !unresolvedLink) throw new Error("links did not render");

    let followedSharedFileLink = true;
    act(() => {
      followedSharedFileLink = sharedFileLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      );
    });

    expect(followedSharedFileLink).toBe(false);
    expect(navigatedPaths).toEqual(["docs/next.md"]);

    let followedUnresolvedLink = false;
    act(() => {
      followedUnresolvedLink = unresolvedLink.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      );
    });

    expect(followedUnresolvedLink).toBe(true);
    expect(navigatedPaths).toEqual(["docs/next.md"]);
  });
});

describe("MarkdownContent image retries", () => {
  const imageSource = `/api/view/blob/${"a".repeat(64)}`;
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  async function renderImage(): Promise<HTMLImageElement> {
    await act(() => {
      root?.render(createElement(MarkdownContent, {
        markdown: `![Shared image](${imageSource})`,
      }));
    });
    const image = container.querySelector("img");
    if (!(image instanceof HTMLImageElement)) throw new Error("image did not render");
    return image;
  }

  it("retries a failed image after the initial delay and stops after it loads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const image = await renderImage();
    const requests = trackImageSourceRequests(image);

    act(() => image.dispatchEvent(new Event("error")));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(requests.sources).toEqual([imageSource]);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(requests.sources).toEqual([imageSource, imageSource]);
    expect(requests.times).toEqual([0, 1_000]);

    act(() => image.dispatchEvent(new Event("load")));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(requests.sources).toEqual([imageSource, imageSource]);
  });

  it("gives up after the two-minute retry budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const image = await renderImage();
    const requests = trackImageSourceRequests(image);
    const retryDelays = [
      1_000,
      2_000,
      4_000,
      8_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
      15_000,
    ];

    act(() => image.dispatchEvent(new Event("error")));
    for (const delay of retryDelays) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      act(() => image.dispatchEvent(new Event("error")));
    }

    expect(requests.times).toEqual([
      0,
      1_000,
      3_000,
      7_000,
      15_000,
      30_000,
      45_000,
      60_000,
      75_000,
      90_000,
      105_000,
      120_000,
    ]);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(requests.sources).toHaveLength(12);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending image retry on unmount", async () => {
    vi.useFakeTimers();
    const image = await renderImage();
    const requests = trackImageSourceRequests(image);

    act(() => image.dispatchEvent(new Event("error")));
    act(() => root?.unmount());
    root = null;
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(requests.sources).toEqual([imageSource]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
