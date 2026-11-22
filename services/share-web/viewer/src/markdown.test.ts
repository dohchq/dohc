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

  it("renders GFM task lists without input elements", () => {
    const html = renderSafeMarkdown("- [ ] Open item\n- [x] Done item\n");
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelector("input")).toBeNull();
    expect(template.content.querySelector("ul.task-list")).not.toBeNull();
    const items = template.content.querySelectorAll("li.task-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.classList.contains("task-item-checked")).toBe(false);
    expect(items[0]!.querySelector("span.task-check")).not.toBeNull();
    expect(items[0]!.querySelector("span.task-check-checked")).toBeNull();
    expect(items[1]!.classList.contains("task-item-checked")).toBe(true);
    expect(items[1]!.querySelector("span.task-check.task-check-checked")).not.toBeNull();
  });

  it("renders highlights, Obsidian callouts, and wikilinks", () => {
    const html = renderSafeMarkdown(
      [
        "A ==highlighted== phrase and literal a == b.",
        "",
        "> [!warning] Watch out",
        "> Check the details.",
        "",
        "> [!custom]",
        "> Unknown kind falls back to note.",
        "",
        "See [[docs/plan|The Plan]] and [[Missing Page]].",
      ].join("\n"),
      undefined,
      (href) => (href === "docs/plan.md" ? "docs/plan.md" : null),
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelector("mark")?.textContent).toBe("highlighted");
    expect(html).toContain("a == b");

    const callouts = template.content.querySelectorAll("div.dohc-callout");
    expect(callouts).toHaveLength(2);
    expect(callouts[0]!.classList.contains("callout-warning")).toBe(true);
    expect(callouts[0]!.querySelector(".callout-title")?.textContent).toBe("Watch out");
    expect(callouts[0]!.querySelector(".callout-body")?.textContent).toContain(
      "Check the details.",
    );
    expect(callouts[1]!.classList.contains("callout-note")).toBe(true);
    expect(callouts[1]!.querySelector(".callout-title")?.textContent).toBe("Custom");

    const sharedLink = template.content.querySelector('a[href="/docs/plan.md"]');
    expect(sharedLink?.textContent).toBe("The Plan");
    expect(template.content.querySelector("span.dohc-wikilink-pill")?.textContent).toBe(
      "Missing Page",
    );
  });

  it("adds deterministic unique heading slugs, table wrappers, and safe external link attributes", () => {
    const html = renderSafeMarkdown(
      [
        "# Getting Started",
        "",
        "## Getting Started",
        "",
        "| Name | Value |",
        "| --- | --- |",
        "| A | 1 |",
        "",
        "[External](https://example.com/docs)",
        "",
        "[Email](mailto:ada@example.com)",
      ].join("\n"),
    );
    const template = document.createElement("template");
    template.innerHTML = html;

    expect(template.content.querySelector("h1")?.getAttribute("id")).toBe("h-getting-started");
    expect(template.content.querySelector("h2")?.getAttribute("id")).toBe("h-getting-started-2");
    expect(template.content.querySelector("div.table-wrap > table")).not.toBeNull();

    const external = template.content.querySelector('a[href="https://example.com/docs"]');
    expect(external?.getAttribute("target")).toBe("_blank");
    expect(external?.getAttribute("rel")).toBe("noopener noreferrer");

    const mailto = template.content.querySelector('a[href="mailto:ada@example.com"]');
    expect(mailto?.getAttribute("target")).toBeNull();
  });

  it("strips hostile class, id, target, and rel attributes through DOMPurify", async () => {
    const DOMPurify = (await import("dompurify")).default;
    const dirty =
      '<div class="evil task-item" id="clobber"><a href="javascript:alert(1)" target="_blank" rel="opener">x</a><a href="/local" target="_blank" rel="evil">y</a><h2 id="bad-id">t</h2><h2 id="h-safe-id">ok</h2></div>';
    const clean = String(DOMPurify.sanitize(dirty, MARKDOWN_SANITIZE_CONFIG));
    const template = document.createElement("template");
    template.innerHTML = clean;

    const div = template.content.querySelector("div")!;
    expect(div.getAttribute("class")).toBe("task-item");
    expect(div.getAttribute("id")).toBeNull();
    const links = template.content.querySelectorAll("a");
    expect(links[0]!.getAttribute("href")).toBeNull();
    expect(links[0]!.getAttribute("target")).toBeNull();
    expect(links[0]!.getAttribute("rel")).toBeNull();
    expect(links[1]!.getAttribute("target")).toBeNull();
    expect(links[1]!.getAttribute("rel")).toBeNull();
    const headings = template.content.querySelectorAll("h2");
    expect(headings[0]!.getAttribute("id")).toBeNull();
    expect(headings[1]!.getAttribute("id")).toBe("h-safe-id");
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
      root?.render(
        createElement(MarkdownContent, {
          markdown: ["[Shared file](/docs/next.md)", "[Unresolved](#section)"].join("\n\n"),
          resolveLink: (href: string) => (href === "/docs/next.md" ? "docs/next.md" : null),
          onNavigate: (path: string) => navigatedPaths.push(path),
        }),
      );
    });

    const sharedFileLink = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Shared file",
    );
    const unresolvedLink = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Unresolved",
    );
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

  it("scrolls to matching heading anchors on click", async () => {
    await act(() => {
      root?.render(
        createElement(MarkdownContent, {
          markdown: "[Jump](#getting-started)\n\n## Getting Started",
        }),
      );
    });
    const heading = container.querySelector("h2")!;
    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    const link = container.querySelector('a[href="#getting-started"]')!;
    let allowed = true;
    act(() => {
      allowed = link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(allowed).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it("assigns unique IDs to duplicate and Unicode headings and exposes task status to screen readers", async () => {
    await act(() => {
      root?.render(
        createElement(MarkdownContent, {
          markdown: [
            "## Plan",
            "## Plan",
            "## Plan 2",
            "## 计划",
            "## हिन्दी",
            "",
            "- [x] Shipped",
            "- [ ] Pending",
          ].join("\n"),
        }),
      );
    });
    const headingIds = [...container.querySelectorAll("h2")].map((h) => h.id);
    expect(new Set(headingIds).size).toBe(headingIds.length);
    expect(headingIds[0]).toBe("h-plan");
    expect(headingIds[1]).toBe("h-plan-2");
    expect(headingIds[2]).not.toBe("h-plan-2");
    expect(headingIds[3]).toBe("h-计划");
    expect(headingIds[4]).toBe("h-हिन्दी");

    const srLabels = [...container.querySelectorAll("li.task-item .sr-only")].map((el) =>
      el.textContent?.trim(),
    );
    expect(srLabels).toEqual(["Completed task:", "Incomplete task:"]);
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
      root?.render(
        createElement(MarkdownContent, {
          markdown: `![Shared image](${imageSource})`,
        }),
      );
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
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000,
    ];

    act(() => image.dispatchEvent(new Event("error")));
    for (const delay of retryDelays) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
      act(() => image.dispatchEvent(new Event("error")));
    }

    expect(requests.times).toEqual([
      0, 1_000, 3_000, 7_000, 15_000, 30_000, 45_000, 60_000, 75_000, 90_000, 105_000, 120_000,
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
