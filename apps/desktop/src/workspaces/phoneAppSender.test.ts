import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import {
  createPhoneAppSender,
  PHONE_APP_REFUSED,
  sendableApp,
  type SendableSite,
} from "./phoneAppSender";

const credentials = {
  serverUrl: "https://drive.test",
  email: "owner@example.test",
  userId: "owner",
  token: "token",
};

const site = (root: string, extra: Partial<SendableSite> = {}): SendableSite => ({
  root,
  kind: "static",
  entryPath: `${root}/index.html`,
  packagePath: null,
  configPath: null,
  sourceFiles: [`${root}/index.html`],
  ...extra,
});

const candidate = (appRoot: string, sourceRevision: string, extra: object = {}) =>
  ({ appRoot, sourceRevision, capabilities: [], ...extra }) as unknown as AppPublicationCandidate;

type Row = { publicationId: string; authorityRevision: number; sourceRevision: string };
const row = (publicationId: string, sourceRevision: string, authorityRevision = 1): Row => ({
  publicationId,
  authorityRevision,
  sourceRevision,
});

function harness(input: { apps: string[]; revisions: Record<string, string> }) {
  const owner = new Map<string, Row>();
  const pending = new Map<string, Row>();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let next = 1;
  let refuseNextPublish = false;
  const state = {
    enabled: true,
    onMain: true,
    atHead: true,
    withdrawFails: false,
    apps: input.apps,
    existing: new Set(input.apps),
    revisions: input.revisions,
    sourcePaths: {} as Record<string, string[]>,
    readFails: {} as Record<string, string>,
  };
  const relayJson = vi.fn(async (_credentials: unknown, path: string, init?: RequestInit) => {
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
      for (const [root, row] of owner)
        if (row.publicationId === id) {
          owner.delete(root);
          pending.delete(root);
        }
      for (const [root, row] of pending) if (row.publicationId === id) pending.delete(root);
      return { publicationId: id, active: false };
    }
    if (path.endsWith("/backend/activate")) {
      for (const [root, row] of pending)
        if (row.publicationId === id) {
          owner.set(root, row);
          pending.delete(root);
        }
      return { publicationId: id, authorityRevision: body.authorityRevision };
    }
    const published = body.candidate as AppPublicationCandidate;
    if (refuseNextPublish) {
      refuseNextPublish = false;
      owner.set(published.appRoot, row("from-another-computer", "elsewhere"));
      throw new Error("Another version of this app reached your phones first.");
    }
    const sent = row(`p${next++}`, published.sourceRevision);
    owner.set(published.appRoot, sent);
    return { ...sent, active: true };
  });
  const prepare = vi.fn(async (_workspace: unknown, appRoot: string) => ({
    candidate: candidate(appRoot, state.revisions[appRoot]!),
    files: [{ sha256: "a".repeat(64), bytes: new Uint8Array([1]) }],
  }));
  const upload = vi.fn(async () => {});
  const changed = vi.fn();
  const catchUp = vi.fn(async () => {});
  const sender = createPhoneAppSender<{ workspaceId: string }>({
    withWorkspace: (workspaceId, work) =>
      work({ workspaceId }, new AbortController().signal, credentials),
    admitted: async () => state.enabled && state.onMain,
    sync: async () => {
      await catchUp();
      return state.atHead;
    },
    apps: async () => state.apps.map((root) => site(root)),
    exists: async (_workspace, appRoot) => state.existing.has(appRoot),
    readSource: async (_workspace, appRoot, _signal, select) => {
      select(state.sourcePaths[appRoot] ?? [`${appRoot}/index.html`]);
      if (state.readFails[appRoot]) throw new Error(state.readFails[appRoot]);
      return state.revisions[appRoot]!;
    },
    prepare,
    relayJson,
    upload,
    changed,
  });
  return {
    sender,
    owner,
    pending,
    posts,
    state,
    prepare,
    upload,
    changed,
    catchUp,
    refuseNextPublish: () => {
      refuseNextPublish = true;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendableApp", () => {
  it("sends folders the closed compiler builds, and nothing else", () => {
    expect(sendableApp(site("apps/trip"))).toBe(true);
    expect(
      sendableApp(
        site("apps/signup", {
          kind: "configured",
          configPath: "apps/signup/vite.config.ts",
          sourceFiles: ["apps/signup/app.publish.json", "apps/signup/main.tsx"],
        }),
      ),
    ).toBe(true);
    expect(sendableApp(site("."))).toBe(false);
    expect(sendableApp(site(".drafts/app"))).toBe(false);
    expect(sendableApp(site("shared-with-me/ana/app"))).toBe(false);
    expect(
      sendableApp(site("apps/next", { kind: "package", packagePath: "apps/next/package.json" })),
    ).toBe(false);
    const vite = site("apps/vite", { kind: "configured", configPath: "apps/vite/vite.config.ts" });
    expect(sendableApp(vite)).toBe(false);
  });
});

