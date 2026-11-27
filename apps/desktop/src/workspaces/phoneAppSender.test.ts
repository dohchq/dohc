import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { prepareOwnerAppPublication, readLocalAppSource } from "./ownerAppPublication";
import { createPhoneAppSender, sendableRoots } from "./phoneAppSender";

vi.mock("./ownerAppPublication", () => ({
  readLocalAppSource: vi.fn(),
  prepareOwnerAppPublication: vi.fn(),
}));
const readSource = vi.mocked(readLocalAppSource);
const prepare = vi.mocked(prepareOwnerAppPublication);
type Prepared = Awaited<ReturnType<typeof prepareOwnerAppPublication>>;

const credentials = {
  serverUrl: "https://drive.test",
  email: "owner@example.test",
  userId: "owner",
  token: "token",
};
const REFUSED =
  "Apps that create Collection files or call outside services open on your phone only through a link.";

const html = (...roots: string[]) => roots.map((root) => `${root}/index.html`);
const prepared = (appRoot: string, sourceRevision: string, extra: object = {}): Prepared => ({
  candidate: {
    appRoot,
    sourceRevision,
    capabilities: [],
    ...extra,
  } as unknown as AppPublicationCandidate,
  files: [
    {
      path: "bundle.js",
      sha256: "a".repeat(64),
      byteLength: 1,
      contentType: "text/javascript",
      bytes: new Uint8Array([1]),
    },
  ],
  likelySecrets: [],
});

type Row = { publicationId: string; authorityRevision: number; sourceRevision: string };
const row = (publicationId: string, sourceRevision: string, authorityRevision = 1): Row => ({
  publicationId,
  authorityRevision,
  sourceRevision,
});

