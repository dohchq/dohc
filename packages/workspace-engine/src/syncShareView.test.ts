import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceId } from "@dohc/workspace-contracts/engine";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
} from "@dohc/workspace-contracts/relay";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createVersionedTextStore } from "./versionedTextStore";
import {
  fetchShareViewInfo,
  pullShareView,
} from "./syncShareView";

const WORKSPACE = "shared-view-ws" as WorkspaceId;
const SHARE_ID = "share-1";
const TOKEN = "token-recipient";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-share-view-"));
  roots.push(root);
  return root;
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

interface FakeOp {
  relaySeq: number;
  originId: string;
  originSeq: number;
  opKind: string;
  payload: Record<string, unknown>;
  recordedAtMs: number;
}

// A hand-rolled recipient-side relay double serving the share routes the
// client uses: metadata, filtered log pages, and allowlisted blobs. Tests
// mutate `ops`/`blobs`/`ended` to simulate granter edits and revocation.
class FakeShareRelay {
  ops: FakeOp[] = [];
  blobs = new Map<string, Uint8Array>();
  ended = false;
  unauthorized = false;
  requests: string[] = [];
  private nextSeq = 1;

  addMoment(
    path: string,
    content: string | null,
    overrides: Record<string, unknown> = {},
  ): void {
    const relaySeq = this.nextSeq++;
    const contentSha = content === null ? null : sha256(content);
    if (content !== null) this.blobs.set(contentSha!, Buffer.from(content, "utf8"));
    // Mirrors the MINIMAL served payload the relay's shareFilter now emits:
    // only replay fields, author/metadata neutralized to a sync origin. No
    // momentId/objectId/versionId/summary ride along.
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        operation: content === null ? "delete" : "write",
        metadata: { origin: "sync" },
        path,
        payloadAfterPath: path,
        payloadAfterBlobSha256: contentSha ?? sha256(""),
        ...overrides,
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    this.requests.push(href);
    const parsed = new URL(href);
    const auth = new Headers(init?.headers).get("authorization");
    if (this.unauthorized || auth !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const notFound = () =>
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
    if (this.ended) return notFound();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sync" || parts[1] !== "shares" || parts[2] !== SHARE_ID) return notFound();
    if (parts.length === 3) {
      return Response.json({
        ok: true,
        shareId: SHARE_ID,
        granterUserId: "granter",
        granterEmail: "granter@dohc.test",
        selector: { paths: ["docs"], versionId: null },
        createdAtMs: 42,
      });
    }
    if (parts.length === 4 && parts[3] === "log") {
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const rows = this.ops.filter((op) => op.relaySeq > since).slice(0, limit);
      const last = rows[rows.length - 1];
      return Response.json({
        ok: true,
        ops: rows,
        nextCursor: last?.relaySeq ?? since,
        hasMore: this.ops.some((op) => op.relaySeq > (last?.relaySeq ?? since)),
      });
    }
    if (parts.length === 5 && parts[3] === "blobs") {
      const blob = this.blobs.get(parts[4]!);
      if (!blob) return notFound();
      return new Response(Buffer.from(blob), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    return notFound();
  };

  connection() {
    return { baseUrl: "http://relay.test", token: TOKEN, fetch: this.fetch };
  }
}

async function readViewFile(rootDir: string, path: string): Promise<string | null> {
  const store = createVersionedTextStore(rootDir);
  try {
    const main = await store.ensureMainVersion({ workspaceId: WORKSPACE });
    const snapshot = await store.readTextFile({
      workspaceId: WORKSPACE,
      versionId: main.id,
      path,
    });
    return snapshot?.text ?? null;
  } finally {
    await store.close();
  }
}

describe("share view client", () => {
  it("fetches share metadata and surfaces ended shares and expired sessions as typed errors", async () => {
    const relay = new FakeShareRelay();
    const info = await fetchShareViewInfo({ relay: relay.connection(), shareId: SHARE_ID });
    expect(info).toEqual({
      shareId: SHARE_ID,
      granterUserId: "granter",
      granterEmail: "granter@dohc.test",
      selector: { paths: ["docs"], versionId: null },
      createdAtMs: 42,
    });

    relay.ended = true;
    await expect(
      fetchShareViewInfo({ relay: relay.connection(), shareId: SHARE_ID }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);

    relay.ended = false;
    relay.unauthorized = true;
    await expect(
      fetchShareViewInfo({ relay: relay.connection(), shareId: SHARE_ID }),
    ).rejects.toBeInstanceOf(RelayUnauthorizedError);
  });

  it("replays shared ops into a local read-only store and follows granter edits on refresh", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/a.md", "first body");
    relay.addMoment("docs/b.md", "second body");

    const first = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(first.fetched).toBe(2);
    expect(first.applied).toBe(2);
    expect(first.changedPaths.map((entry) => [entry.path, entry.operation])).toEqual([
      ["docs/a.md", "write"],
      ["docs/b.md", "write"],
    ]);
    await first.commitCursor();
    expect(await readViewFile(rootDir, "docs/a.md")).toBe("first body");

    // Nothing new: the committed cursor makes refresh a no-op.
    const idle = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(idle.fetched).toBe(0);
    expect(idle.applied).toBe(0);

    // Granter edits and deletes; the next refresh follows.
    relay.addMoment("docs/a.md", "updated body");
    relay.addMoment("docs/b.md", null);
    const second = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(second.applied).toBe(2);
    await second.commitCursor();
    expect(await readViewFile(rootDir, "docs/a.md")).toBe("updated body");
    expect(await readViewFile(rootDir, "docs/b.md")).toBeNull();

    // The replay keeps the granter's history visible: the view's moment log
    // has one moment per replayed op. The served payload carries no author or
    // summary, so replayed moments record a neutral sync origin.
    const store = createVersionedTextStore(rootDir);
    try {
      const moments = await store.listMoments({ workspaceId: WORKSPACE });
      expect(moments.moments.length).toBeGreaterThanOrEqual(4);
      expect(moments.moments.every((moment) => moment.metadata.origin === "sync")).toBe(true);
      expect(moments.moments.every((moment) => moment.metadata.summary === undefined)).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("keeps a re-fetched but content-identical op in changedPaths so a crash before disk materialization re-materializes", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/a.md", "crash body");

    // First pull writes the store and returns the change. Simulate a crash
    // BETWEEN the store write and disk materialization: neither materialize
    // nor commitCursor runs.
    const first = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(first.applied).toBe(1);
    expect(first.changedPaths.map((entry) => entry.path)).toContain("docs/a.md");

    // The retry re-fetches the same op (cursor uncommitted). The store already
    // holds the content so nothing is applied — but the path MUST stay in the
    // change set so the caller re-materializes it to disk on retry.
    const retry = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(retry.fetched).toBe(1);
    expect(retry.applied).toBe(0);
    expect(retry.changedPaths.map((entry) => [entry.path, entry.operation])).toEqual([
      ["docs/a.md", "write"],
    ]);
  });

  it("re-replays an uncommitted delta idempotently (crash between apply and cursor commit)", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/a.md", "body one");

    const first = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(first.applied).toBe(1);
    // Simulate a crash: commitCursor never runs. The retry re-fetches the
    // same delta but applies nothing (content-identical replay).
    const retry = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(retry.fetched).toBe(1);
    expect(retry.applied).toBe(0);
    await retry.commitCursor();
    expect(await readViewFile(rootDir, "docs/a.md")).toBe("body one");
  });

  it("replays renames as delete+write so moved content lands at the new path", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/old.md", "movable body");
    relay.addMoment("docs/new.md", "movable body", {
      operation: "rename",
      path: "docs/new.md",
      payloadBeforePath: "docs/old.md",
      payloadAfterPath: "docs/new.md",
    });

    const result = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    await result.commitCursor();
    expect(await readViewFile(rootDir, "docs/old.md")).toBeNull();
    expect(await readViewFile(rootDir, "docs/new.md")).toBe("movable body");
  });

  it("seeds a version share's initial state from redacted fork snapshots", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const body = "forked snapshot body";
    relay.blobs.set(sha256(body), Buffer.from(body, "utf8"));
    relay.ops.push({
      relaySeq: 1,
      originId: "origin-granter",
      originSeq: 1,
      opKind: "version.create",
      payload: {
        versionId: "version-1",
        name: "review",
        kind: "named",
        createdAtMs: 5,
        forkSnapshots: [
          {
            objectId: "o1",
            path: "docs/spec.md",
            blobSha256: sha256(body),
            updatedAtMs: 5,
            latestMomentId: "m1",
            metadata: { origin: "local-file" },
          },
        ],
      },
      recordedAtMs: 1001,
    });

    const result = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(result.applied).toBe(1);
    expect(await readViewFile(rootDir, "docs/spec.md")).toBe(body);
  });

  it("defends in depth: secret-classified or invalid paths from a misbehaving relay are never replayed", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/.env", "SECRET=1");
    relay.addMoment("docs/.env.local", "SECRET=2");
    relay.addMoment("../escape.md", "outside");
    relay.addMoment("docs/fine.md", "fine");

    const result = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    await result.commitCursor();
    expect(result.applied).toBe(1);
    expect(await readViewFile(rootDir, "docs/fine.md")).toBe("fine");
    expect(await readViewFile(rootDir, "docs/.env")).toBeNull();
    // The blob bytes of the skipped ops were never even requested.
    expect(relay.requests.filter((href) => href.includes(sha256("SECRET=1")))).toEqual([]);
  });

  it("surfaces revocation on refresh as ShareUnavailableError without touching local state", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addMoment("docs/a.md", "kept body");
    const first = await pullShareView({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    await first.commitCursor();

    relay.ended = true;
    await expect(
      pullShareView({
        rootDir,
        workspaceId: WORKSPACE,
        relay: relay.connection(),
        shareId: SHARE_ID,
      }),
    ).rejects.toBeInstanceOf(ShareUnavailableError);
    // The local copy still reads (the desktop archives the view, it does not
    // destroy the user's last-known files).
    expect(await readViewFile(rootDir, "docs/a.md")).toBe("kept body");
  });
});
