import { describe, expect, it, vi } from "vitest";
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

function harness(input: { apps: string[]; revisions: Record<string, string> }) {
  const owner = new Map<string, Row>();
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  let next = 1;
  let refuseNextPublish = false;
  const relayJson = vi.fn(async (_credentials: unknown, path: string, init?: RequestInit) => {
    if (!init?.method)
      return {
        publications: [...owner].map(([appRoot, row]) => ({ ...row, appRoot, active: true })),
        nextCursor: null,
      };
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    posts.push({ path, body });
    const id = path.split("/").at(path.endsWith("/backend/activate") ? -3 : -2);
    if (path.endsWith("/withdraw")) {
      for (const [root, row] of owner) if (row.publicationId === id) owner.delete(root);
      return { publicationId: id, active: false };
    }
    if (path.endsWith("/backend/activate"))
      return { publicationId: id, authorityRevision: body.authorityRevision };
    const published = body.candidate as AppPublicationCandidate;
    if (refuseNextPublish) {
      refuseNextPublish = false;
      owner.set(published.appRoot, {
        publicationId: "from-another-computer",
        authorityRevision: 1,
        sourceRevision: "elsewhere",
      });
      throw new Error("Another version of this app was sent first.");
    }
    const row = {
      publicationId: `p${next++}`,
      authorityRevision: 1,
      sourceRevision: published.sourceRevision,
    };
    owner.set(published.appRoot, row);
    return { ...row, active: true };
  });
  const state = { enabled: true, apps: input.apps, revisions: input.revisions };
  const prepare = vi.fn(async (_workspace: unknown, appRoot: string) => ({
    candidate: candidate(appRoot, state.revisions[appRoot]!),
    files: [{ sha256: "a".repeat(64), bytes: new Uint8Array([1]) }],
  }));
  const upload = vi.fn(async () => {});
  const changed = vi.fn();
  const sender = createPhoneAppSender<{ workspaceId: string }>({
    enabled: async () => state.enabled,
    atHead: () => true,
    withWorkspace: (workspaceId, work) => work({ workspaceId }, new AbortController().signal),
    credentials: async () => credentials,
    apps: async () => state.apps.map((root) => site(root)),
    sourceRevision: async (_workspace, appRoot) => state.revisions[appRoot]!,
    prepare,
    relayJson,
    upload,
    changed,
  });
  return {
    sender,
    owner,
    posts,
    state,
    prepare,
    upload,
    changed,
    relayJson,
    refuseNextPublish: () => {
      refuseNextPublish = true;
    },
  };
}

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
    test.owner.set("apps/trip", {
      publicationId: "trip-1",
      authorityRevision: 1,
      sourceRevision: "r1",
    });
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
    expect(test.relayJson).not.toHaveBeenCalled();
    expect(test.prepare).not.toHaveBeenCalled();
  });

  it("withdraws the owner publication of an app folder that is gone", async () => {
    const test = harness({ apps: [], revisions: {} });
    test.owner.set("apps/old", {
      publicationId: "old-1",
      authorityRevision: 4,
      sourceRevision: "r1",
    });
    await test.sender.run("ws");
    expect(test.posts).toEqual([
      { path: "/sync/ws/app-publications/old-1/withdraw", body: { expectedAuthorityRevision: 4 } },
    ]);
    expect(test.owner.size).toBe(0);
  });

  it("files one row per app that can't be sent, waits for a change or Try again, and clears it on success", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.prepare.mockRejectedValueOnce(new Error("index.html has a syntax error."));
    await test.sender.run("ws");
    expect(test.sender.notSent("ws")).toEqual([
      { appRoot: "apps/trip", reason: "index.html has a syntax error." },
    ]);
    expect(test.changed).toHaveBeenCalledTimes(1);

    await test.sender.run("ws");
    expect(test.prepare).toHaveBeenCalledTimes(1);
    expect(test.changed).toHaveBeenCalledTimes(1);

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
    expect(test.sender.notSent("ws")).toEqual([]);
  });

  it("reads the current version again and retries once when another one was sent first", async () => {
    const test = harness({ apps: ["apps/trip"], revisions: { "apps/trip": "r1" } });
    test.refuseNextPublish();
    await test.sender.run("ws");
    expect(test.posts.map((post) => post.body.expectedCurrentPublicationId)).toEqual([
      null,
      "from-another-computer",
    ]);
    expect(test.owner.get("apps/trip")?.sourceRevision).toBe("r1");
    expect(test.sender.notSent("ws")).toEqual([]);
  });
});