function harness(input: { files: string[]; revisions: Record<string, string>; delayMs?: number }) {
  const owner = new Map<string, Row>();
  const pending = new Map<string, Row>();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let next = 1;
  const state = {
    enabled: true,
    signedIn: true,
    onMain: true,
    atHead: true,
    synced: true,
    unavailable: false,
    hang: false,
    withdrawFails: false,
    refuseNextPublish: false,
    refuseNextActivate: false,
    publishReportsCurrent: false,
    files: input.files,
    revisions: input.revisions,
    sourcePaths: {} as Record<string, string[]>,
    readFails: {} as Record<string, string>,
  };
  const relayJson = vi.fn(async (_credentials: unknown, path: string, init?: RequestInit) => {
    if (state.hang)
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)),
      );
    if (!init?.method)
      return {
        publications: [
          ...[...owner].map(([appRoot, row]) => ({ ...row, appRoot, ownerState: "current" })),
          ...[...pending].map(([appRoot, row]) => ({ ...row, appRoot, ownerState: "pending" })),
        ].map((row) => ({ ...row, active: true })),
        nextCursor: null,
      };
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ path, body });
    const id = path.split("/").at(path.endsWith("/backend/activate") ? -3 : -2);
    if (path.endsWith("/withdraw")) {
      if (state.withdrawFails) throw new Error("dohc could not reach the server.");
      for (const [root, row] of pending) if (row.publicationId === id) pending.delete(root);
      for (const [root, row] of owner) if (row.publicationId === id) owner.delete(root);
      return { publicationId: id, active: false };
    }
    if (path.endsWith("/backend/activate")) {
      for (const [root, held] of pending) {
        if (held.publicationId !== id) continue;
        if (state.refuseNextActivate) {
          state.refuseNextActivate = false;
          pending.set(root, row("from-another-computer", "elsewhere"));
          throw new Error("A newer version of this app reached your phones first.");
        }
        owner.set(root, held);
        pending.delete(root);
      }
      return { publicationId: id, authorityRevision: body.authorityRevision };
    }
    const published = body.candidate as AppPublicationCandidate;
    if (published.external) throw new Error(REFUSED);
    if (state.refuseNextPublish) {
      state.refuseNextPublish = false;
      owner.set(published.appRoot, row("from-another-computer", "elsewhere"));
      throw new Error("Another version of this app reached your phones first.");
    }
    const sent = row(`p${next++}`, published.sourceRevision);
    const ownerState =
      published.capabilities.length && !state.publishReportsCurrent ? "pending" : "current";
    (ownerState === "pending" ? pending : owner).set(published.appRoot, sent);
    return { ...sent, active: true, ownerState };
  });
  readSource.mockImplementation(async (source, options) => {
    options.onSelected?.(state.sourcePaths[source.appRoot] ?? [`${source.appRoot}/index.html`]);
    if (state.readFails[source.appRoot]) throw new Error(state.readFails[source.appRoot]);
    return { sourceRevision: state.revisions[source.appRoot]!, sourcePaths: [] };
  });
  prepare.mockImplementation(async (selection) =>
    prepared(selection.appRoot, state.revisions[selection.appRoot]!),
  );
  const adapter = {
    listTextFileMetadata: async () => state.files.map((path) => ({ path })),
  } as unknown as VersionedLiveAdapter;
  const upload = vi.fn(async () => {});
  const changed = vi.fn();
  const sync = vi.fn(async () => state.atHead);
  const sender = createPhoneAppSender<{ workspaceId: string }>({
    open: async (workspaceId, work) => {
      if (state.enabled && state.signedIn)
        await work({ workspaceId }, new AbortController().signal, credentials);
    },
    admitted: async () => state.enabled && state.onMain,
    sync,
    synced: () => state.synced,
    withAdapter: async <Result>(
      _workspace: unknown,
      work: (engine: VersionedLiveAdapter) => Promise<Result>,
    ) => work(adapter),
    compile: async () => {
      throw new Error("Unexpected compile.");
    },
    resolveDatasetRevision: async () => {
      throw new Error("Unexpected Collection lookup.");
    },
    relayJson,
    relayJsonOrUnavailable: async (_credentials, path, init) =>
      state.unavailable
        ? { kind: "unavailable" as const }
        : { kind: "success" as const, body: await relayJson(credentials, path, init) },
    upload,
    changed,
    ...(input.delayMs === undefined ? {} : { delayMs: input.delayMs }),
    timeoutMs: 50,
  });
  return { sender, owner, pending, posts, state, upload, changed, relayJson, sync };
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("sendableRoots", () => {
  it("picks folders the closed compiler builds from main's file list", () => {
    expect(
      sendableRoots([
        "index.html",
        "apps/trip/index.html",
        "apps/trip/style.css",
        "apps/trip/dist/index.html",
        "apps/signup/app.publish.json",
        "apps/signup/vite.config.ts",
        "apps/next/index.html",
        "apps/next/package.json",
        "apps/vite/index.html",
        "apps/vite/vite.config.ts",
        ".drafts/app/index.html",
        "shared-with-me/ana/app/index.html",
        "tools/node_modules/kit/index.html",
      ]).sort(),
    ).toEqual(["apps/signup", "apps/trip"]);
  });
});

