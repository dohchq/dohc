// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { SharedFile, ViewMeta } from "./model";

const SESSION = "abcdefghijkl";

const DEFAULT_META: ViewMeta = {
  access: "view",
  effectiveSelector: {
    paths: [],
    versionId: null,
    access: "view",
  },
  lastSettledAtMs: null,
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

function logPage(files: readonly SharedFile[]): Response {
  return jsonResponse({
    ops: files.length === 0
      ? []
      : [{
          relaySeq: 1,
          opKind: "version.create",
          payload: { forkSnapshots: files },
          recordedAtMs: 1,
        }],
    nextCursor: files.length,
    hasMore: false,
  });
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

  it("navigates resolved relative Markdown links inside the share", async () => {
    const readme: SharedFile = {
      path: "docs/readme.md",
      blobSha256: "a".repeat(64),
      contentKind: "text",
    };
    const target: SharedFile = {
      path: "notes/next.txt",
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
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
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

    let followedPageLink = true;
    act(() => {
      followedPageLink = internalLink!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });

    expect(followedPageLink).toBe(false);
    expect(container.querySelector("h1")?.textContent).toBe("notes/next.txt");
    expect(location.pathname).toBe(`/s/${SESSION}`);
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
      if (path === "/api/view/log?since=0&limit=500") {
        logPaths.push(path);
        return logPage(logPaths.length === 1
          ? [initialFile]
          : [initialFile, addedFile]);
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
        if (logRequests === 1) return logPage([firstFile, selectedFile]);
        if (logRequests === 2) return logPage([firstFile, renamedFile]);
        return logPage([firstFile, selectedFile, renamedFile]);
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

  it("shows the unavailable state when a meta heartbeat is refused", async () => {
    vi.useFakeTimers();
    let metaRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        return metaRequests === 1
          ? jsonResponse(DEFAULT_META)
          : new Response(null, { status: 404 });
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
