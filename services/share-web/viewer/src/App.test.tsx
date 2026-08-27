// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, loadLog, MARKDOWN_PREVIEW_BYTE_CAP, MAX_LOG_PAGES } from "./App";
import { filesFromLog, type RelayOp, type SharedFile, type ViewMeta } from "./model";

const SESSION = "abcdefghijkl";

const DEFAULT_META: ViewMeta = {
  access: "view",
  effectiveSelector: {
    paths: [],
    versionId: null,
    access: "view",
  },
  lastSettledAtMs: null,
  lastSettledKnown: true,
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestPath(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return `${input.pathname}${input.search}`;
  const url = new URL(input.url);
  return `${url.pathname}${url.search}`;
}

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

function logOpsPage(
  ops: readonly RelayOp[],
  nextCursor: number,
  hasMore = false,
  epochLogFloor = 0,
): Response {
  return jsonResponse({
    ops,
    nextCursor,
    hasMore,
    epochLogFloor,
  });
}

function logPage(files: readonly SharedFile[]): Response {
  return logOpsPage(
    files.length === 0
      ? []
      : [{
          relaySeq: 1,
          opKind: "version.create",
          payload: { forkSnapshots: files },
          recordedAtMs: 1,
        }],
    files.length,
  );
}

describe("App", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = null;
    history.replaceState(null, "", `/s/${SESSION}`);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderApp(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
    });
    await act(async () => {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    });
  }

  function renderedFilePaths(): Array<string | null> {
    return [...container.querySelectorAll("button.file")]
      .map((button) => button.textContent);
  }

  it("renders a successful empty share instead of refusing it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(container.querySelector("header")?.textContent).toContain(
      "Shared by a dohc user",
    );
    expect(container.querySelector(".badge")?.textContent).toBe("View");
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "No settled changes",
    );
    expect(container.querySelector("main.content")?.textContent).toBe(
      "No files in this share yet.",
    );
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("exposes each folder's disclosure state", async () => {
    const file: SharedFile = {
      path: "docs/readme.md",
      blobSha256: "f".repeat(64),
      contentKind: "text",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response("# Shared file");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const folderButton = container.querySelector("button.folder");
    expect(folderButton?.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      folderButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(folderButton?.getAttribute("aria-expanded")).toBe("false");
  });

  it("cancels an in-flight initial log scan on unmount", async () => {
    const logPaths: string[] = [];
    let logSignal: AbortSignal | undefined;
    let releaseFirstPage: (() => void) | undefined;
    const firstPageHeld = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) {
        logPaths.push(path);
        logSignal = init?.signal ?? undefined;
        if (logPaths.length === 1) {
          await firstPageHeld;
          return logOpsPage([], 1, true);
        }
        return logOpsPage([], 2);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });
    expect(logPaths).toEqual(["/api/view/log?since=0&limit=500"]);

    act(() => root?.unmount());
    root = null;
    releaseFirstPage?.();
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(logPaths).toEqual(["/api/view/log?since=0&limit=500"]);
    expect(logSignal).toBeInstanceOf(AbortSignal);
    expect(logSignal?.aborted).toBe(true);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("cancels an in-flight initial meta request on unmount", async () => {
    let metaSignal: AbortSignal | undefined;
    let logSignal: AbortSignal | undefined;
    let metaAborts = 0;
    let releaseMeta: ((response: Response) => void) | undefined;
    let rejectMeta: ((reason: unknown) => void) | undefined;
    const metaHeld = new Promise<Response>((resolve, reject) => {
      releaseMeta = resolve;
      rejectMeta = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaSignal = init?.signal ?? undefined;
        metaSignal?.addEventListener("abort", () => {
          metaAborts += 1;
          rejectMeta?.(new DOMException("The request was aborted.", "AbortError"));
        }, { once: true });
        return metaHeld;
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logSignal = init?.signal ?? undefined;
        return logPage([]);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });

    act(() => root?.unmount());
    root = null;
    releaseMeta?.(jsonResponse(DEFAULT_META));
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(metaSignal).toBeInstanceOf(AbortSignal);
    expect(metaSignal).toBe(logSignal);
    expect(metaSignal?.aborted).toBe(true);
    expect(metaAborts).toBe(1);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("presents the established session capability on viewer requests", async () => {
    const file: SharedFile = {
      path: "readme.md",
      blobSha256: "0".repeat(64),
      contentKind: "text",
    };
    const requestInits = new Map<string, RequestInit | undefined>();
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      requestInits.set(path, init);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response("# Shared file");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const metaRequestInit = requestInits.get("/api/view/meta");
    expect(metaRequestInit).toMatchObject({
      credentials: "same-origin",
      headers: { "x-dohc-link-session": SESSION },
    });
    const logRequestInit = requestInits.get("/api/view/log?since=0&limit=500");
    expect(logRequestInit).toMatchObject({
      credentials: "same-origin",
      headers: { "x-dohc-link-session": SESSION },
    });
    expect(metaRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(logRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(metaRequestInit?.signal).toBe(logRequestInit?.signal);
    const blobRequestInit = requestInits.get(`/api/view/blob/${file.blobSha256}`);
    expect(blobRequestInit).toMatchObject({
      credentials: "same-origin",
      headers: { "x-dohc-link-session": SESSION },
    });
    expect(blobRequestInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("renders unavailable freshness separately from no settled changes", async () => {
    const meta = {
      ...DEFAULT_META,
      lastSettledKnown: false,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(meta);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled time isn't available.",
    );
  });

  it("keeps tree selection and relative Markdown links inside the projected namespace", async () => {
    const readme: SharedFile = {
      path: "docs/guides/readme.md",
      blobSha256: "a".repeat(64),
      contentKind: "text",
    };
    const target: SharedFile = {
      path: "docs/notes/next.txt",
      blobSha256: "b".repeat(64),
      contentKind: "text",
    };
    const markdown = [
      "[Next](../notes/next.txt)",
      "[Missing](../notes/missing.txt)",
      "[Web](https://example.com/docs)",
      "[Mail](mailto:reader@example.com)",
    ].join("\n\n");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        return jsonResponse({
          ...DEFAULT_META,
          effectiveSelector: {
            ...DEFAULT_META.effectiveSelector,
            paths: ["docs"],
          },
        });
      }
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([readme, target]);
      }
      if (path === `/api/view/blob/${readme.blobSha256}`) {
        return new Response(markdown);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const anchors = [...container.querySelectorAll("a")];
    const internalLink = anchors.find((anchor) => anchor.textContent === "Next");
    const missingLink = anchors.find((anchor) => anchor.textContent === "Missing");
    const webLink = anchors.find((anchor) => anchor.textContent === "Web");
    const mailLink = anchors.find((anchor) => anchor.textContent === "Mail");
    const markdownText = container.querySelector("article.markdown")?.textContent;
    expect(markdownText).toContain("Next");
    expect(markdownText).toContain("Missing");
    expect(internalLink).toBeDefined();
    expect(missingLink).toBeUndefined();
    expect(webLink?.getAttribute("href")).toBe("https://example.com/docs");
    expect(mailLink?.getAttribute("href")).toBe("mailto:reader@example.com");
    expect(container.querySelector("nav")?.textContent).toContain("guides");
    expect(container.querySelector("nav")?.textContent).toContain("notes");
    expect(container.textContent).not.toContain("clients/acme/private");

    let followedPageLink = true;
    act(() => {
      followedPageLink = internalLink!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(followedPageLink).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("docs/notes/next.txt");
    expect(location.pathname).toBe(`/s/${SESSION}`);
  });

  it("keeps the viewer chrome when the selected file blob is unavailable", async () => {
    const file: SharedFile = {
      path: "readme.md",
      blobSha256: "9".repeat(64),
      contentKind: "text",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const content = container.querySelector("main.content");
    expect(content?.textContent).toBe("This link isn't available.");
    expect(content?.querySelector(".state")?.textContent).toBe(
      "This link isn't available.",
    );
    expect(container.querySelector("header")?.textContent).toContain(
      "Shared by a dohc user",
    );
    expect(container.querySelector("h1")?.textContent).toBe(file.path);
    expect(container.querySelector(".badge")?.textContent).toBe("View");
    expect(container.querySelector('nav[aria-label="Shared files"]')?.textContent)
      .toContain(file.path);
  });

  it("retries a throttled file blob and renders it when capacity becomes available", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "readme.md",
      blobSha256: "8".repeat(64),
      contentKind: "text",
    };
    let blobRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        blobRequests += 1;
        return blobRequests === 1
          ? new Response(null, { status: 429 })
          : new Response("# Retried file\n\nContent after retry.");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(container.querySelector("main.content")?.textContent).toContain(
      "Content after retry.",
    );
    expect(blobRequests).toBe(2);
  });

  it("stops retrying a persistently throttled file blob when the budget is exhausted", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "readme.md",
      blobSha256: "7".repeat(64),
      contentKind: "text",
    };
    let blobRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        blobRequests += 1;
        return new Response(null, { status: 429 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(blobRequests).toBe(12);
    expect(container.querySelector("main.content")?.textContent).toBe(
      "This link isn't available.",
    );
  });

  it("cancels a throttled file blob retry when the selection changes", async () => {
    vi.useFakeTimers();
    const firstFile: SharedFile = {
      path: "a.md",
      blobSha256: "6".repeat(64),
      contentKind: "text",
    };
    const secondFile: SharedFile = {
      path: "b.md",
      blobSha256: "5".repeat(64),
      contentKind: "text",
    };
    let firstFileRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([firstFile, secondFile]);
      }
      if (path === `/api/view/blob/${firstFile.blobSha256}`) {
        firstFileRequests += 1;
        return new Response(null, { status: 429 });
      }
      if (path === `/api/view/blob/${secondFile.blobSha256}`) {
        return new Response("# Current file\n\nSecond file content.");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    const secondFileButton = [...container.querySelectorAll("button.file")]
      .find((button) => button.textContent === secondFile.path);
    await act(async () => {
      secondFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Second file content.",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(firstFileRequests).toBe(1);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Second file content.",
    );
  });

  it("cancels an in-flight Markdown stream when the selection changes", async () => {
    vi.useFakeTimers();
    const firstFile: SharedFile = {
      path: "a.md",
      blobSha256: "4".repeat(64),
      contentKind: "text",
    };
    const secondFile: SharedFile = {
      path: "b.md",
      blobSha256: "3".repeat(64),
      contentKind: "text",
    };
    const chunks = [
      new TextEncoder().encode("# Obsolete file\n\n"),
      new TextEncoder().encode("This body should not reach EOF."),
    ];
    const streamEvents: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([firstFile, secondFile]);
      }
      if (path === `/api/view/blob/${firstFile.blobSha256}`) {
        let nextChunk = 0;
        let pendingTimer: number | null = null;
        let finishPull: (() => void) | null = null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              streamEvents.push("cancel");
              if (pendingTimer !== null) window.clearTimeout(pendingTimer);
              pendingTimer = null;
              controller.error(new DOMException("The request was aborted.", "AbortError"));
              finishPull?.();
              finishPull = null;
            }, { once: true });
          },
          pull(controller) {
            streamEvents.push(`read:${nextChunk + 1}`);
            return new Promise<void>((resolve) => {
              finishPull = resolve;
              pendingTimer = window.setTimeout(() => {
                pendingTimer = null;
                finishPull = null;
                const chunk = chunks[nextChunk];
                nextChunk += 1;
                if (chunk) {
                  controller.enqueue(chunk);
                } else {
                  streamEvents.push("eof");
                  controller.close();
                }
                resolve();
              }, 100);
            });
          },
        });
        return new Response(body);
      }
      if (path === `/api/view/blob/${secondFile.blobSha256}`) {
        return new Response("# Current file\n\nSecond file content.");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    expect(streamEvents).toEqual(["read:1"]);
    const failedRenders: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches(".state")) failedRenders.push(node.textContent ?? "");
          for (const state of node.querySelectorAll(".state")) {
            failedRenders.push(state.textContent ?? "");
          }
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    const secondFileButton = [...container.querySelectorAll("button.file")]
      .find((button) => button.textContent === secondFile.path);
    await act(async () => {
      secondFileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(500);
    });
    observer.disconnect();

    expect(streamEvents).toEqual(["read:1", "cancel"]);
    expect(failedRenders).toEqual([]);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Second file content.",
    );
    expect(container.querySelector("main.content")?.textContent).not.toContain(
      "This link isn't available.",
    );
  });

  it.each([
    [`/s/${SESSION}#section`, `/s/${SESSION}`],
    [`/s/${SESSION}?view=compact#section`, `/s/${SESSION}?view=compact`],
  ])("scrubs an in-page fragment without changing %s", async (address, scrubbed) => {
    history.replaceState(null, "", address);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(`${location.pathname}${location.search}${location.hash}`).toBe(scrubbed);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("scrubs the secret fragment without changing the exchange address", async () => {
    const secret = "s".repeat(43);
    history.replaceState(null, "", `/s/?view=compact#${secret}`);
    let finishExchange: ((response: Response) => void) | undefined;
    const exchangeResponse = new Promise<Response>((resolve) => {
      finishExchange = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/exchange") return exchangeResponse;
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });

    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      "/s/?view=compact",
    );

    await act(async () => {
      if (!finishExchange) throw new Error("Exchange request did not start");
      finishExchange(jsonResponse({ session: SESSION }));
    });
    // Wait for the condition, not a turn count: the exchange, metadata load,
    // and log load settle when the address carries the session path.
    for (let turn = 0; turn < 200 && location.pathname !== `/s/${SESSION}`; turn += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }

    expect(location.pathname).toBe(`/s/${SESSION}`);
    expect(location.hash).toBe("");
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("retries a rejected exchange and establishes the session", async () => {
    vi.useFakeTimers();
    const secret = "r".repeat(43);
    history.replaceState(null, "", `/s/#${secret}`);
    const exchangeBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/exchange") {
        exchangeBodies.push(String(init?.body));
        if (exchangeBodies.length === 1) throw new Error("network error");
        return jsonResponse({ session: SESSION });
      }
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(`${location.pathname}${location.hash}`).toBe("/s/");
    expect(exchangeBodies).toEqual([JSON.stringify({ secret })]);
    expect(container.textContent).toContain("Opening shared files");
    expect(container.textContent).not.toContain("This link isn't available.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(exchangeBodies).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(exchangeBodies).toEqual([
      JSON.stringify({ secret }),
      JSON.stringify({ secret }),
    ]);
    expect(location.pathname).toBe(`/s/${SESSION}`);
    expect(location.hash).toBe("");
    expect(container.querySelector("main.content")?.textContent).toBe(
      "No files in this share yet.",
    );
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("refuses a 404 exchange without retrying", async () => {
    vi.useFakeTimers();
    const secret = "t".repeat(43);
    history.replaceState(null, "", `/s/#${secret}`);
    let exchangeAttempts = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/exchange") {
        exchangeAttempts += 1;
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(exchangeAttempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(location.hash).toBe("");
    expect(container.textContent).toContain("This link isn't available.");
  });

  it("offers binary Markdown files as downloads", async () => {
    const file: SharedFile = {
      path: "payload.md",
      blobSha256: "c".repeat(64),
      contentKind: "binary",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(container.querySelector("main.content")?.textContent).toContain(
      "This file opens as a download.",
    );
    expect(container.querySelector("a[download]")?.textContent).toBe("Download file");
    expect(fetchMock.mock.calls.map(([input]) => requestPath(input))).not.toContain(
      `/api/view/blob/${file.blobSha256}`,
    );
  });

  it("retries a rate-limited download and delivers only the successful bytes", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "payload.bin",
      blobSha256: "d".repeat(64),
      contentKind: "binary",
    };
    const visibleDownloadPath = `/api/view/blob/${file.blobSha256}?session=${SESSION}`;
    const downloadPath = `/api/view/blob/${file.blobSha256}`;
    const downloadRequests: string[] = [];
    const deliveredBlobs: Blob[] = [];
    const objectUrl = "blob:dohc-download";
    const createObjectUrl = vi.spyOn(URL, "createObjectURL")
      .mockImplementation((blob) => {
        if (!(blob instanceof Blob)) throw new Error("Expected download bytes");
        deliveredBlobs.push(blob);
        return objectUrl;
      });
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const clickedDownloads: Array<{
      href: string;
      download: string;
      connected: boolean;
    }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedDownloads.push({
        href: this.href,
        download: this.download,
        connected: this.isConnected,
      });
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === downloadPath) {
        downloadRequests.push(path);
        return downloadRequests.length === 1
          ? new Response("rate-limit refusal", { status: 429 })
          : new Response("shared file bytes");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const visibleDownload = container.querySelector("a[download]");
    expect(visibleDownload?.getAttribute("href")).toBe(visibleDownloadPath);
    expect(visibleDownload?.getAttribute("download")).toBe("payload.bin");
    expect(visibleDownload?.textContent).toBe("Download file");

    let followedRawAnchor = true;
    await act(async () => {
      followedRawAnchor = visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      ) ?? true;
      await Promise.resolve();
    });

    expect(followedRawAnchor).toBe(false);
    expect(downloadRequests).toEqual([downloadPath]);
    expect(deliveredBlobs).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(downloadRequests).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(downloadRequests).toEqual([downloadPath, downloadPath]);
    expect(await deliveredBlobs[0]?.text()).toBe("shared file bytes");
    expect(clickedDownloads).toEqual([{
      href: objectUrl,
      download: "payload.bin",
      connected: true,
    }]);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith(objectUrl);
    expect(document.body.querySelector(`a[href="${objectUrl}"]`)).toBeNull();
  });

  async function renderRasterImage(): Promise<{
    image: HTMLImageElement;
    imageSource: string;
  }> {
    const file: SharedFile = {
      path: "selected.png",
      blobSha256: "e".repeat(64),
      contentKind: "binary",
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const image = container.querySelector("img.preview-image");
    if (!(image instanceof HTMLImageElement)) {
      throw new Error("raster preview did not render");
    }
    return {
      image,
      imageSource: `/api/view/blob/${file.blobSha256}?session=${SESSION}`,
    };
  }

  it("retries a failed raster preview after the initial delay and stops after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { image, imageSource } = await renderRasterImage();
    const requests = trackImageSourceRequests(image);

    act(() => image.dispatchEvent(new Event("error")));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(requests.sources).toEqual([imageSource]);

    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(requests.sources).toEqual([imageSource, imageSource]);
    expect(requests.times).toEqual([0, 1_000]);

    act(() => image.dispatchEvent(new Event("error")));
    act(() => image.dispatchEvent(new Event("load")));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(requests.sources).toEqual([imageSource, imageSource]);
  });

  it("gives up retrying a raster preview after the two-minute budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { image } = await renderRasterImage();
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
  });

  it("pins the Markdown preview byte cap", () => {
    expect(MARKDOWN_PREVIEW_BYTE_CAP).toBe(2 * 1024 * 1024);
  });

  it("offers oversized Markdown files as downloads without rendering them", async () => {
    const file: SharedFile = {
      path: "oversized.md",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const encoder = new TextEncoder();
    const markdownChunks = [
      encoder.encode("# Oversized Markdown\n\n"),
      new Uint8Array(MARKDOWN_PREVIEW_BYTE_CAP),
      encoder.encode("# Must not render"),
    ];
    expect(
      markdownChunks.reduce((size, chunk) => size + chunk.byteLength, 0),
    ).toBeGreaterThan(
      MARKDOWN_PREVIEW_BYTE_CAP,
    );
    let nextChunk = 0;
    let streamCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = markdownChunks[nextChunk];
        nextChunk += 1;
        if (chunk) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response(body);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const downloadCard = container.querySelector(".download-card");
    expect({
      renderedHeading: container.querySelector("article.markdown h1")?.textContent,
      downloadCopy: downloadCard?.querySelector("p")?.textContent,
      downloadLabel: downloadCard?.querySelector("a[download]")?.textContent,
      streamCancelled,
    }).toEqual({
      renderedHeading: undefined,
      downloadCopy: "This file opens as a download.",
      downloadLabel: "Download file",
      streamCancelled: true,
    });
  });

  it("renders Markdown files at or under the preview byte cap", async () => {
    const file: SharedFile = {
      path: "preview.md",
      blobSha256: "2".repeat(64),
      contentKind: "text",
    };
    const markdown = "# Previewed Markdown\n\nStill rendered.";
    expect(new TextEncoder().encode(markdown).byteLength).toBeLessThanOrEqual(
      MARKDOWN_PREVIEW_BYTE_CAP,
    );
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response(markdown);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(container.querySelector("article.markdown h1")?.textContent).toBe(
      "Previewed Markdown",
    );
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Still rendered.",
    );
    expect(container.querySelector(".download-card")).toBeNull();
  });

  it("refreshes the last-settled age every minute", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-26T06:00:00.000Z");
    vi.setSystemTime(now);
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "d".repeat(64),
      contentKind: "text",
    };
    const meta: ViewMeta = {
      ...DEFAULT_META,
      lastSettledAtMs: now.getTime() - 59_000,
    };
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(meta);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled 59 seconds ago",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled 2 minutes ago",
    );
  });

  it("requests heartbeat log deltas from the last cursor", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "e".repeat(64),
      contentKind: "text",
    };
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) {
        logPaths.push(path);
        if (logPaths.length === 1) {
          return logOpsPage([{
            relaySeq: 17,
            opKind: "version.create",
            payload: { forkSnapshots: [file] },
            recordedAtMs: 1,
          }], 17);
        }
        return logOpsPage([], 17);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=17&limit=500",
    ]);
  });

  it("rebuilds the file tree when a heartbeat observes a new epoch floor", async () => {
    vi.useFakeTimers();
    const removedFile: SharedFile = {
      path: "gone.txt",
      blobSha256: "4".repeat(64),
      contentKind: "text",
    };
    const survivingFile: SharedFile = {
      path: "survives.txt",
      blobSha256: "5".repeat(64),
      contentKind: "text",
    };
    const initialOps: RelayOp[] = [{
      relaySeq: 7,
      opKind: "version.create",
      payload: { forkSnapshots: [removedFile, survivingFile] },
      recordedAtMs: 1,
    }];
    const postRotationOps: RelayOp[] = [{
      relaySeq: 11,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadAfterPath: survivingFile.path,
        payloadAfterBlobSha256: "6".repeat(64),
        payloadAfterContentKind: "text",
      },
      recordedAtMs: 2,
    }];
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logOpsPage(initialOps, 7);
      }
      if (path === "/api/view/log?since=7&limit=500") {
        return logOpsPage(postRotationOps, 11, false, 10);
      }
      if (path === "/api/view/log?since=10&limit=500") {
        return logOpsPage(postRotationOps, 11, false, 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    expect(renderedFilePaths()).toEqual(["gone.txt", "survives.txt"]);
    const survivingButton = [...container.querySelectorAll("button.file")]
      .find((button) => button.textContent === "survives.txt");
    await act(async () => {
      survivingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(renderedFilePaths()).toEqual(["survives.txt"]);
    expect(container.querySelector("h1")?.textContent).toBe("survives.txt");
    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=10&limit=500",
    ]);
  });

  it("folds heartbeat renames, additions, and deletions onto the initial files", async () => {
    vi.useFakeTimers();
    const fileA: SharedFile = {
      path: "a.txt",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const fileB: SharedFile = {
      path: "b.txt",
      blobSha256: "2".repeat(64),
      contentKind: "text",
    };
    const initialOps: RelayOp[] = [{
      relaySeq: 1,
      opKind: "version.create",
      payload: { forkSnapshots: [fileA, fileB] },
      recordedAtMs: 1,
    }];
    const deltaOps: RelayOp[] = [
      {
        relaySeq: 2,
        opKind: "moment.append",
        payload: {
          operation: "rename",
          payloadBeforePath: fileB.path,
          payloadAfterPath: "renamed-b.txt",
          payloadAfterBlobSha256: fileB.blobSha256,
          payloadAfterContentKind: fileB.contentKind,
        },
        recordedAtMs: 2,
      },
      {
        relaySeq: 3,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadAfterPath: "c.txt",
          payloadAfterBlobSha256: "3".repeat(64),
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 3,
      },
    ];
    const deleteOps: RelayOp[] = [{
      relaySeq: 4,
      opKind: "moment.append",
      payload: {
        operation: "delete",
        payloadBeforePath: fileA.path,
        path: fileA.path,
      },
      recordedAtMs: 4,
    }];
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logOpsPage(initialOps, 1);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        return logOpsPage(deltaOps, 3);
      }
      if (path === "/api/view/log?since=3&limit=500") {
        return logOpsPage(deleteOps, 4);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    expect(renderedFilePaths()).toEqual(["a.txt", "b.txt"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    const afterFirstDelta = filesFromLog([...initialOps, ...deltaOps])
      .map((file) => file.path);
    expect(afterFirstDelta).toEqual(["a.txt", "c.txt", "renamed-b.txt"]);
    expect(renderedFilePaths()).toEqual(afterFirstDelta);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    const afterDelete = filesFromLog([...initialOps, ...deltaOps, ...deleteOps])
      .map((file) => file.path);
    expect(afterDelete).toEqual(["c.txt", "renamed-b.txt"]);
    expect(renderedFilePaths()).toEqual(afterDelete);
    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=1&limit=500",
      "/api/view/log?since=3&limit=500",
    ]);
  });

  it("matches a full replay when the initial log spans pages", async () => {
    const fileA: SharedFile = {
      path: "a.txt",
      blobSha256: "4".repeat(64),
      contentKind: "text",
    };
    const fileB: SharedFile = {
      path: "b.txt",
      blobSha256: "5".repeat(64),
      contentKind: "text",
    };
    const firstPageOps: RelayOp[] = [{
      relaySeq: 7,
      opKind: "version.create",
      payload: { forkSnapshots: [fileA, fileB] },
      recordedAtMs: 1,
    }];
    const secondPageOps: RelayOp[] = [
      {
        relaySeq: 8,
        opKind: "moment.append",
        payload: {
          operation: "rename",
          payloadBeforePath: fileB.path,
          payloadAfterPath: "renamed.txt",
          payloadAfterBlobSha256: fileB.blobSha256,
          payloadAfterContentKind: fileB.contentKind,
        },
        recordedAtMs: 2,
      },
      {
        relaySeq: 9,
        opKind: "moment.append",
        payload: {
          operation: "delete",
          payloadBeforePath: fileA.path,
        },
        recordedAtMs: 3,
      },
      {
        relaySeq: 10,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadAfterPath: "new.txt",
          payloadAfterBlobSha256: "6".repeat(64),
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 4,
      },
    ];
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logOpsPage(firstPageOps, 7, true);
      }
      if (path === "/api/view/log?since=7&limit=500") {
        return logOpsPage(secondPageOps, 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const fullReplay = filesFromLog([...firstPageOps, ...secondPageOps])
      .map((file) => file.path);
    expect(fullReplay).toEqual(["new.txt", "renamed.txt"]);
    expect(renderedFilePaths()).toEqual(fullReplay);
    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=7&limit=500",
    ]);
  });

  it("restarts one load when the epoch floor changes between pages", async () => {
    const priorEpochFile: SharedFile = {
      path: "prior-epoch.txt",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const firstPageFile: SharedFile = {
      path: "first-page-old-epoch.txt",
      blobSha256: "2".repeat(64),
      contentKind: "text",
    };
    const rotatedEpochFile: SharedFile = {
      path: "rotated-epoch.txt",
      blobSha256: "3".repeat(64),
      contentKind: "text",
    };
    const snapshotOp = (relaySeq: number, file: SharedFile): RelayOp => ({
      relaySeq,
      opKind: "version.create",
      payload: { forkSnapshots: [file] },
      recordedAtMs: relaySeq,
    });
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      logPaths.push(path);
      if (path === "/api/view/log?since=5&limit=500") {
        return logOpsPage([snapshotOp(6, firstPageFile)], 6, true, 5);
      }
      if (path === "/api/view/log?since=6&limit=500") {
        return logOpsPage([snapshotOp(11, rotatedEpochFile)], 11, false, 10);
      }
      if (path === "/api/view/log?since=10&limit=500") {
        return logOpsPage([snapshotOp(11, rotatedEpochFile)], 11, false, 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadLog(
      SESSION,
      5,
      new Map([[priorEpochFile.path, priorEpochFile]]),
      3,
    );

    expect({
      files: [...loaded.fileAccumulator.keys()].sort(),
      nextCursor: loaded.nextCursor,
      epochLogFloor: loaded.epochLogFloor,
      logPaths,
    }).toEqual({
      files: [rotatedEpochFile.path],
      nextCursor: 11,
      epochLogFloor: 10,
      logPaths: [
        "/api/view/log?since=5&limit=500",
        "/api/view/log?since=6&limit=500",
        "/api/view/log?since=10&limit=500",
      ],
    });
  });

  it("keeps one fold when the epoch floor stays stable between pages", async () => {
    const priorFile: SharedFile = {
      path: "prior.txt",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const firstPageFile: SharedFile = {
      path: "first-page.txt",
      blobSha256: "2".repeat(64),
      contentKind: "text",
    };
    const secondPageFile: SharedFile = {
      path: "second-page.txt",
      blobSha256: "3".repeat(64),
      contentKind: "text",
    };
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      logPaths.push(path);
      if (path === "/api/view/log?since=5&limit=500") {
        return logOpsPage([{
          relaySeq: 6,
          opKind: "version.create",
          payload: { forkSnapshots: [firstPageFile] },
          recordedAtMs: 6,
        }], 6, true, 5);
      }
      if (path === "/api/view/log?since=6&limit=500") {
        return logOpsPage([{
          relaySeq: 7,
          opKind: "version.create",
          payload: { forkSnapshots: [secondPageFile] },
          recordedAtMs: 7,
        }], 7, false, 5);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const loaded = await loadLog(
      SESSION,
      5,
      new Map([[priorFile.path, priorFile]]),
      2,
    );

    expect({
      files: [...loaded.fileAccumulator.keys()].sort(),
      nextCursor: loaded.nextCursor,
      epochLogFloor: loaded.epochLogFloor,
      logPaths,
    }).toEqual({
      files: [firstPageFile.path, priorFile.path, secondPageFile.path],
      nextCursor: 7,
      epochLogFloor: 5,
      logPaths: [
        "/api/view/log?since=5&limit=500",
        "/api/view/log?since=6&limit=500",
      ],
    });
  });

  it("refreshes files and meta every four minutes and stops on unmount", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-26T06:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const initialFile: SharedFile = {
      path: "zeta.txt",
      blobSha256: "e".repeat(64),
      contentKind: "text",
    };
    const addedFile: SharedFile = {
      path: "alpha.txt",
      blobSha256: "f".repeat(64),
      contentKind: "text",
    };
    const addedFileOp: RelayOp = {
      relaySeq: 2,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadAfterPath: addedFile.path,
        payloadAfterBlobSha256: addedFile.blobSha256,
        payloadAfterContentKind: addedFile.contentKind,
      },
      recordedAtMs: 2,
    };
    const metaPaths: string[] = [];
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaPaths.push(path);
        return jsonResponse(metaPaths.length === 1
          ? DEFAULT_META
          : { ...DEFAULT_META, lastSettledAtMs: startedAt + 4 * 60_000 });
      }
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([initialFile]);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        return logOpsPage([addedFileOp], 2);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        return logOpsPage([], 2);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(metaPaths).toHaveLength(1);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "No settled changes",
    );
    expect(renderedFilePaths()).toEqual(["zeta.txt"]);
    expect(container.querySelector("h1")?.textContent).toBe("zeta.txt");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect({
      files: renderedFilePaths(),
      freshness: container.querySelector(".freshness")?.textContent,
    }).toEqual({
      files: ["alpha.txt", "zeta.txt"],
      freshness: "Last settled now",
    });
    expect(metaPaths).toHaveLength(2);
    expect(logPaths).toHaveLength(2);
    expect(container.querySelector("h1")?.textContent).toBe("zeta.txt");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaPaths).toHaveLength(3);
    expect(logPaths).toHaveLength(3);
    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaPaths).toHaveLength(3);
    expect(logPaths).toHaveLength(3);
  });

  it("cancels an in-flight heartbeat log scan on teardown", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "a".repeat(64),
      contentKind: "text",
    };
    const logPaths: string[] = [];
    let heartbeatSignal: AbortSignal | undefined;
    let releaseHeartbeatPage: (() => void) | undefined;
    const heartbeatPageHeld = new Promise<void>((resolve) => {
      releaseHeartbeatPage = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === "/api/view/log?since=1&limit=500") {
        heartbeatSignal = init?.signal ?? undefined;
        await heartbeatPageHeld;
        return logOpsPage([], 2, true);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        return logOpsPage([], 2);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });
    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=1&limit=500",
    ]);

    act(() => root?.unmount());
    root = null;
    releaseHeartbeatPage?.();
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=1&limit=500",
    ]);
    expect(heartbeatSignal).toBeInstanceOf(AbortSignal);
    expect(heartbeatSignal?.aborted).toBe(true);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("cancels an in-flight heartbeat meta request on teardown", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "b".repeat(64),
      contentKind: "text",
    };
    let metaRequests = 0;
    let heartbeatMetaSignal: AbortSignal | undefined;
    let heartbeatLogSignal: AbortSignal | undefined;
    let metaAborts = 0;
    let rejectHeartbeatMeta: ((reason: unknown) => void) | undefined;
    const heartbeatMetaHeld = new Promise<Response>((_resolve, reject) => {
      rejectHeartbeatMeta = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        if (metaRequests === 1) return jsonResponse(DEFAULT_META);
        heartbeatMetaSignal = init?.signal ?? undefined;
        heartbeatMetaSignal?.addEventListener("abort", () => {
          metaAborts += 1;
          rejectHeartbeatMeta?.(
            new DOMException("The request was aborted.", "AbortError"),
          );
        }, { once: true });
        return heartbeatMetaHeld;
      }
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === "/api/view/log?since=1&limit=500") {
        heartbeatLogSignal = init?.signal ?? undefined;
        return logOpsPage([], 1);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaRequests).toBe(2);
    expect(heartbeatMetaSignal).toBeInstanceOf(AbortSignal);
    expect(heartbeatMetaSignal).toBe(heartbeatLogSignal);

    act(() => root?.unmount());
    root = null;
    await act(async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });

    expect(heartbeatMetaSignal?.aborted).toBe(true);
    expect(metaAborts).toBe(1);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("falls back to the first file when a heartbeat renames the selected file", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-26T06:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const firstFile: SharedFile = {
      path: "alpha.txt",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const selectedFile: SharedFile = {
      path: "beta.txt",
      blobSha256: "2".repeat(64),
      contentKind: "text",
    };
    const renamedFile: SharedFile = {
      path: "gamma.txt",
      blobSha256: selectedFile.blobSha256,
      contentKind: "text",
    };
    const renameOp: RelayOp = {
      relaySeq: 3,
      opKind: "moment.append",
      payload: {
        operation: "rename",
        payloadBeforePath: selectedFile.path,
        payloadAfterPath: renamedFile.path,
        payloadAfterBlobSha256: renamedFile.blobSha256,
        payloadAfterContentKind: renamedFile.contentKind,
      },
      recordedAtMs: 3,
    };
    let metaRequests = 0;
    let logRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        return jsonResponse({
          ...DEFAULT_META,
          lastSettledAtMs: metaRequests === 1
            ? null
            : startedAt + (metaRequests - 1) * 4 * 60_000,
        });
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logRequests += 1;
        return logPage([firstFile, selectedFile]);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        logRequests += 1;
        return logOpsPage([renameOp], 3);
      }
      if (path === "/api/view/log?since=3&limit=500") {
        logRequests += 1;
        return logOpsPage([], 3);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const selectedButton = [...container.querySelectorAll("button.file")]
      .find((button) => button.textContent === selectedFile.path);
    expect(selectedButton).toBeDefined();
    act(() => {
      selectedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("h1")?.textContent).toBe(selectedFile.path);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(renderedFilePaths()).toEqual([firstFile.path, renamedFile.path]);
    expect(container.querySelector("h1")?.textContent).toBe(firstFile.path);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(container.querySelector("h1")?.textContent).toBe(firstFile.path);
  });

  it("keeps loaded files through a network heartbeat failure and recovers on the next beat", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "7".repeat(64),
      contentKind: "text",
    };
    let metaRequests = 0;
    let logRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        if (metaRequests === 2) throw new Error("network error");
        return jsonResponse(metaRequests === 3
          ? { ...DEFAULT_META, lastSettledAtMs: Date.now() }
          : DEFAULT_META);
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logRequests += 1;
        return logPage([file]);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        logRequests += 1;
        return logOpsPage([], 1);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(renderedFilePaths()).toEqual([file.path]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaRequests).toBe(2);
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaRequests).toBe(3);
    expect(logRequests).toBe(3);
    expect(renderedFilePaths()).toEqual([file.path]);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled now",
    );
  });

  it.each([401, 403, 404])(
    "shows the unavailable state when a meta heartbeat returns %i",
    async (status) => {
      vi.useFakeTimers();
      let metaRequests = 0;
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/meta") {
          metaRequests += 1;
          return metaRequests === 1
            ? jsonResponse(DEFAULT_META)
            : new Response(null, { status });
        }
        if (path === "/api/view/log?since=0&limit=500") return logPage([]);
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();

      expect(container.textContent).not.toContain("This link isn't available.");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4 * 60_000);
      });

      expect(metaRequests).toBe(2);
      expect(container.textContent).toContain("This link isn't available.");
    },
  );

  it("keeps the last settled view when a meta heartbeat returns 503 and recovers on the next beat", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "8".repeat(64),
      contentKind: "text",
    };
    let metaRequests = 0;
    let logRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        if (metaRequests === 2) return new Response(null, { status: 503 });
        return jsonResponse(metaRequests === 3
          ? { ...DEFAULT_META, lastSettledAtMs: Date.now() }
          : DEFAULT_META);
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logRequests += 1;
        return logPage([file]);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        logRequests += 1;
        return logOpsPage([], 1);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaRequests).toBe(2);
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(metaRequests).toBe(3);
    expect(logRequests).toBe(3);
    expect(renderedFilePaths()).toEqual([file.path]);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled now",
    );
  });

  it("caps heartbeat log pagination", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "note.txt",
      blobSha256: "9".repeat(64),
      contentKind: "text",
    };
    const heartbeatLogPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      const cursorMatch = /^\/api\/view\/log\?since=(\d+)&limit=500$/u.exec(path);
      if (cursorMatch) {
        heartbeatLogPaths.push(path);
        const cursor = Number(cursorMatch[1]);
        return logOpsPage(
          [],
          cursor + 1,
          heartbeatLogPaths.length <= MAX_LOG_PAGES,
        );
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000);
    });

    expect(heartbeatLogPaths).toHaveLength(MAX_LOG_PAGES);
    expect(heartbeatLogPaths.at(-1)).toBe(
      "/api/view/log?since=200&limit=500",
    );
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);
  });

  describe("log rate limits", () => {
    it("retries the same log page with exponential backoff", async () => {
      vi.useFakeTimers();
      const startedAt = new Date("2026-08-26T06:00:00.000Z").getTime();
      vi.setSystemTime(startedAt);
      const logPaths: string[] = [];
      const logTimes: number[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
        if (path === "/api/view/log?since=0&limit=500") {
          logPaths.push(path);
          logTimes.push(Date.now() - startedAt);
          if (logPaths.length < 5) return new Response(null, { status: 429 });
          return logPage([]);
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();

      expect(container.textContent).not.toContain("This link isn't available.");
      expect(logTimes).toEqual([0]);

      for (const [wait, attempts] of [[1_000, 2], [2_000, 3], [4_000, 4]] as const) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(wait - 1);
        });
        expect(logPaths).toHaveLength(attempts - 1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1);
        });
        expect(logPaths).toHaveLength(attempts);
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(7_999);
      });
      expect(logPaths).toHaveLength(4);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(logPaths).toEqual(Array.from({ length: 5 }, () => logPaths[0]!));
      expect(logTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
      expect(container.querySelector("main.content")?.textContent).toBe(
        "No files in this share yet.",
      );
    });

    it("refuses only after the two-minute 429 retry budget", async () => {
      vi.useFakeTimers();
      const logPaths: string[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
        if (path === "/api/view/log?since=0&limit=500") {
          logPaths.push(path);
          return new Response(null, { status: 429 });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(119_999);
      });

      expect(container.textContent).not.toContain("This link isn't available.");
      expect(logPaths).toHaveLength(11);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(container.textContent).toContain("This link isn't available.");
      expect(logPaths).toHaveLength(12);
    });

    it("refuses a non-429 log failure without retrying", async () => {
      vi.useFakeTimers();
      const logPaths: string[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
        if (path === "/api/view/log?since=0&limit=500") {
          logPaths.push(path);
          return new Response(null, { status: 500 });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();

      expect(container.textContent).toContain("This link isn't available.");
      expect(logPaths).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