describe("createPhoneAppSender", () => {
  it("sends a changed app as the owner's, and skips one the phones already have", async () => {
    const test = harness({
      files: html("apps/trip", "apps/poll"),
      revisions: { "apps/trip": "r1", "apps/poll": "r2" },
    });
    test.owner.set("apps/trip", row("trip-1", "r1"));
    await test.sender.run("ws");
    expect(prepare.mock.calls.map(([selection]) => selection.appRoot)).toEqual(["apps/poll"]);
    expect(test.upload).toHaveBeenCalledOnce();
    expect(test.posts).toEqual([
      {
        path: "/sync/ws/app-publications",
        body: expect.objectContaining({ audience: "owner", expectedCurrentPublicationId: null }),
      },
    ]);

    test.state.revisions["apps/trip"] = "r3";
    await test.sender.run("ws");
    expect(test.posts.at(-1)!.body.expectedCurrentPublicationId).toBe("trip-1");
  });

  it("files nothing for a workspace that opted out or isn't signed in", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.enabled = false;
    await test.sender.run("ws");
    test.state.enabled = true;
    test.state.signedIn = false;
    await test.sender.run("ws");
    expect(test.relayJson).not.toHaveBeenCalled();
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("parks quietly when sync fails, and tries again on the next pull", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.atHead = false;
    await test.sender.run("ws");
    expect(test.relayJson).not.toHaveBeenCalled();
    expect(test.sender.notSent("ws")).toEqual([]);

    test.state.atHead = true;
    test.sender.pulled("ws", false);
    test.sender.pulled("ws", false);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(test.owner.get("apps/trip")?.sourceRevision).toBe("r1"));
  });

  it("returns quietly when the server doesn't publish apps", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.unavailable = true;
    await test.sender.run("ws");
    expect(test.posts).toEqual([]);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("gives up on a stalled server request instead of holding every workspace", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.hang = true;
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: null, reason: expect.stringContaining("timeout") },
    ]);
  });

  it("withdraws every owner version of an app folder gone from main", async () => {
    const test = harness({ files: [], revisions: {} });
    test.owner.set("apps/books", row("books-1", "r0", 3));
    test.pending.set("apps/books", row("books-2", "r1", 2));
    await test.sender.run("ws");
    expect(test.posts).toEqual([
      {
        path: "/sync/ws/app-publications/books-2/withdraw",
        body: { expectedAuthorityRevision: 2 },
      },
      {
        path: "/sync/ws/app-publications/books-1/withdraw",
        body: { expectedAuthorityRevision: 3 },
      },
    ]);
  });

  it("keeps the owner version of a folder that is still on main but no longer sent", async () => {
    const test = harness({
      files: ["apps/trip/index.html", "apps/trip/package.json"],
      revisions: {},
    });
    test.owner.set("apps/trip", row("trip-1", "r1"));
    await test.sender.run("ws");
    expect(test.posts).toEqual([]);
  });

  it("files a failed withdrawal as a workspace row and tries again on the next pull", async () => {
    vi.useFakeTimers();
    const test = harness({ files: [], revisions: {} });
    test.owner.set("apps/old", row("old-1", "r1"));
    test.state.withdrawFails = true;
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: null, reason: "dohc could not reach the server." },
    ]);

    test.state.withdrawFails = false;
    test.sender.pulled("ws", false);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(test.owner.size).toBe(0));
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("files one row per app that can't be sent, waits for a change or Try again, and clears it on success", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    prepare.mockRejectedValueOnce(new Error("index.html has a syntax error."));
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: "apps/trip", reason: "index.html has a syntax error." },
    ]);
    await test.sender.run("ws");
    expect(prepare).toHaveBeenCalledTimes(1);

    await test.sender.retry("ws", "apps/elsewhere");
    expect(prepare).toHaveBeenCalledTimes(1);
    await test.sender.retry("ws", "apps/trip");
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("files the server's refusal of an app with outside calls", async () => {
    const test = harness({ files: html("apps/quotes"), revisions: { "apps/quotes": "r1" } });
    prepare.mockResolvedValueOnce(
      prepared("apps/quotes", "r1", { external: [{ host: "x.test" }] }),
    );
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([{ appRoot: "apps/quotes", reason: REFUSED }]);
  });

  it("activates a Collection app the server holds pending", async () => {
    const test = harness({ files: html("apps/books"), revisions: { "apps/books": "r1" } });
    prepare.mockResolvedValueOnce(
      prepared("apps/books", "r1", { capabilities: [{ kind: "dataset" }] }),
    );
    await test.sender.run("ws");
    expect(test.posts.map((post) => post.path)).toEqual([
      "/sync/ws/app-publications",
      "/sync/ws/app-publications/p1/backend/activate",
    ]);
  });

  it("doesn't activate a version the publish reports as current", async () => {
    const test = harness({ files: html("apps/books"), revisions: { "apps/books": "r1" } });
    test.state.publishReportsCurrent = true;
    prepare.mockResolvedValueOnce(
      prepared("apps/books", "r1", { capabilities: [{ kind: "dataset" }] }),
    );
    await test.sender.run("ws");
    expect(test.posts.map((post) => post.path)).toEqual(["/sync/ws/app-publications"]);
  });

  it("starts a fresh pass instead of a Notice when another version got there first", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.refuseNextPublish = true;
    await test.sender.run("ws");
    expect(test.posts).toHaveLength(1);
    expect(test.sender.notSent("ws")).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("starts a fresh pass instead of a Notice when activation loses to a newer version", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/books"), revisions: { "apps/books": "r1" } });
    test.pending.set("apps/books", row("books-2", "r1"));
    test.state.refuseNextActivate = true;
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops a send in flight when the setting turns off", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    prepare.mockImplementationOnce(async (selection) => {
      test.state.enabled = false;
      test.sender.settingChanged(false);
      return prepared(selection.appRoot, "r1");
    });
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("stops a send in flight when a version other than main becomes active", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    prepare.mockImplementationOnce(async (selection) => {
      test.state.onMain = false;
      test.sender.versionSwitched("ws");
      return prepared(selection.appRoot, "r1");
    });
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
  });

  it("clears pending passes when the setting turns off or the workspace closes", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.sender.schedule("ws");
    test.sender.settingChanged(false);
    expect(vi.getTimerCount()).toBe(0);

    test.sender.settingChanged(true);
    prepare.mockRejectedValueOnce(new Error("index.html has a syntax error."));
    await test.sender.run("ws");
    test.sender.schedule("ws");
    test.sender.close("ws");
    expect(vi.getTimerCount()).toBe(0);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("doesn't upload a build when local edits arrived after the sync", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.synced = false;
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("doesn't upload a build whose files changed during preparation", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    prepare.mockResolvedValueOnce(prepared("apps/trip", "r2"));
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("doesn't send a stale app over a newer one another computer sent, once it has pulled", async () => {
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.owner.set("apps/trip", row("a-2", "r2"));
    test.sync
      .mockImplementationOnce(async () => true)
      .mockImplementationOnce(async () => {
        test.state.revisions["apps/trip"] = "r2";
        return true;
      });
    await test.sender.run("ws");
    expect(test.sync).toHaveBeenCalledTimes(2);
    expect(prepare).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
  });

  it("checks an app again when a missing declared input outside its folder appears", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.sourcePaths["apps/trip"] = ["apps/trip/app.publish.json", "shared/theme.css"];
    test.state.readFails["apps/trip"] = "apps/trip/app.publish.json lists shared/theme.css.";
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toHaveLength(1);
    test.sender.filesChanged("ws", ["notes/today.md"]);
    expect(vi.getTimerCount()).toBe(0);
    test.sender.filesChanged("ws", ["shared/theme.css"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps watching known outside inputs while a pass rebuilds them", async () => {
    const test = harness({
      files: html("apps/trip"),
      revisions: { "apps/trip": "r1" },
      delayMs: 0,
    });
    test.state.sourcePaths["apps/trip"] = ["apps/trip/index.html", "shared/theme.css"];
    await test.sender.run("ws");
    let release = () => {};
    readSource.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ sourceRevision: "r1", sourcePaths: [] });
        }),
    );
    const rebuilding = test.sender.run("ws");
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledTimes(2));
    test.sender.filesChanged("ws", ["shared/theme.css"]);
    release();
    await rebuilding;
    await vi.waitFor(() => expect(readSource).toHaveBeenCalledTimes(3));
  });

  it("activates a pending version with unchanged files instead of sending it again", async () => {
    const test = harness({ files: html("apps/books"), revisions: { "apps/books": "r1" } });
    test.owner.set("apps/books", row("books-1", "r0"));
    test.pending.set("apps/books", row("books-2", "r1"));
    await test.sender.run("ws");
    expect(prepare).not.toHaveBeenCalled();
    expect(test.posts.map((post) => post.path)).toEqual([
      "/sync/ws/app-publications/books-2/backend/activate",
    ]);
  });

  it("names the pending version as the one it expects when the files changed again", async () => {
    const test = harness({ files: html("apps/books"), revisions: { "apps/books": "r2" } });
    test.owner.set("apps/books", row("books-1", "r0"));
    test.pending.set("apps/books", row("books-2", "r1"));
    await test.sender.run("ws");
    expect(test.posts[0]!.body.expectedCurrentPublicationId).toBe("books-2");
  });

  it("checks an app again when a declared input outside its folder changes", async () => {
    vi.useFakeTimers();
    const test = harness({ files: html("apps/trip"), revisions: { "apps/trip": "r1" } });
    test.state.sourcePaths["apps/trip"] = ["apps/trip/app.publish.json", "shared/theme.css"];
    await test.sender.run("ws");
    test.state.revisions["apps/trip"] = "r2";
    test.sender.filesChanged("ws", ["shared/theme.css"]);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(test.owner.get("apps/trip")?.sourceRevision).toBe("r2"));
  });
});