describe("createPhoneAppSender", () => {
  it("sends a changed app as the owner's, and skips one the phones already have", async () => {
    const test = harness({
      apps: ["apps/trip", "apps/poll"],
      revisions: { "apps/trip": "r1", "apps/poll": "r2" },
    });
    test.owner.set("apps/trip", row("trip-1", "r1"));
    await test.sender.run("ws");
    expect(test.prepare.mock.calls.map(([, appRoot]) => appRoot)).toEqual(["apps/poll"]);
    expect(test.upload).toHaveBeenCalledOnce();
    expect(test.posts).toEqual([
      {
        path: "/sync/ws/app-publications",
        body: expect.objectContaining({ audience: "owner", expectedCurrentPublicationId: null }),
      },
    ]);

    test.state.revisions["apps/trip"] = "r3";
    await test.sender.run("ws");
    expect(test.prepare.mock.calls.map(([, appRoot]) => appRoot)).toEqual([
      "apps/poll",
      "apps/trip",
    ]);
    expect(test.posts.at(-1)!.body.expectedCurrentPublicationId).toBe("trip-1");
  });

  it("sends nothing while the setting is off", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.state.enabled = false;
    await test.sender.run("ws");
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
  });

  it("withdraws the owner publication of an app folder gone from main", async () => {
    const test = harness({ apps: [], revisions: {} });
    test.owner.set("apps/old", row("old-1", "r1", 4));
    await test.sender.run("ws");
    expect(test.posts).toEqual([
      { path: "/sync/ws/app-publications/old-1/withdraw", body: { expectedAuthorityRevision: 4 } },
    ]);
    expect(test.owner.size).toBe(0);
  });

  it("keeps the owner publication of a folder that is still on main but no longer sent", async () => {
    const test = harness({ apps: [], revisions: {} });
    test.owner.set("apps/trip", row("trip-1", "r1"));
    test.state.existing.add("apps/trip");
    await test.sender.run("ws");
    expect(test.posts).toEqual([]);
    expect(test.owner.get("apps/trip")?.publicationId).toBe("trip-1");
  });

  it("files one row per app that can't be sent, waits for a change or Try again, and clears it on success", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.prepare.mockRejectedValueOnce(new Error("index.html has a syntax error."));
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: "apps/trip", reason: "index.html has a syntax error." },
    ]);
    await test.sender.run("ws");
    expect(test.prepare).toHaveBeenCalledTimes(1);

    await test.sender.retry("ws", "apps/elsewhere");
    expect(test.prepare).toHaveBeenCalledTimes(1);
    await test.sender.retry("ws", "apps/trip");
    expect(test.prepare).toHaveBeenCalledTimes(2);
    expect(test.sender.notSent("ws")).toEqual([]);
    expect(test.owner.get("apps/trip")?.sourceRevision).toBe("r1");
  });

  it("reports an app with outside calls instead of sending it", async () => {
    const test = harness({ apps: ["apps/quotes"], revisions: { "apps/quotes": "r1" } });
    test.prepare.mockResolvedValueOnce({
      candidate: candidate("apps/quotes", "r1", { external: [{ host: "api.example.test" }] }),
      files: [],
    });
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: "apps/quotes", reason: PHONE_APP_REFUSED },
    ]);
    expect(test.posts).toEqual([]);
  });

  it("activates a Collection app after sending it", async () => {
    const test = harness({ apps: ["apps/books"], revisions: { "apps/books": "r1" } });
    test.prepare.mockResolvedValueOnce({
      candidate: candidate("apps/books", "r1", {
        capabilities: [{ kind: "dataset", datasetId: "books" }],
      }),
      files: [],
    });
    await test.sender.run("ws");
    expect(test.posts.map((post) => post.path)).toEqual([
      "/sync/ws/app-publications",
      "/sync/ws/app-publications/p1/backend/activate",
    ]);
  });

  it("starts a fresh pass instead of a Notice when another version got there first", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.refuseNextPublish();
    await test.sender.run("ws");
    expect(test.posts).toHaveLength(1);
    expect(test.sender.notSent("ws")).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("files a failed withdrawal as a workspace row and tries again on the next pull", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: [], revisions: {} });
    test.owner.set("apps/old", row("old-1", "r1"));
    test.state.withdrawFails = true;
    test.sender.pulled("ws", true);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(test.sender.notSent("ws")).toEqual([
        { appRoot: null, reason: "dohc could not reach the server." },
      ]),
    );

    test.state.withdrawFails = false;
    test.sender.pulled("ws", false);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(test.owner.size).toBe(0));
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("stops a send in flight when the setting turns off", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.prepare.mockImplementationOnce(async (_workspace, appRoot) => {
      test.state.enabled = false;
      test.sender.settingChanged(false);
      return { candidate: candidate(appRoot, "r1"), files: [] };
    });
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("stops a send in flight when a version other than main becomes active", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.prepare.mockImplementationOnce(async (_workspace, appRoot) => {
      test.state.onMain = false;
      test.sender.versionSwitched("ws");
      return {
        candidate: candidate(appRoot, "r1"),
        files: [{ sha256: "a".repeat(64), bytes: new Uint8Array([1]) }],
      };
    });
    await test.sender.run("ws");
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("sends nothing until the workspace is at the server's head after syncing", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.catchUp.mockImplementationOnce(async () => {
      test.state.atHead = false;
    });
    await test.sender.run("ws");
    expect(test.catchUp).toHaveBeenCalledOnce();
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
  });

  it("starts a fresh pass instead of sending when the files changed during preparation", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.prepare.mockResolvedValueOnce({ candidate: candidate("apps/trip", "r2"), files: [] });
    await test.sender.run("ws");
    expect(test.posts).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("checks an app again when a missing declared input outside its folder appears", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.state.sourcePaths["apps/trip"] = ["apps/trip/app.publish.json", "shared/theme.css"];
    test.state.readFails["apps/trip"] = "apps/trip/app.publish.json lists shared/theme.css.";
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toHaveLength(1);
    test.sender.filesChanged("ws", ["shared/theme.css"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("checks an app again when a declared input outside its folder changes", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.state.sourcePaths["apps/trip"] = ["apps/trip/app.publish.json", "shared/theme.css"];
    await test.sender.run("ws");
    test.sender.filesChanged("ws", ["notes/today.md"]);
    expect(vi.getTimerCount()).toBe(0);

    test.state.revisions["apps/trip"] = "r2";
    test.sender.filesChanged("ws", ["shared/theme.css"]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(test.owner.get("apps/trip")?.sourceRevision).toBe("r2"));
  });

  it("sends and withdraws nothing while a version other than main is active", async () => {
    vi.useFakeTimers();
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.owner.set("apps/old", row("old-1", "r1"));
    test.state.onMain = false;
    await test.sender.run("ws");
    expect(test.posts).toEqual([]);
    expect(test.prepare).not.toHaveBeenCalled();

    test.state.onMain = true;
    test.sender.versionSwitched("ws");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() =>
      expect(test.posts.map((post) => post.path)).toEqual([
        "/sync/ws/app-publications",
        "/sync/ws/app-publications/old-1/withdraw",
      ]),
    );
  });

  it("doesn't send a stale app over a newer one another computer sent, once it has pulled", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.owner.set("apps/trip", row("a-2", "r2"));
    test.catchUp.mockImplementationOnce(async () => {
      test.state.revisions["apps/trip"] = "r2";
    });
    await test.sender.run("ws");
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.posts).toEqual([]);
  });

  it("activates a pending version with unchanged files instead of sending it again", async () => {
    const test = harness({ apps: ["apps/books"], revisions: { "apps/books": "r1" } });
    test.owner.set("apps/books", row("books-1", "r0"));
    test.pending.set("apps/books", row("books-2", "r1"));
    await test.sender.run("ws");
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.posts.map((post) => post.path)).toEqual([
      "/sync/ws/app-publications/books-2/backend/activate",
    ]);
    expect(test.owner.get("apps/books")?.publicationId).toBe("books-2");
  });

  it("names the pending version as the one it expects when the files changed again", async () => {
    const test = harness({ apps: ["apps/books"], revisions: { "apps/books": "r2" } });
    test.owner.set("apps/books", row("books-1", "r0"));
    test.pending.set("apps/books", row("books-2", "r1"));
    await test.sender.run("ws");
    expect(test.posts[0]!.body.expectedCurrentPublicationId).toBe("books-2");
  });

  it("withdraws a deleted app's current version, which takes its pending one too", async () => {
    const test = harness({ apps: [], revisions: {} });
    test.owner.set("apps/books", row("books-1", "r0", 3));
    test.pending.set("apps/books", row("books-2", "r1"));
    await test.sender.run("ws");
    expect(test.posts).toEqual([
      {
        path: "/sync/ws/app-publications/books-1/withdraw",
        body: { expectedAuthorityRevision: 3 },
      },
    ]);
    expect(test.pending.size).toBe(0);
  });
});
