// @vitest-environment jsdom
// App discovery has its own request, cancellation, and rendering tests.
vi.mock("./PublishedApps", () => ({PublishedApps: () => null}));
import { jsonResponse, requestPath as fullRequestPath, settle, setControlValue } from "./testing";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  SETTLEMENT_END_TO_END_MAX_MS,
  createSettlementScheduler,
  type SettlementReason,
} from "@dohc/live-session-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  App,
  dohcNavigation,
  fileTree,
  loadCurrentState,
  loadLog,
  MARKDOWN_PREVIEW_BYTE_CAP,
  MAX_LOG_PAGES,
} from "./App";
import { filesFromLog, type RelayOp, type SharedFile, type ViewMeta } from "./model";

const SESSION = "abcdefghijkl";
const SECOND_SESSION = "mnopqrstuvwx";
const FIRST_HANDOFF_CODE = "A".repeat(43);
const SECOND_HANDOFF_CODE = "B".repeat(43);
const PUBLIC_RELAY_URL = "https://relay.example.test";
let exposeHeldLogQuery = false;

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

// Follower log requests carry `&hold=30000`; most suites match the held-log
// path without it, so strip the suffix unless a test opts into the full path.
function requestPath(input: RequestInfo | URL): string {
  const path = fullRequestPath(input);
  return exposeHeldLogQuery ? path : path.replace(/&hold=30000$/u, "");
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

function currentPage(
  files: readonly SharedFile[],
  nextCursor = files.length,
  epochLogFloor = 0,
  meta: ViewMeta = DEFAULT_META,
): Response {
  return jsonResponse({
    ok: true,
    ...meta,
    files,
    nextCursor,
    epochLogFloor,
  });
}

interface ReferenceFolderNode {
  name: string;
  path: string;
  folders: ReferenceFolderNode[];
  files: SharedFile[];
}

function quadraticReferenceFileTree(files: SharedFile[]): ReferenceFolderNode {
  const root: ReferenceFolderNode = {
    name: "",
    path: "",
    folders: [],
    files: [],
  };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    for (const segment of parts.slice(0, -1)) {
      let child = folder.folders.find((candidate) => candidate.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: folder.path ? `${folder.path}/${segment}` : segment,
          folders: [],
          files: [],
        };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.files.push(file);
  }
  const sort = (folder: ReferenceFolderNode) => {
    folder.folders.sort((left, right) => left.name.localeCompare(right.name));
    folder.files.sort((left, right) => left.path.localeCompare(right.path));
    folder.folders.forEach(sort);
  };
  sort(root);
  return root;
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
    exposeHeldLogQuery = false;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderApp(
    condition: () => boolean = () =>
      container.querySelector(".viewer") !== null ||
      container.querySelector("main.state")?.textContent ===
        "This link isn't available.",
  ): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
    });
    await settle(condition);
  }

  function renderedFilePaths(): Array<string | null> {
    return [...container.querySelectorAll("button.file")]
      .map((button) => button.textContent);
  }

  function buttonNamed(name: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")]
      .find((button) => button.textContent === name) as
        | HTMLButtonElement
        | undefined;
  }

  function clickButton(name: string): void {
    const button = buttonNamed(name);
    expect(button).toBeDefined();
    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  function handoffCalls(fetchMock: ReturnType<typeof vi.fn>): Array<unknown[]> {
    return fetchMock.mock.calls.filter(
      ([input]) => requestPath(input as RequestInfo | URL) === "/api/handoff",
    );
  }

  function viewerFetch(
    handoff: (init: RequestInit | undefined) => Response | Promise<Response>,
    onDiscussionPark: (signal: AbortSignal) => void = () => undefined,
  ) {
    return vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 0,
          messages: [],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=0&hold=0&limit=100") {
        const signal = init?.signal;
        if (!signal) throw new Error("Discussion activity request has no abort signal");
        onDiscussionPark(signal);
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === "/api/handoff") return handoff(init);
      throw new Error(`Unexpected request: ${path}`);
    });
  }

  it("aborts parked Comments activity when the viewer unmounts", async () => {
    let parkedSignal: AbortSignal | undefined;
    const fetchMock = viewerFetch(
      () => jsonResponse({
        ok: true,
        code: FIRST_HANDOFF_CODE,
        relayUrl: PUBLIC_RELAY_URL,
        expiresAtMs: Date.now() + 60_000,
      }),
      (signal) => {
        parkedSignal = signal;
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => parkedSignal !== undefined);
    act(() => root?.unmount());
    root = null;

    expect(parkedSignal?.aborted).toBe(true);
  });

  it("builds the browser handoff coordinate with the canonical issuer relay", () => {
    expect(
      dohcNavigation.urlForCode(
        FIRST_HANDOFF_CODE,
        PUBLIC_RELAY_URL,
      ),
    ).toBe(
      `dohc://open/${FIRST_HANDOFF_CODE}?relay=https%3A%2F%2Frelay.example.test`,
    );
  });

  it("requires explicit consent before the first handoff request", async () => {
    const fetchMock = viewerFetch(() => jsonResponse({
      ok: true,
      code: FIRST_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(buttonNamed("Open in dohc")).toBeDefined();
    expect(handoffCalls(fetchMock)).toHaveLength(0);

    clickButton("Open in dohc");

    expect(handoffCalls(fetchMock)).toHaveLength(0);
    expect(container.textContent).toContain(
      "This opens the share in the dohc app on this computer.",
    );
    expect(container.textContent).toContain(
      "The person who shared it will see the email of the dohc account that opens it. dohc asks that account to agree first.",
    );
    expect(buttonNamed("Agree and open")).toBeDefined();
    expect(buttonNamed("Cancel")).toBeDefined();

    clickButton("Cancel");

    expect(buttonNamed("Agree and open")).toBeUndefined();
    expect(handoffCalls(fetchMock)).toHaveLength(0);

    clickButton("Open in dohc");
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);
    clickButton("Agree and open");
    await settle(() => handoffCalls(fetchMock).length === 1);

    expect(handoffCalls(fetchMock)).toHaveLength(1);
    await settle(() => navigate.mock.calls.length === 1);
  });

  it("posts only the current viewer contract and navigates with the handoff coordinate", async () => {
    const secrets = [
      SESSION,
      "cookie-sentinel",
      "https://relay.example/sync",
      "bearer-url-secret",
      "fragment-secret",
      "share-sensitive-id",
      "grant-sensitive-id",
    ];
    const fetchMock = viewerFetch(() => jsonResponse({
      ok: true,
      code: FIRST_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => navigate.mock.calls.length === 1);

    const calls = handoffCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("/api/handoff");
    const init = calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("same-origin");
    expect(init).not.toHaveProperty("body");
    expect(init?.headers).toEqual({ "x-dohc-link-session": SESSION });
    expect(Object.keys(init?.headers ?? {})).toEqual(["x-dohc-link-session"]);

    expect(navigate).toHaveBeenCalledWith(FIRST_HANDOFF_CODE, PUBLIC_RELAY_URL);
    const launchedCode = String(navigate.mock.calls[0]?.[0]);
    const launchedRelay = String(navigate.mock.calls[0]?.[1]);
    const launchUrl = dohcNavigation.urlForCode(launchedCode, launchedRelay);
    expect(launchUrl).toBe(
      `dohc://open/${FIRST_HANDOFF_CODE}?relay=https%3A%2F%2Frelay.example.test`,
    );
    for (const secret of secrets) expect(launchUrl).not.toContain(secret);
    expect(launchUrl).not.toContain("#");
    expect(() => dohcNavigation.urlForCode("bad/code", PUBLIC_RELAY_URL))
      .toThrow("invalid handoff code");
  });

  it.each([
    ["a response without ok true", { code: FIRST_HANDOFF_CODE, relayUrl: PUBLIC_RELAY_URL, expiresAtMs: Date.now() + 60_000 }],
    ["a malformed code", { ok: true, code: "short", relayUrl: PUBLIC_RELAY_URL, expiresAtMs: Date.now() + 60_000 }],
    ["a missing relay coordinate", { ok: true, code: FIRST_HANDOFF_CODE, expiresAtMs: Date.now() + 60_000 }],
    ["an empty relay coordinate", { ok: true, code: FIRST_HANDOFF_CODE, relayUrl: "", expiresAtMs: Date.now() + 60_000 }],
    ["an oversized relay coordinate", { ok: true, code: FIRST_HANDOFF_CODE, relayUrl: "x".repeat(2049), expiresAtMs: Date.now() + 60_000 }],
    ["an expired code", { ok: true, code: FIRST_HANDOFF_CODE, relayUrl: PUBLIC_RELAY_URL, expiresAtMs: Date.now() }],
    ["a non-integer expiry", { ok: true, code: FIRST_HANDOFF_CODE, relayUrl: PUBLIC_RELAY_URL, expiresAtMs: Date.now() + 60_000.5 }],
    ["an unexpected response field", { ok: true, code: FIRST_HANDOFF_CODE, relayUrl: PUBLIC_RELAY_URL, expiresAtMs: Date.now() + 60_000, extra: true }],
  ])("rejects %s", async (_label, body) => {
    const fetchMock = viewerFetch(() => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => buttonNamed("Try again") !== undefined);

    expect(container.textContent).toContain(
      "dohc couldn't prepare the app handoff. Check your connection, then choose Try again.",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows terminal reload copy for a 404 handoff refusal", async () => {
    const fetchMock = viewerFetch(() => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => container.textContent?.includes("Reload the page") === true);

    expect(container.textContent).toContain(
      "This link can't open in dohc right now. Reload the page to check the share.",
    );
    expect(buttonNamed("Try again")).toBeUndefined();
    expect(buttonNamed("Open in dohc")).toBeUndefined();
  });

  it("shows wait copy for 429 and mints a fresh code on the next open", async () => {
    let handoffRequests = 0;
    const fetchMock = viewerFetch(() => {
      handoffRequests += 1;
      return handoffRequests === 1
        ? new Response(null, { status: 429 })
        : jsonResponse({
            ok: true,
            code: SECOND_HANDOFF_CODE,
            relayUrl: PUBLIC_RELAY_URL,
            expiresAtMs: Date.now() + 60_000,
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => buttonNamed("Open in dohc") !== undefined);

    expect(container.textContent).toContain(
      "Too many attempts. Wait a minute, then choose Open in dohc again.",
    );
    expect(buttonNamed("Try again")).toBeUndefined();

    clickButton("Open in dohc");
    await settle(() => navigate.mock.calls.length === 1);

    expect(handoffCalls(fetchMock)).toHaveLength(2);
    expect(navigate).toHaveBeenCalledWith(SECOND_HANDOFF_CODE, PUBLIC_RELAY_URL);
  });

  it.each([
    ["503", () => new Response(null, { status: 503 })],
    ["network failure", () => Promise.reject(new Error("network failure"))],
  ])("retries a %s with a fresh handoff request", async (_label, fail) => {
    let handoffRequests = 0;
    const fetchMock = viewerFetch(() => {
      handoffRequests += 1;
      return handoffRequests === 1
        ? fail()
        : jsonResponse({
            ok: true,
            code: SECOND_HANDOFF_CODE,
            relayUrl: PUBLIC_RELAY_URL,
            expiresAtMs: Date.now() + 60_000,
          });
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => buttonNamed("Try again") !== undefined);

    expect(container.textContent).toContain(
      "dohc couldn't prepare the app handoff. Check your connection, then choose Try again.",
    );
    clickButton("Try again");
    await settle(() => navigate.mock.calls.length === 1);

    expect(handoffCalls(fetchMock)).toHaveLength(2);
    expect(navigate).toHaveBeenCalledWith(SECOND_HANDOFF_CODE, PUBLIC_RELAY_URL);
  });

  it("keeps post-navigation recovery visible and retries with a fresh code", async () => {
    const codes = [FIRST_HANDOFF_CODE, SECOND_HANDOFF_CODE];
    let handoffRequests = 0;
    const fetchMock = viewerFetch(() => jsonResponse({
      ok: true,
      code: codes[handoffRequests++],
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => navigate.mock.calls.length === 1);

    expect(container.textContent).toContain(
      "If dohc didn't open, install it, then choose Try again.",
    );
    clickButton("Try again");
    await settle(() => navigate.mock.calls.length === 2);

    expect(handoffCalls(fetchMock)).toHaveLength(2);
    expect(navigate.mock.calls).toEqual([
      [FIRST_HANDOFF_CODE, PUBLIC_RELAY_URL],
      [SECOND_HANDOFF_CODE, PUBLIC_RELAY_URL],
    ]);
  });

  it("does not navigate or repaint after an in-flight handoff is unmounted", async () => {
    let resolveHandoff: ((response: Response) => void) | undefined;
    let handoffSignal: AbortSignal | undefined;
    const heldHandoff = new Promise<Response>((resolve) => {
      resolveHandoff = resolve;
    });
    const fetchMock = viewerFetch((init) => {
      handoffSignal = init?.signal ?? undefined;
      return heldHandoff;
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => handoffCalls(fetchMock).length === 1);

    expect(container.textContent).toContain("Opening in dohc…");
    expect(container.textContent).toContain(
      "Your browser may ask for permission to open dohc.",
    );
    act(() => root?.unmount());
    root = null;
    resolveHandoff?.(jsonResponse({
      ok: true,
      code: FIRST_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    await settle(() => handoffSignal?.aborted === true);

    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("cancels an in-flight handoff and requires fresh consent to try again", async () => {
    let resolveFirstHandoff: ((response: Response) => void) | undefined;
    let resolveSecondHandoff: ((response: Response) => void) | undefined;
    const firstHandoff = new Promise<Response>((resolve) => {
      resolveFirstHandoff = resolve;
    });
    const secondHandoff = new Promise<Response>((resolve) => {
      resolveSecondHandoff = resolve;
    });
    const handoffSignals: AbortSignal[] = [];
    const fetchMock = viewerFetch((init) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      handoffSignals.push(signal as AbortSignal);
      return handoffSignals.length === 1 ? firstHandoff : secondHandoff;
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => handoffSignals.length === 1);

    expect(container.textContent).toContain("Opening in dohc…");
    expect(container.textContent).toContain(
      "Your browser may ask for permission to open dohc.",
    );
    expect(buttonNamed("Cancel")).toBeDefined();

    clickButton("Cancel");

    expect(handoffSignals[0]?.aborted).toBe(true);
    expect(
      [...container.querySelectorAll(".handoff-button")]
        .map((button) => button.textContent),
    ).toEqual(["Open in dohc"]);
    expect(container.textContent).not.toContain("Opening in dohc…");
    expect(buttonNamed("Agree and open")).toBeUndefined();
    expect(buttonNamed("Cancel")).toBeUndefined();

    await act(async () => {
      resolveFirstHandoff?.(jsonResponse({
        ok: true,
        code: FIRST_HANDOFF_CODE,
        relayUrl: PUBLIC_RELAY_URL,
        expiresAtMs: Date.now() + 60_000,
      }));
      await firstHandoff;
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(
      [...container.querySelectorAll(".handoff-button")]
        .map((button) => button.textContent),
    ).toEqual(["Open in dohc"]);

    clickButton("Open in dohc");

    expect(buttonNamed("Agree and open")).toBeDefined();
    expect(buttonNamed("Cancel")).toBeDefined();
    expect(handoffCalls(fetchMock)).toHaveLength(1);

    clickButton("Agree and open");
    await settle(() => handoffSignals.length === 2);

    expect(handoffSignals[1]).not.toBe(handoffSignals[0]);
    expect(handoffSignals[1]?.aborted).toBe(false);

    resolveSecondHandoff?.(jsonResponse({
      ok: true,
      code: SECOND_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    await settle(() => navigate.mock.calls.length === 1);

    expect(handoffCalls(fetchMock)).toHaveLength(2);
    expect(navigate.mock.calls).toEqual([
      [SECOND_HANDOFF_CODE, PUBLIC_RELAY_URL],
    ]);
  });

  it("does not navigate or repaint a replacement ready session", async () => {
    let resolveFirstHandoff: ((response: Response) => void) | undefined;
    let firstHandoffSignal: AbortSignal | undefined;
    const heldHandoff = new Promise<Response>((resolve) => {
      resolveFirstHandoff = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      if (path === "/api/handoff") {
        firstHandoffSignal = init?.signal ?? undefined;
        return heldHandoff;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => handoffCalls(fetchMock).length === 1);

    history.replaceState(null, "", `/s/${SECOND_SESSION}`);
    await act(async () => {
      root?.render(<App key={SECOND_SESSION} />);
    });
    await settle(() => container.querySelector(".viewer") !== null);
    resolveFirstHandoff?.(jsonResponse({
      ok: true,
      code: FIRST_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    await settle(() => firstHandoffSignal?.aborted === true);

    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Shared by a dohc user");
    expect(container.textContent).not.toContain("If dohc didn't open");
  });

  it("invalidates an in-flight handoff when the ready viewer is refused", async () => {
    vi.useFakeTimers();
    let metaRequests = 0;
    let logRequests = 0;
    let resolveHandoff: ((response: Response) => void) | undefined;
    let resolveFollower: ((response: Response) => void) | undefined;
    let handoffSignal: AbortSignal | undefined;
    const heldHandoff = new Promise<Response>((resolve) => {
      resolveHandoff = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([], 0);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        return new Response(null, { status: 404 });
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logRequests += 1;
        if (logRequests === 1) return logPage([]);
        return await new Promise<Response>((resolve) => {
          resolveFollower = resolve;
        });
      }
      if (path === "/api/handoff") {
        handoffSignal = init?.signal ?? undefined;
        return heldHandoff;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigate = vi.spyOn(dohcNavigation, "openCode")
      .mockImplementation(() => undefined);

    await renderApp();
    clickButton("Open in dohc");
    clickButton("Agree and open");
    await settle(() => handoffCalls(fetchMock).length === 1);

    resolveFollower?.(logOpsPage([], 0));
    await settle(() => container.textContent.includes("This link isn't available."));
    expect(container.textContent).toContain("This link isn't available.");

    resolveHandoff?.(jsonResponse({
      ok: true,
      code: FIRST_HANDOFF_CODE,
      relayUrl: PUBLIC_RELAY_URL,
      expiresAtMs: Date.now() + 60_000,
    }));
    await settle(() => handoffSignal?.aborted === true);

    expect(navigate).not.toHaveBeenCalled();
    expect(container.textContent).toBe("This link isn't available.");
    expect(logRequests).toBe(2);
  });

  it("renders a successful empty share instead of refusing it", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([], 0);
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

  it("retries a throttled current-state projection during the initial load", async () => {
    vi.useFakeTimers();
    let currentRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/current") {
        currentRequests += 1;
        return currentRequests === 1
          ? new Response(null, { status: 429 })
          : currentPage([], 0);
      }
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp(() => currentRequests === 1);

    expect(currentRequests).toBe(1);
    expect(container.textContent).toContain("Opening shared files");
    expect(container.textContent).not.toContain("This link isn't available.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(currentRequests).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(currentRequests).toBe(2);
    expect(container.querySelector("header")?.textContent).toContain(
      "Shared by a dohc user",
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
      if (path === "/api/view/current") return currentPage([file], 0);
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

  it("preserves the established tree shape for a large nested file set", () => {
    const files: SharedFile[] = [
      {
        path: "z-root.txt",
        blobSha256: "a".repeat(64),
        contentKind: "text",
      },
      {
        path: "a-root.txt",
        blobSha256: "b".repeat(64),
        contentKind: "text",
      },
      {
        path: "workspace-255",
        blobSha256: "c".repeat(64),
        contentKind: "text",
      },
    ];
    for (let index = 511; index >= 0; index -= 1) {
      const folder = `workspace-${index.toString().padStart(3, "0")}`;
      files.push(
        {
          path: `${folder}/zeta.txt`,
          blobSha256: "d".repeat(64),
          contentKind: "text",
        },
        {
          path: `${folder}/alpha.txt`,
          blobSha256: "e".repeat(64),
          contentKind: "text",
        },
        {
          path: `${folder}/nested-b/readme.md`,
          blobSha256: "f".repeat(64),
          contentKind: "text",
        },
        {
          path: `${folder}/nested-a/deep/data.json`,
          blobSha256: "0".repeat(64),
          contentKind: "text",
        },
      );
    }

    const tree = fileTree(files);

    expect(tree).toEqual(quadraticReferenceFileTree(files));
    expect(tree.folders).toHaveLength(512);
    expect(tree.files).toHaveLength(3);
  });

  it("cancels an in-flight current-state load on unmount", async () => {
    const currentPaths: string[] = [];
    let currentSignal: AbortSignal | undefined;
    let releaseCurrent: (() => void) | undefined;
    const currentHeld = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") {
        currentPaths.push(path);
        currentSignal = init?.signal ?? undefined;
        await currentHeld;
        return currentPage([], 1);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    root = createRoot(container);
    await act(async () => {
      root?.render(<App />);
      await Promise.resolve();
    });
    expect(currentPaths).toEqual(["/api/view/current"]);

    act(() => root?.unmount());
    root = null;
    releaseCurrent?.();
    await settle(() => currentSignal?.aborted === true);

    expect(currentPaths).toEqual(["/api/view/current"]);
    expect(currentSignal).toBeInstanceOf(AbortSignal);
    expect(currentSignal?.aborted).toBe(true);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("aborts the current-state request when the initial viewer unmounts", async () => {
    let currentSignal: AbortSignal | undefined;
    let currentAborts = 0;
    let releaseCurrent: ((response: Response) => void) | undefined;
    let rejectCurrent: ((reason: unknown) => void) | undefined;
    const currentHeld = new Promise<Response>((resolve, reject) => {
      releaseCurrent = resolve;
      rejectCurrent = reject;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") {
        currentSignal = init?.signal ?? undefined;
        currentSignal?.addEventListener("abort", () => {
          currentAborts += 1;
          rejectCurrent?.(new DOMException("The request was aborted.", "AbortError"));
        }, { once: true });
        return currentHeld;
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
    releaseCurrent?.(currentPage([]));
    await settle(() => currentSignal?.aborted === true && currentAborts === 1);

    expect(currentSignal).toBeInstanceOf(AbortSignal);
    expect(currentSignal?.aborted).toBe(true);
    expect(currentAborts).toBe(1);
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
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response("# Shared file");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const currentRequestInit = requestInits.get("/api/view/current");
    expect(currentRequestInit).toMatchObject({
      credentials: "same-origin",
      headers: { "x-dohc-link-session": SESSION },
    });
    const logRequestInit = requestInits.get("/api/view/log?since=0&limit=500");
    expect(logRequestInit).toMatchObject({
      credentials: "same-origin",
      headers: { "x-dohc-link-session": SESSION },
    });
    expect(currentRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(logRequestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(currentRequestInit?.signal).toBe(logRequestInit?.signal);
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
      if (path === "/api/view/current") return currentPage([], 0, 0, meta);
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
      if (path === "/api/view/current") {
        return currentPage([readme, target], 0, 0, {
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

  it("refreshes a stale selected-file hash without replacing the viewer", async () => {
    const staleFile: SharedFile = {
      path: "readme.md",
      blobSha256: "9".repeat(64),
      contentKind: "text",
    };
    const currentFile: SharedFile = {
      ...staleFile,
      blobSha256: "8".repeat(64),
    };
    const changedFileOp: RelayOp = {
      relaySeq: 2,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadBeforePath: staleFile.path,
        payloadBeforeBlobSha256: staleFile.blobSha256,
        payloadAfterPath: currentFile.path,
        payloadAfterBlobSha256: currentFile.blobSha256,
        payloadAfterContentKind: currentFile.contentKind,
      },
      recordedAtMs: 2,
    };
    let metaRequests = 0;
    let currentRequests = 0;
    const logPaths: string[] = [];
    let releaseRefresh: (() => void) | undefined;
    const refreshHeld = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        if (metaRequests > 1) await refreshHeld;
        return jsonResponse(DEFAULT_META);
      }
      if (path === "/api/view/current") {
        currentRequests += 1;
        if (currentRequests > 1) await refreshHeld;
        return currentRequests === 1
          ? currentPage([staleFile], 0)
          : currentPage([currentFile], 2);
      }
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([staleFile]);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        await refreshHeld;
        return logOpsPage([changedFileOp], 2);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        return logOpsPage([], 2);
      }
      if (path === `/api/view/blob/${staleFile.blobSha256}`) {
        return new Response(null, { status: 404 });
      }
      if (path === `/api/view/blob/${currentFile.blobSha256}`) {
        return new Response("# Current file\n\nRecovered with the new hash.");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => {
      const text = container.querySelector("main.content .file-status")?.textContent ??
        container.querySelector("main.content .state")?.textContent;
      return text === "This link isn't available." ||
        text === "This file changed. Refreshing.";
    });

    const content = container.querySelector("main.content");
    expect(content?.textContent).toBe("This file changed. Refreshing.");
    expect(content?.querySelector(".file-status")?.textContent).toBe(
      "This file changed. Refreshing.",
    );
    expect(container.querySelector("header")?.textContent).toContain(
      "Shared by a dohc user",
    );
    expect(container.querySelector("h1")?.textContent).toBe(staleFile.path);
    expect(container.querySelector(".badge")?.textContent).toBe("View");
    expect(container.querySelector('nav[aria-label="Shared files"]')?.textContent)
      .toContain(staleFile.path);
    expect(metaRequests).toBe(0);
    expect(logPaths).toContain("/api/view/log?since=1&limit=500");

    releaseRefresh?.();
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Recovered with the new hash.") === true
    );

    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Recovered with the new hash.",
    );
    expect(container.querySelector("main.content .file-status")).toBeNull();
  });

  it("reports a selected file unavailable when its immediate refresh keeps the stale hash", async () => {
    const file: SharedFile = {
      path: "readme.md",
      blobSha256: "9".repeat(64),
      contentKind: "text",
    };
    let metaRequests = 0;
    const logPaths: string[] = [];
    let blobRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaRequests += 1;
        return jsonResponse(DEFAULT_META);
      }
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === "/api/view/log?since=1&limit=500") {
        return logOpsPage([], 1);
      }
      if (path === `/api/view/blob/${file.blobSha256}`) {
        blobRequests += 1;
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() =>
      container.querySelector("main.content .file-status")?.textContent ===
        "This file isn't available right now."
    );

    expect(container.querySelector("main.content .file-status")?.textContent).toBe(
      "This file isn't available right now.",
    );
    expect(container.querySelector("header")?.textContent).toContain(
      "Shared by a dohc user",
    );
    expect(container.querySelector('nav[aria-label="Shared files"]')?.textContent)
      .toContain(file.path);
    expect({ metaRequests, logPaths, blobRequests }).toEqual({
      metaRequests: 1,
      logPaths: [
        "/api/view/log?since=0&limit=500",
        "/api/view/log?since=1&limit=500",
        "/api/view/log?since=0&limit=500",
        "/api/view/log?since=1&limit=500",
      ],
      blobRequests: 1,
    });
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      "This file isn't available right now.",
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
      if (path === "/api/view/current") {
        return currentPage([firstFile, secondFile], 0);
      }
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
      if (path === "/api/view/current") {
        return currentPage([firstFile, secondFile], 0);
      }
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
      if (path === "/api/view/current") return currentPage([], 0);
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
      if (path === "/api/view/current") return currentPage([]);
      if (path === "/api/view/log?since=0&limit=500") return logOpsPage([], 0);
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
    await settle(() => location.pathname === `/s/${SESSION}`);

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
      if (path === "/api/view/current") return currentPage([], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([]);
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp(() => exchangeBodies.length === 1);

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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      if (path === "/api/view/current") return currentPage([file], 0);
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

  it("reports an exhausted download retry budget and clears the message on the next attempt", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "payload.bin",
      blobSha256: "5".repeat(64),
      contentKind: "binary",
    };
    const downloadPath = `/api/view/blob/${file.blobSha256}`;
    let downloadRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === downloadPath) {
        downloadRequests += 1;
        return new Response(null, { status: 429 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    const visibleDownload = container.querySelector("a[download]");
    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(downloadRequests).toBe(12);
    expect(container.querySelector(".download-error")?.textContent).toBe(
      "The download didn't finish. Try again.",
    );

    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(downloadRequests).toBe(13);
    expect(container.querySelector(".download-error")).toBeNull();
  });

  it("reports a non-rate-limited download failure until the next attempt", async () => {
    const file: SharedFile = {
      path: "payload.bin",
      blobSha256: "6".repeat(64),
      contentKind: "binary",
    };
    const downloadPath = `/api/view/blob/${file.blobSha256}`;
    let downloadRequests = 0;
    let secondSignal: AbortSignal | undefined;
    const secondRequestHeld = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === downloadPath) {
        downloadRequests += 1;
        if (downloadRequests === 1) {
          return new Response(null, { status: 503 });
        }
        secondSignal = init?.signal ?? undefined;
        return secondRequestHeld;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    const visibleDownload = container.querySelector("a[download]");
    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await settle(() =>
      container.querySelector(".download-error")?.textContent ===
        "The download didn't finish. Try again."
    );

    expect(downloadRequests).toBe(1);
    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(downloadRequests).toBe(2);
    expect(secondSignal).toBeInstanceOf(AbortSignal);
    expect(container.querySelector(".download-error")).toBeNull();
  });

  it("does not report a deliberately cancelled download", async () => {
    const file: SharedFile = {
      path: "payload.bin",
      blobSha256: "7".repeat(64),
      contentKind: "binary",
    };
    const downloadPath = `/api/view/blob/${file.blobSha256}`;
    const downloadSignals: AbortSignal[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === downloadPath) {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected a download abort signal");
        downloadSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(new DOMException("The request was aborted.", "AbortError"));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    const visibleDownload = container.querySelector("a[download]");
    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await settle(() => downloadSignals.length === 1);

    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    await settle(() =>
      downloadSignals.length === 2 && downloadSignals[0]?.aborted === true
    );

    expect(container.querySelector(".download-error")).toBeNull();
  });

  it("cancels a throttled download retry when the viewer unmounts", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "payload.bin",
      blobSha256: "4".repeat(64),
      contentKind: "binary",
    };
    const downloadPath = `/api/view/blob/${file.blobSha256}`;
    const downloadRequests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === downloadPath) {
        downloadRequests.push(path);
        return downloadRequests.length === 1
          ? new Response(null, { status: 429 })
          : new Response("stale file bytes");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const createObjectUrl = vi.spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:stale-download");
    const appendedAnchors: HTMLAnchorElement[] = [];
    const append = vi.spyOn(document.body, "append")
      .mockImplementation((...nodes) => {
        for (const node of nodes) {
          if (node instanceof HTMLAnchorElement) appendedAnchors.push(node);
        }
      });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const visibleDownload = container.querySelector("a[download]");

    await act(async () => {
      visibleDownload?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(downloadRequests).toEqual([downloadPath]);

    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect({
      downloadRequests,
      createObjectUrlCalls: createObjectUrl.mock.calls.length,
      appendedAnchorCount: appendedAnchors.length,
      appendCalls: append.mock.calls.length,
      clickCalls: click.mock.calls.length,
    }).toEqual({
      downloadRequests: [downloadPath],
      createObjectUrlCalls: 0,
      appendedAnchorCount: 0,
      appendCalls: 0,
      clickCalls: 0,
    });
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
      if (path === "/api/view/current") return currentPage([file], 0, 0, meta);
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

  it("follows log deltas from the last cursor", async () => {
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
      if (path === "/api/view/current") return currentPage([file], 17);
      if (path.startsWith("/api/view/log?")) {
        logPaths.push(path);
        return logOpsPage([], 17);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(logPaths).toEqual([
      "/api/view/log?since=17&limit=500",
      "/api/view/log?since=17&limit=500",
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(logPaths).toEqual([
      "/api/view/log?since=17&limit=500",
      "/api/view/log?since=17&limit=500",
      "/api/view/log?since=17&limit=500",
    ]);
  });

  it("rebuilds the file tree when the follower observes a new epoch floor", async () => {
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
    const rotatedFile = { ...survivingFile, blobSha256: "6".repeat(64) };
    const logPaths: string[] = [];
    let currentRequests = 0;
    let sinceSevenRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") {
        currentRequests += 1;
        return currentRequests === 1
          ? currentPage([removedFile, survivingFile], 7, 0)
          : currentPage([rotatedFile], 11, 10);
      }
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=7&limit=500") {
        sinceSevenRequests += 1;
        return sinceSevenRequests === 1
          ? logOpsPage([], 7, false, 0)
          : logOpsPage([], 11, false, 10);
      }
      if (path === "/api/view/log?since=11&limit=500") {
        return logOpsPage([], 11, false, 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    expect(renderedFilePaths()).toEqual(["survives.txt"]);
    const survivingButton = [...container.querySelectorAll("button.file")]
      .find((button) => button.textContent === "survives.txt");
    await act(async () => {
      survivingButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(renderedFilePaths()).toEqual(["survives.txt"]);
    expect(container.querySelector("h1")?.textContent).toBe("survives.txt");
    expect(logPaths).toEqual(expect.arrayContaining([
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=11&limit=500",
    ]));
  });

  it("renders the next Markdown settlement after an epoch reload", async () => {
    vi.useFakeTimers();
    const initialFile: SharedFile = {
      path: "guide.md",
      blobSha256: "a".repeat(64),
      contentKind: "text",
    };
    const changedFile: SharedFile = {
      ...initialFile,
      blobSha256: "b".repeat(64),
    };
    const changedOps: RelayOp[] = [{
      relaySeq: 12,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadBeforePath: initialFile.path,
        payloadBeforeBlobSha256: initialFile.blobSha256,
        payloadAfterPath: changedFile.path,
        payloadAfterBlobSha256: changedFile.blobSha256,
        payloadAfterContentKind: changedFile.contentKind,
      },
      recordedAtMs: 3,
    }];
    const logPaths: string[] = [];
    let currentRequests = 0;
    let sinceSevenRequests = 0;
    let sinceElevenRequests = 0;
    let initialBlobRequests = 0;
    let changedBlobRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") {
        currentRequests += 1;
        return currentRequests === 1
          ? currentPage([initialFile], 7, 0)
          : currentPage([initialFile], 11, 10);
      }
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=7&limit=500") {
        sinceSevenRequests += 1;
        return sinceSevenRequests === 1
          ? logOpsPage([], 7, false, 0)
          : logOpsPage([], 10, false, 10);
      }
      if (path === "/api/view/log?since=11&limit=500") {
        sinceElevenRequests += 1;
        return sinceElevenRequests === 1
          ? logOpsPage([], 11, false, 10)
          : logOpsPage(changedOps, 12, false, 10);
      }
      if (path === "/api/view/log?since=12&limit=500") {
        return logOpsPage([], 12, false, 10);
      }
      if (path === `/api/view/blob/${initialFile.blobSha256}`) {
        initialBlobRequests += 1;
        return new Response("# Initial preview");
      }
      if (path === `/api/view/blob/${changedFile.blobSha256}`) {
        changedBlobRequests += 1;
        return new Response("# Changed preview");
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    expect(initialBlobRequests).toBe(1);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Changed preview",
    );
    expect(changedBlobRequests).toBe(1);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Changed preview",
    );
    expect(logPaths).toEqual([
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=11&limit=500",
      "/api/view/log?since=11&limit=500",
      "/api/view/log?since=12&limit=500",
    ]);
  });

  it("folds followed renames, additions, and deletions onto the initial files", async () => {
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
    const firstWriteSha = "3".repeat(64);
    const divergentWriteSha = "4".repeat(64);
    const survivingWriteSha = "5".repeat(64);
    const createdSha = "6".repeat(64);
    const divergentRenameSha = "7".repeat(64);
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
          payloadBeforeBlobSha256: fileB.blobSha256,
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
          payloadBeforePath: null,
          payloadBeforeBlobSha256: null,
          payloadAfterPath: "c.txt",
          payloadAfterBlobSha256: createdSha,
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 3,
      },
      {
        relaySeq: 4,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadBeforePath: fileA.path,
          payloadBeforeBlobSha256: fileA.blobSha256,
          payloadAfterPath: fileA.path,
          payloadAfterBlobSha256: firstWriteSha,
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 4,
      },
      {
        relaySeq: 5,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadBeforePath: fileA.path,
          payloadBeforeBlobSha256: fileA.blobSha256,
          payloadAfterPath: fileA.path,
          payloadAfterBlobSha256: divergentWriteSha,
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 5,
      },
      {
        relaySeq: 6,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadBeforePath: fileA.path,
          payloadBeforeBlobSha256: firstWriteSha,
          payloadAfterPath: fileA.path,
          payloadAfterBlobSha256: survivingWriteSha,
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 6,
      },
      {
        relaySeq: 7,
        opKind: "moment.append",
        payload: {
          operation: "rename",
          payloadBeforePath: "renamed-b.txt",
          payloadBeforeBlobSha256: divergentRenameSha,
          payloadAfterPath: "losing-b.txt",
          payloadAfterBlobSha256: fileB.blobSha256,
          payloadAfterContentKind: fileB.contentKind,
        },
        recordedAtMs: 7,
      },
      {
        relaySeq: 8,
        opKind: "moment.append",
        payload: {
          operation: "rename",
          payloadBeforePath: "renamed-b.txt",
          payloadBeforeBlobSha256: fileB.blobSha256,
          payloadAfterPath: "final-b.txt",
          payloadAfterBlobSha256: fileB.blobSha256,
          payloadAfterContentKind: fileB.contentKind,
        },
        recordedAtMs: 8,
      },
    ];
    const deleteOps: RelayOp[] = [
      {
        relaySeq: 9,
        opKind: "moment.append",
        payload: {
          operation: "delete",
          payloadBeforePath: fileA.path,
          payloadBeforeBlobSha256: fileA.blobSha256,
          path: fileA.path,
        },
        recordedAtMs: 9,
      },
      {
        relaySeq: 10,
        opKind: "moment.append",
        payload: {
          operation: "delete",
          payloadBeforePath: "c.txt",
          payloadBeforeBlobSha256: createdSha,
          path: "c.txt",
        },
        recordedAtMs: 10,
      },
    ];
    const logPaths: string[] = [];
    let sinceOneRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage([fileA, fileB], 1);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=1&limit=500") {
        sinceOneRequests += 1;
        return sinceOneRequests === 1
          ? logOpsPage([], 1)
          : logOpsPage(deltaOps, 8);
      }
      if (path === "/api/view/log?since=8&limit=500") {
        return logOpsPage(deleteOps, 10);
      }
      if (path === "/api/view/log?since=10&limit=500") {
        return logOpsPage([], 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    const afterDelete = filesFromLog([...initialOps, ...deltaOps, ...deleteOps])
      .map((file) => file.path);
    expect(afterDelete).toEqual(["a.txt", "final-b.txt"]);
    expect(renderedFilePaths()).toEqual(afterDelete);
    expect(logPaths).toEqual([
      "/api/view/log?since=1&limit=500",
      "/api/view/log?since=1&limit=500",
      "/api/view/log?since=8&limit=500",
      "/api/view/log?since=10&limit=500",
    ]);
  });

  it("opens from current state without requesting historical log pages", async () => {
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
          payloadBeforeBlobSha256: fileB.blobSha256,
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
          payloadBeforeBlobSha256: fileA.blobSha256,
        },
        recordedAtMs: 3,
      },
      {
        relaySeq: 10,
        opKind: "moment.append",
        payload: {
          operation: "write",
          payloadBeforePath: null,
          payloadBeforeBlobSha256: null,
          payloadAfterPath: "new.txt",
          payloadAfterBlobSha256: "6".repeat(64),
          payloadAfterContentKind: "text",
        },
        recordedAtMs: 4,
      },
    ];
    const logPaths: string[] = [];
    const fullReplay = filesFromLog([...firstPageOps, ...secondPageOps]);
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") return jsonResponse(DEFAULT_META);
      if (path === "/api/view/current") return currentPage(fullReplay, 10);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=10&limit=500") {
        return logOpsPage([], 10);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(fullReplay.map((file) => file.path)).toEqual(["new.txt", "renamed.txt"]);
    expect(renderedFilePaths()).toEqual(fullReplay.map((file) => file.path));
    expect(logPaths).toEqual([
      "/api/view/log?since=10&limit=500",
      "/api/view/log?since=10&limit=500",
    ]);
  });

  it("applies the first forward page before the current projection becomes ready", async () => {
    const initialFile: SharedFile = {
      path: "before.txt",
      blobSha256: "4".repeat(64),
      contentKind: "text",
    };
    const renamedFile: SharedFile = {
      ...initialFile,
      path: "after.txt",
    };
    const logPaths: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([initialFile], 7);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=7&limit=500") {
        return logOpsPage([{
          relaySeq: 8,
          opKind: "moment.append",
          payload: {
            operation: "rename",
            payloadBeforePath: initialFile.path,
            payloadBeforeBlobSha256: initialFile.blobSha256,
            payloadAfterPath: renamedFile.path,
            payloadAfterBlobSha256: renamedFile.blobSha256,
            payloadAfterContentKind: renamedFile.contentKind,
          },
          recordedAtMs: 8,
        }], 8);
      }
      if (path === "/api/view/log?since=8&limit=500") {
        return logOpsPage([], 8);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(renderedFilePaths()).toEqual([renamedFile.path]);
    expect(logPaths).toEqual([
      "/api/view/log?since=7&limit=500",
      "/api/view/log?since=8&limit=500",
    ]);
  });

  it.each([
    ["duplicate file paths", {
      ...DEFAULT_META,
      ok: true,
      files: [
        { path: "same.txt", blobSha256: "1".repeat(64), contentKind: "text" },
        { path: "same.txt", blobSha256: "2".repeat(64), contentKind: "text" },
      ],
      nextCursor: 2,
      epochLogFloor: 0,
    }],
    ["a cursor below the epoch floor", {
      ...DEFAULT_META,
      ok: true,
      files: [],
      nextCursor: 1,
      epochLogFloor: 2,
    }],
    ["an unsupported access level", {
      ...DEFAULT_META,
      ok: true,
      access: "edit",
      files: [],
      nextCursor: 0,
      epochLogFloor: 0,
    }],
    ["an invalid file digest", {
      ...DEFAULT_META,
      ok: true,
      files: [{ path: "bad.txt", blobSha256: "short", contentKind: "text" }],
      nextCursor: 1,
      epochLogFloor: 0,
    }],
  ])("rejects current state with %s", async (_label, projection) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return jsonResponse(projection);
      throw new Error(`Unexpected request: ${path}`);
    }));

    await expect(loadCurrentState(SESSION)).rejects.toThrow("refused");
  });

  it.each([
    ["a non-boolean continuation flag", {
      ops: [], nextCursor: 1, hasMore: "false", epochLogFloor: 0,
    }],
    ["an unsafe operation sequence", {
      ops: [{ relaySeq: Number.MAX_SAFE_INTEGER + 1, opKind: "moment.append", payload: {}, recordedAtMs: 1 }],
      nextCursor: 1,
      hasMore: false,
      epochLogFloor: 0,
    }],
    ["an unsupported operation kind", {
      ops: [{ relaySeq: 1, opKind: "unknown", payload: {}, recordedAtMs: 1 }],
      nextCursor: 1,
      hasMore: false,
      epochLogFloor: 0,
    }],
    ["an unsafe operation timestamp", {
      ops: [{ relaySeq: 1, opKind: "moment.append", payload: {}, recordedAtMs: 1.5 }],
      nextCursor: 1,
      hasMore: false,
      epochLogFloor: 0,
    }],
    ["a stale operation sequence", {
      ops: [{ relaySeq: 0, opKind: "moment.append", payload: {}, recordedAtMs: 1 }],
      nextCursor: 1,
      hasMore: false,
      epochLogFloor: 0,
    }],
    ["operations outside strict relay order", {
      ops: [
        { relaySeq: 2, opKind: "moment.append", payload: {}, recordedAtMs: 1 },
        { relaySeq: 1, opKind: "moment.append", payload: {}, recordedAtMs: 1 },
      ],
      nextCursor: 2,
      hasMore: false,
      epochLogFloor: 0,
    }],
    ["an operation beyond the page cursor", {
      ops: [{ relaySeq: 2, opKind: "moment.append", payload: {}, recordedAtMs: 1 }],
      nextCursor: 1,
      hasMore: false,
      epochLogFloor: 0,
    }],
  ])("rejects %s", async (_label, page) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(page)));

    await expect(loadLog(SESSION, 0, new Map(), 1)).rejects.toThrow("refused");
  });

  it("rejects a forward load when the epoch floor changes between pages", async () => {
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

    await expect(loadLog(
      SESSION,
      5,
      new Map([[priorEpochFile.path, priorEpochFile]]),
      3,
    )).rejects.toThrow("epoch floor changed");
    expect(logPaths).toEqual([
      "/api/view/log?since=5&limit=500",
      "/api/view/log?since=6&limit=500",
    ]);
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

  it("renders quiet and hard-triggered settlements through the ordinary View follower", async () => {
    vi.useFakeTimers();
    exposeHeldLogQuery = true;
    const startedAt = new Date("2026-08-27T00:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const initialFile: SharedFile = {
      path: "readme.md",
      blobSha256: "1".repeat(64),
      contentKind: "text",
    };
    const quietFile: SharedFile = {
      ...initialFile,
      blobSha256: "2".repeat(64),
    };
    const hardFile: SharedFile = {
      ...initialFile,
      blobSha256: "3".repeat(64),
    };
    const staleFile: SharedFile = {
      ...initialFile,
      blobSha256: "5".repeat(64),
    };
    const recoveredFile: SharedFile = {
      ...initialFile,
      blobSha256: "4".repeat(64),
    };
    const write = (
      relaySeq: number,
      before: SharedFile,
      after: SharedFile,
    ): RelayOp => ({
      relaySeq,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadBeforePath: before.path,
        payloadBeforeBlobSha256: before.blobSha256,
        payloadAfterPath: after.path,
        payloadAfterBlobSha256: after.blobSha256,
        payloadAfterContentKind: after.contentKind,
      },
      recordedAtMs: Date.now(),
    });
    type HeldLog = {
      allowLateResolution: boolean;
      path: string;
      reject: (error: unknown) => void;
      resolve: (response: Response) => void;
      settled: boolean;
      signal: AbortSignal;
    };
    const trace: string[] = [];
    const heldLogs: HeldLog[] = [];
    const reasons: SettlementReason[] = [];
    let currentRequests = 0;
    let metadataRequests = 0;
    let initialCatchupRequests = 0;
    let staleBlobResolve: ((response: Response) => void) | undefined;

    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      trace.push(`request:${path}`);
      if (path === "/api/view/current") {
        currentRequests += 1;
        return currentRequests === 1
          ? currentPage([initialFile], 1)
          : currentPage([recoveredFile], 4, 0, {
              ...DEFAULT_META,
              lastSettledAtMs: Date.now(),
            });
      }
      if (path === "/api/view/log?since=1&limit=500") {
        initialCatchupRequests += 1;
        return logOpsPage([], 1);
      }
      if (path === "/api/view/log?since=4&limit=500") {
        return logOpsPage([], 4);
      }
      if (/^\/api\/view\/log\?since=\d+&limit=500&hold=30000$/u.test(path)) {
        const signal = init?.signal;
        if (!signal) throw new Error("held log request has no abort signal");
        return await new Promise<Response>((resolve, reject) => {
          const held: HeldLog = {
            allowLateResolution: false,
            path,
            reject,
            resolve: (response) => {
              if (held.settled) return;
              held.settled = true;
              trace.push(`resolve:${path}`);
              resolve(response);
            },
            settled: false,
            signal,
          };
          signal.addEventListener("abort", () => {
            if (held.settled || held.allowLateResolution) return;
            held.settled = true;
            trace.push(`abort:${path}`);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
          heldLogs.push(held);
          trace.push(`park:${path}`);
        });
      }
      if (path === "/api/view/meta") {
        metadataRequests += 1;
        trace.push(`meta:${String(metadataRequests)}`);
        return jsonResponse({
          ...DEFAULT_META,
          lastSettledAtMs: Date.now(),
        });
      }
      if (path === `/api/view/blob/${initialFile.blobSha256}`) {
        return new Response("# Initial settlement");
      }
      if (path === `/api/view/blob/${quietFile.blobSha256}`) {
        return new Response("# Quiet settlement");
      }
      if (path === `/api/view/blob/${hardFile.blobSha256}`) {
        return new Response("# Hard-limit settlement");
      }
      if (path === `/api/view/blob/${staleFile.blobSha256}`) {
        return await new Promise<Response>((resolve) => {
          staleBlobResolve = resolve;
        });
      }
      if (path === `/api/view/blob/${recoveredFile.blobSha256}`) {
        return new Response("# Recovered current settlement");
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 0,
          messages: [],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=0&hold=0&limit=100") {
        const signal = init?.signal;
        if (!signal) throw new Error("discussion park has no abort signal");
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const scheduler = createSettlementScheduler({
      hardTriggerMs: SETTLEMENT_END_TO_END_MAX_MS - 1,
      now: () => Date.now(),
      onEvent: () => undefined,
      settle: (reason) => {
        reasons.push(reason);
        trace.push(`publish:${reason}`);
        const parked = [...heldLogs].reverse().find((held) => !held.settled);
        if (!parked) throw new Error(`no parked View follower for ${reason}`);
        if (reason === "quiet") {
          parked.resolve(logOpsPage([write(2, initialFile, quietFile)], 2));
        } else if (reason === "hard-limit") {
          parked.resolve(logOpsPage([write(3, quietFile, hardFile)], 3));
        } else {
          throw new Error(`unexpected settlement reason: ${reason}`);
        }
      },
    });

    await renderApp();
    const mountedViewer = container.querySelector(".viewer");
    await settle(() =>
      heldLogs.some((held) =>
        held.path === "/api/view/log?since=1&limit=500&hold=30000" &&
        !held.settled
      )
    );
    expect(initialCatchupRequests).toBe(1);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Initial settlement",
    );
    expect(metadataRequests).toBe(0);

    scheduler.markDirty(Date.now());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(799);
    });
    expect(reasons).toEqual([]);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Initial settlement",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Quiet settlement") === true
    );
    expect(reasons).toEqual(["quiet"]);
    expect(heldLogs.some((held) =>
      held.path === "/api/view/log?since=2&limit=500&hold=30000" &&
      !held.settled
    )).toBe(true);
    expect(container.querySelector(".viewer")).toBe(mountedViewer);
    const quietPublish = trace.indexOf("publish:quiet");
    const quietMeta = trace.indexOf("meta:1");
    expect(quietMeta).toBeGreaterThan(quietPublish);

    const hardWindowStartedAt = Date.now();
    scheduler.markDirty(hardWindowStartedAt);
    for (let index = 0; index < 6; index += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(799);
      });
      scheduler.markDirty(Date.now());
      expect(reasons).toEqual(["quiet"]);
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(205);
    });
    expect(Date.now() - hardWindowStartedAt).toBe(
      SETTLEMENT_END_TO_END_MAX_MS - 1,
    );
    expect(Date.now() - hardWindowStartedAt).toBeLessThan(5_000);
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Hard-limit settlement") === true
    );
    expect(Date.now() - hardWindowStartedAt).toBeLessThan(5_000);
    await settle(() =>
      heldLogs.some((held) =>
        held.path === "/api/view/log?since=3&limit=500&hold=30000" &&
        !held.settled
      )
    );
    expect(reasons).toEqual(["quiet", "hard-limit"]);
    const hardPublish = trace.indexOf("publish:hard-limit");
    const hardMeta = trace.indexOf("meta:2");
    expect(hardMeta).toBeGreaterThan(hardPublish);

    const staleFollower = [...heldLogs].reverse().find((held) =>
      held.path === "/api/view/log?since=3&limit=500&hold=30000" &&
      !held.settled
    );
    staleFollower?.resolve(logOpsPage([write(4, hardFile, staleFile)], 4));
    await settle(() => staleBlobResolve !== undefined);
    await settle(() =>
      heldLogs.some((held) =>
        held.path === "/api/view/log?since=4&limit=500&hold=30000" &&
        !held.settled
      )
    );
    staleBlobResolve?.(new Response(null, { status: 404 }));
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Recovered current settlement") === true
    );
    expect(currentRequests).toBe(2);
    expect(trace).toContain(
      "abort:/api/view/log?since=4&limit=500&hold=30000",
    );
    expect(heldLogs.some((held) =>
      held.path === "/api/view/log?since=4&limit=500&hold=30000" &&
      !held.settled
    )).toBe(true);
    expect(container.querySelector(".viewer")).toBe(mountedViewer);

    const personVisibleNetworkTrace = trace
      .filter((entry) => entry.startsWith("request:"))
      .join("\n");
    expect(personVisibleNetworkTrace).not.toMatch(
      /live-session|ticket|ydoc|websocket|presence/iu,
    );

    const abandoned = [...heldLogs].reverse().find((held) => !held.settled);
    expect(abandoned?.path).toBe(
      "/api/view/log?since=4&limit=500&hold=30000",
    );
    abandoned!.allowLateResolution = true;
    act(() => root?.unmount());
    root = null;
    expect(abandoned?.signal.aborted).toBe(true);
    const traceLengthAtUnmount = trace.length;
    abandoned?.resolve(logOpsPage([write(5, recoveredFile, hardFile)], 5));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(trace).toHaveLength(traceLengthAtUnmount + 1);
    expect(trace.at(-1)).toBe(
      "resolve:/api/view/log?since=4&limit=500&hold=30000",
    );
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows files, then aborts the next held request on unmount", async () => {
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
    let sinceOneRequests = 0;
    let resolveSettlement: ((response: Response) => void) | undefined;
    let parkedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/meta") {
        metaPaths.push(path);
        return jsonResponse({
          ...DEFAULT_META,
          lastSettledAtMs: Date.now(),
        });
      }
      if (path === "/api/view/current") return currentPage([initialFile], 1);
      if (path.startsWith("/api/view/log?")) logPaths.push(path);
      if (path === "/api/view/log?since=0&limit=500") {
        return logPage([initialFile]);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        sinceOneRequests += 1;
        if (sinceOneRequests === 1) return logOpsPage([], 1);
        return await new Promise<Response>((resolve) => {
          resolveSettlement = resolve;
        });
      }
      if (path === "/api/view/log?since=2&limit=500") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          parkedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();

    expect(metaPaths).toHaveLength(0);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "No settled changes",
    );
    expect(renderedFilePaths()).toEqual(["zeta.txt"]);
    expect(container.querySelector("h1")?.textContent).toBe("zeta.txt");

    resolveSettlement?.(logOpsPage([addedFileOp], 2));
    await settle(() => renderedFilePaths().includes(addedFile.path));

    expect({
      files: renderedFilePaths(),
      freshness: container.querySelector(".freshness")?.textContent,
    }).toEqual({
      files: ["alpha.txt", "zeta.txt"],
      freshness: "Last settled now",
    });
    expect(metaPaths).toHaveLength(1);
    expect(logPaths).toHaveLength(3);
    expect(container.querySelector("h1")?.textContent).toBe("zeta.txt");

    expect(metaPaths).toHaveLength(1);
    expect(logPaths).toHaveLength(3);
    act(() => root?.unmount());
    root = null;
    expect(parkedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an in-flight follower log scan on teardown", async () => {
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
    await settle(() => heartbeatSignal !== undefined);
    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=1&limit=500",
    ]);

    act(() => root?.unmount());
    root = null;
    releaseHeartbeatPage?.();
    await settle(() => heartbeatSignal?.aborted === true);

    expect(logPaths).toEqual([
      "/api/view/log?since=0&limit=500",
      "/api/view/log?since=1&limit=500",
    ]);
    expect(heartbeatSignal).toBeInstanceOf(AbortSignal);
    expect(heartbeatSignal?.aborted).toBe(true);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("cancels an in-flight follower meta request on teardown", async () => {
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
        heartbeatMetaSignal = init?.signal ?? undefined;
        heartbeatMetaSignal?.addEventListener("abort", () => {
          metaAborts += 1;
          rejectHeartbeatMeta?.(
            new DOMException("The request was aborted.", "AbortError"),
          );
        }, { once: true });
        return heartbeatMetaHeld;
      }
      if (path === "/api/view/current") return currentPage([file], 0);
      if (path === "/api/view/log?since=0&limit=500") return logPage([file]);
      if (path === "/api/view/log?since=1&limit=500") {
        heartbeatLogSignal = init?.signal ?? undefined;
        return logOpsPage([], 1);
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => heartbeatMetaSignal !== undefined);

    expect(metaRequests).toBe(1);
    expect(heartbeatMetaSignal).toBeInstanceOf(AbortSignal);
    expect(heartbeatMetaSignal).toBe(heartbeatLogSignal);

    act(() => root?.unmount());
    root = null;
    await settle(
      () => heartbeatMetaSignal?.aborted === true && metaAborts === 1,
    );

    expect(heartbeatMetaSignal?.aborted).toBe(true);
    expect(metaAborts).toBe(1);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("falls back to the first file when the follower renames the selected file", async () => {
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
        payloadBeforeBlobSha256: selectedFile.blobSha256,
        payloadAfterPath: renamedFile.path,
        payloadAfterBlobSha256: renamedFile.blobSha256,
        payloadAfterContentKind: renamedFile.contentKind,
      },
      recordedAtMs: 3,
    };
    let metaRequests = 0;
    let logRequests = 0;
    let sinceTwoRequests = 0;
    let resolveRename: ((response: Response) => void) | undefined;
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
      if (path === "/api/view/current") {
        return currentPage([firstFile, selectedFile], 2);
      }
      if (path === "/api/view/log?since=0&limit=500") {
        logRequests += 1;
        return logPage([firstFile, selectedFile]);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        logRequests += 1;
        sinceTwoRequests += 1;
        if (sinceTwoRequests === 1) return logOpsPage([], 2);
        return await new Promise<Response>((resolve) => {
          resolveRename = resolve;
        });
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

    resolveRename?.(logOpsPage([renameOp], 3));
    await settle(() => renderedFilePaths().includes(renamedFile.path));

    expect(renderedFilePaths()).toEqual([firstFile.path, renamedFile.path]);
    expect(container.querySelector("h1")?.textContent).toBe(firstFile.path);

    expect(container.querySelector("h1")?.textContent).toBe(firstFile.path);
  });

  it("keeps loaded files through a network follower failure and retries", async () => {
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
        if (metaRequests === 1) throw new Error("network error");
        return jsonResponse(metaRequests === 2
          ? { ...DEFAULT_META, lastSettledAtMs: Date.now() }
          : DEFAULT_META);
      }
      if (path === "/api/view/current") return currentPage([file], 1);
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
    await settle(() => metaRequests === 1);
    await settle(() => vi.getTimerCount() >= 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(metaRequests).toBe(2);
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);

    await settle(() => metaRequests === 2);
    expect(metaRequests).toBe(2);
    expect(logRequests).toBe(3);
    expect(renderedFilePaths()).toEqual([file.path]);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled now",
    );
  });

  it("keeps settled work visible and retries when the follower receives 409", async () => {
    vi.useFakeTimers();
    const initialFile: SharedFile = {
      path: "note.md",
      blobSha256: "a".repeat(64),
      contentKind: "text",
    };
    const settledFile: SharedFile = {
      ...initialFile,
      blobSha256: "b".repeat(64),
    };
    const settledOp: RelayOp = {
      relaySeq: 2,
      opKind: "moment.append",
      payload: {
        operation: "write",
        payloadBeforePath: initialFile.path,
        payloadBeforeBlobSha256: initialFile.blobSha256,
        payloadAfterPath: settledFile.path,
        payloadAfterBlobSha256: settledFile.blobSha256,
        payloadAfterContentKind: settledFile.contentKind,
      },
      recordedAtMs: 2,
    };
    let logRequests = 0;
    let metaRequests = 0;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([initialFile], 1);
      if (path === "/api/view/log?since=1&limit=500") {
        logRequests += 1;
        if (logRequests === 1) return logOpsPage([], 1);
        if (logRequests === 2) return new Response(null, { status: 409 });
        return logOpsPage([settledOp], 2);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        logRequests += 1;
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === "/api/view/meta") {
        metaRequests += 1;
        return jsonResponse(DEFAULT_META);
      }
      if (path === `/api/view/blob/${initialFile.blobSha256}`) {
        return new Response("# Last settled body");
      }
      if (path === `/api/view/blob/${settledFile.blobSha256}`) {
        return new Response("# Retried settlement");
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 0,
          messages: [],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=0&hold=0&limit=100") {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => logRequests === 2);
    await settle(() => vi.getTimerCount() >= 1);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Last settled body",
    );
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(metaRequests).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(logRequests).toBe(2);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Last settled body",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Retried settlement") === true
    );
    await settle(() => logRequests === 4);
    expect(logRequests).toBe(4);
    expect(metaRequests).toBe(1);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it("backs off exponentially and resets after an epoch-floor reload succeeds", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-09-01T00:00:00.000Z").getTime();
    vi.setSystemTime(startedAt);
    const initialFile: SharedFile = {
      path: "epoch.md",
      blobSha256: "c".repeat(64),
      contentKind: "text",
    };
    const recoveredFile: SharedFile = {
      ...initialFile,
      blobSha256: "d".repeat(64),
    };
    const resetFile: SharedFile = {
      ...initialFile,
      blobSha256: "e".repeat(64),
    };
    let currentRequests = 0;
    let logRequests = 0;
    let recoveredBlobRequests = 0;
    let resetBlobRequests = 0;
    const currentRequestTimes: number[] = [];
    const logRequestTimes: number[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") {
        currentRequests += 1;
        currentRequestTimes.push(Date.now() - startedAt);
        if ([2, 3, 5].includes(currentRequests)) {
          return new Response(null, { status: 503 });
        }
        if (currentRequests === 1) return currentPage([initialFile], 1, 0);
        if (currentRequests === 4) return currentPage([recoveredFile], 2, 2);
        return currentPage([resetFile], 3, 3);
      }
      if (path === "/api/view/log?since=1&limit=500") {
        logRequests += 1;
        logRequestTimes.push(Date.now() - startedAt);
        if (logRequests === 1) return logOpsPage([], 1, false, 0);
        return logOpsPage([], 2, false, 2);
      }
      if (path === "/api/view/log?since=2&limit=500") {
        logRequests += 1;
        logRequestTimes.push(Date.now() - startedAt);
        if (logRequests === 5) return logOpsPage([], 2, false, 2);
        if (logRequests === 6 || logRequests === 7) {
          return logOpsPage([], 3, false, 3);
        }
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === "/api/view/log?since=3&limit=500") {
        logRequests += 1;
        logRequestTimes.push(Date.now() - startedAt);
        if (logRequests === 8) return logOpsPage([], 3, false, 3);
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === `/api/view/blob/${initialFile.blobSha256}`) {
        return new Response("# Settlement before epoch reset");
      }
      if (path === `/api/view/blob/${recoveredFile.blobSha256}`) {
        recoveredBlobRequests += 1;
        return new Response("# Settlement after epoch reset");
      }
      if (path === `/api/view/blob/${resetFile.blobSha256}`) {
        resetBlobRequests += 1;
        return new Response("# Settlement after retry reset");
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 0,
          messages: [],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=0&hold=0&limit=100") {
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => currentRequests === 2);
    expect(logRequests).toBe(2);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Settlement before epoch reset",
    );
    expect(container.textContent).not.toContain("This link isn't available.");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(logRequests).toBe(2);
    expect(currentRequests).toBe(2);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Settlement before epoch reset",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle(() => currentRequests === 3 && vi.getTimerCount() > 0);
    expect(logRequests).toBe(3);
    expect(currentRequestTimes).toEqual([0, 0, 1_000]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(currentRequests).toBe(3);
    expect(logRequests).toBe(3);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Settlement before epoch reset",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect({ currentRequests, logRequests, times: currentRequestTimes }).toEqual({
      currentRequests: 5,
      logRequests: 6,
      times: [0, 0, 1_000, 3_000, 3_000],
    });
    await settle(() => recoveredBlobRequests === 1);
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Settlement after epoch reset") === true
    );
    expect(logRequests).toBe(6);
    expect(currentRequestTimes).toEqual([0, 0, 1_000, 3_000, 3_000]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(currentRequests).toBe(5);
    expect(logRequests).toBe(6);
    expect(container.querySelector("article.markdown")?.textContent).toContain(
      "Settlement after epoch reset",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await settle(() => currentRequests === 6);
    await settle(() => resetBlobRequests === 1);
    await settle(() =>
      container.querySelector("article.markdown")?.textContent
        ?.includes("Settlement after retry reset") === true
    );
    expect(currentRequestTimes).toEqual([0, 0, 1_000, 3_000, 3_000, 4_000]);
    expect(logRequestTimes.slice(0, 8)).toEqual([
      0,
      0,
      1_000,
      3_000,
      3_000,
      3_000,
      4_000,
      4_000,
    ]);
    expect(container.textContent).not.toContain("This link isn't available.");
  });

  it.each([401, 403, 404])(
    "stops the follower when an epoch-floor reload returns %i",
    async (status) => {
      vi.useFakeTimers();
      let currentRequests = 0;
      let logRequests = 0;
      const initialFile: SharedFile = {
        path: "terminal-epoch.md",
        blobSha256: "f".repeat(64),
        contentKind: "text",
      };
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const path = requestPath(input);
        if (path === "/api/view/current") {
          currentRequests += 1;
          if (currentRequests === 2) return new Response(null, { status });
          return currentPage([initialFile], 1, 0);
        }
        if (path === "/api/view/log?since=1&limit=500") {
          logRequests += 1;
          return logRequests === 1
            ? logOpsPage([], 1, false, 0)
            : logOpsPage([], 2, false, 2);
        }
        if (path === `/api/view/blob/${initialFile.blobSha256}`) {
          return new Response("# Settlement before terminal reload");
        }
        if (path === "/api/view/discussion?direction=newest-first") {
          return jsonResponse({
            ok: true,
            activityRevision: 0,
            messages: [],
            nextCursor: null,
            profileName: null,
          });
        }
        if (path === "/api/view/discussion/activity?since=0&hold=0&limit=100") {
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();
      await settle(() => currentRequests === 2);
      await settle(() =>
        container.textContent?.includes("This link isn't available.") === true
      );
      expect(logRequests).toBe(2);
      expect(container.querySelector("article.markdown")).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(currentRequests).toBe(2);
      expect(logRequests).toBe(2);
    },
  );

  it.each([401, 403, 404])(
    "shows the unavailable state when follower metadata returns %i",
    async (status) => {
      vi.useFakeTimers();
      let metaRequests = 0;
      let logRequests = 0;
      let resolveFollower: ((response: Response) => void) | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const path = requestPath(input);
        if (path === "/api/view/meta") {
          metaRequests += 1;
          return new Response(null, { status });
        }
        if (path === "/api/view/current") return currentPage([], 0);
        if (path === "/api/view/log?since=0&limit=500") {
          logRequests += 1;
          if (logRequests === 1) return logPage([]);
          return await new Promise<Response>((resolve) => {
            resolveFollower = resolve;
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp();

      expect(container.textContent).not.toContain("This link isn't available.");

      resolveFollower?.(logOpsPage([], 0));
      await settle(() => container.textContent.includes("This link isn't available."));

      expect(metaRequests).toBe(1);
      expect(container.textContent).toContain("This link isn't available.");
    },
  );

  it("keeps the last settled view when follower metadata returns 503 and retries", async () => {
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
        if (metaRequests === 1) return new Response(null, { status: 503 });
        return jsonResponse(metaRequests === 2
          ? { ...DEFAULT_META, lastSettledAtMs: Date.now() }
          : DEFAULT_META);
      }
      if (path === "/api/view/current") return currentPage([file], 1);
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
    await settle(() => metaRequests === 1);
    await settle(() => vi.getTimerCount() >= 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(metaRequests).toBe(2);
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);

    await settle(() => metaRequests === 2);
    expect(metaRequests).toBe(2);
    expect(logRequests).toBe(3);
    expect(renderedFilePaths()).toEqual([file.path]);
    expect(container.querySelector(".freshness")?.textContent).toBe(
      "Last settled now",
    );
  });

  it("caps follower log pagination", async () => {
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
      if (path === "/api/view/current") return currentPage([file], 0);
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
    await settle(() => heartbeatLogPaths.length === MAX_LOG_PAGES);

    expect(heartbeatLogPaths).toHaveLength(MAX_LOG_PAGES);
    expect(heartbeatLogPaths.at(-1)).toBe(
      "/api/view/log?since=200&limit=500",
    );
    expect(container.textContent).not.toContain("This link isn't available.");
    expect(renderedFilePaths()).toEqual([file.path]);
  });

  it("loads Comment access without widening file authority", async () => {
    let activitySignal: AbortSignal | undefined;
    let unexpectedRequests = 0;
    const file: SharedFile = {
      path: "docs/commented.md",
      blobSha256: "9".repeat(64),
      contentKind: "text",
    };
    const commentMeta: ViewMeta = {
      ...DEFAULT_META,
      access: "comment",
      effectiveSelector: { ...DEFAULT_META.effectiveSelector, access: "comment" },
    };
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([file], 1, 0, commentMeta);
      if (path === "/api/view/log?since=1&limit=500") return logOpsPage([], 1);
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 7,
          messages: [{
            messageId: "comment-app",
            createdAtMs: 1,
            deleted: false,
            body: "Shared comment",
            author: { kind: "named", displayName: "Named Person" },
          }],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        const signal = init?.signal;
        if (!signal) throw new Error("Discussion activity request has no abort signal");
        activitySignal = signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response("# Commented file\n\nFile bytes stay read-only.");
      }
      if (path === "/api/view/meta") return jsonResponse(commentMeta);
      unexpectedRequests += 1;
      throw new Error(`Unexpected request: ${path} ${String(init?.method)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderApp();
    await settle(() => container.textContent?.includes("Shared comment") === true);
    await settle(() => activitySignal !== undefined);

    expect(container.querySelector(".badge")?.textContent).toBe("Comment");
    expect(container.querySelector("main.content")?.textContent).toContain(
      "File bytes stay read-only.",
    );
    expect(container.querySelector(".comments-panel")?.textContent).toContain("Shared comment");
    expect(container.querySelector(".comments-panel form")).not.toBeNull();
    expect(container.querySelector("main.content textarea")).toBeNull();
    expect(container.querySelector('main.content [contenteditable="true"]')).toBeNull();
    expect(unexpectedRequests).toBe(0);
    act(() => root?.unmount());
    root = null;
    await settle(() => activitySignal?.aborted === true);

    expect(activitySignal).toBeInstanceOf(AbortSignal);
    expect(activitySignal?.aborted).toBe(true);
  });

  it("applies narrowed View access from activity and ignores stale Comment metadata", async () => {
    vi.useFakeTimers();
    const file: SharedFile = {
      path: "docs/narrowed.md",
      blobSha256: "7".repeat(64),
      contentKind: "text",
    };
    const commentMeta: ViewMeta = {
      ...DEFAULT_META,
      access: "comment",
      effectiveSelector: { ...DEFAULT_META.effectiveSelector, access: "comment" },
    };
    let metaCalls = 0;
    let parkedSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([file], 1, 0, commentMeta);
      if (path === "/api/view/log?since=1&limit=500") return logOpsPage([], 1);
      if (path === "/api/view/meta") {
        metaCalls += 1;
        return jsonResponse(commentMeta);
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 7,
          messages: [],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "view",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        parkedSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      }
      if (path === `/api/view/blob/${file.blobSha256}`) {
        return new Response("# Narrowed link");
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    await renderApp();
    await settle(() =>
      parkedSignal !== undefined &&
      container.querySelector(".badge")?.textContent === "View"
    );

    expect(container.querySelector(".comments-panel form")).toBeNull();
    await settle(() => metaCalls === 1);

    expect(container.querySelector(".badge")?.textContent).toBe("View");
    expect(container.querySelector(".comments-panel form")).toBeNull();
  });

  it.each([
    ["blocked", "The owner turned off comments for this browser."],
    ["paused", "The owner paused comments. You can still read everything."],
  ] as const)("keeps the file and timeline readable when Comment append is %s", async (writeState, copy) => {
    let activitySignal: AbortSignal | undefined;
    let unexpectedRequests = 0;
    const file: SharedFile = {
      path: "docs/readable.md",
      blobSha256: "8".repeat(64),
      contentKind: "text",
    };
    const commentMeta: ViewMeta = {
      ...DEFAULT_META,
      access: "comment",
      effectiveSelector: { ...DEFAULT_META.effectiveSelector, access: "comment" },
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === "/api/view/current") return currentPage([file], 1, 0, commentMeta);
      if (path === "/api/view/log?since=1&limit=500") return logOpsPage([], 1);
      if (path === "/api/view/discussion" && init?.method === "POST") {
        return jsonResponse({ ok: false, state: writeState, activityRevision: 7 }, 403);
      }
      if (path === "/api/view/discussion?direction=newest-first") {
        return jsonResponse({
          ok: true,
          activityRevision: 7,
          messages: [{
            messageId: "readable-comment",
            createdAtMs: 1,
            deleted: false,
            body: "Readable timeline",
            author: { kind: "named", displayName: "Named Person" },
          }],
          nextCursor: null,
          profileName: null,
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=0&limit=100") {
        return jsonResponse({
          profileName: null,
          ok: true,
          access: "comment",
          latestRevision: 7,
          cursorRevision: 7,
          hasMore: false,
          messages: [],
          composerState: "available",
        });
      }
      if (path === "/api/view/discussion/activity?since=7&hold=30000&limit=100") {
        const signal = init?.signal;
        if (!signal) throw new Error("Discussion activity request has no abort signal");
        activitySignal = signal;
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (path === `/api/view/blob/${file.blobSha256}`) return new Response("Readable file bytes");
      if (path === "/api/view/meta") return jsonResponse(commentMeta);
      unexpectedRequests += 1;
      throw new Error(`Unexpected request: ${path}`);
    }));

    await renderApp();
    await settle(() =>
      container.querySelector("main.content")?.textContent?.includes(
        "Readable file bytes",
      ) === true &&
      container.querySelector(".comments-panel")?.textContent?.includes(
        "Readable timeline",
      ) === true &&
      activitySignal !== undefined
    );
    const body = container.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    if (!body) throw new Error("comment body is missing");
    setControlValue(body, "Refused comment");
    clickButton("Post comment");
    await settle(() => container.textContent?.includes(copy) === true);

    expect(container.querySelector("main.content")?.textContent).toContain("Readable file bytes");
    expect(container.querySelector(".comments-panel")?.textContent).toContain("Readable timeline");
    expect(body.disabled).toBe(true);
    expect(unexpectedRequests).toBe(0);
    act(() => root?.unmount());
    root = null;
    await settle(() => activitySignal?.aborted === true);

    expect(activitySignal).toBeInstanceOf(AbortSignal);
    expect(activitySignal?.aborted).toBe(true);
  });

  it("refuses mismatched top-level and effective Comment access", async () => {
    const mismatched = {
      ...DEFAULT_META,
      access: "comment",
      effectiveSelector: { ...DEFAULT_META.effectiveSelector, access: "view" },
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = requestPath(input);
      if (path === "/api/view/current") {
        return jsonResponse({
          ok: true,
          ...mismatched,
          files: [],
          nextCursor: 0,
          epochLogFloor: 0,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));

    await renderApp();

    expect(container.textContent).toBe("This link isn't available.");
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
        if (path === "/api/view/current") return currentPage([], 0);
        if (path === "/api/view/log?since=0&limit=500") {
          logPaths.push(path);
          logTimes.push(Date.now() - startedAt);
          if (logPaths.length < 5) return new Response(null, { status: 429 });
          return logPage([]);
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp(() => logPaths.length === 1);

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

      await settle(() => logPaths.length === 6);
      expect(logPaths).toEqual(Array.from({ length: 6 }, () => logPaths[0]!));
      expect(logTimes).toEqual([0, 1_000, 3_000, 7_000, 15_000, 15_000]);
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
        if (path === "/api/view/current") return currentPage([], 0);
        if (path === "/api/view/log?since=0&limit=500") {
          logPaths.push(path);
          return new Response(null, { status: 429 });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      await renderApp(() => logPaths.length === 1);
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
        if (path === "/api/view/current") return currentPage([], 0);
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
