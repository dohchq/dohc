import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShareViewDaemonHarness,
  type ShareViewDaemonHarness,
} from "../testing/shareViewLoopbackTransport";
import {
  SharePinInvalidError,
  materializeSharedViewPaths,
  refreshSharedViewOnce as refreshSharedViewOnceWithPull,
} from "./sharedView";
import type { ShareViewRefusal } from "@dohc/workspace-contracts/relay";
import { createTestScratch } from "./testTemp";

// These tests drive the pull with the selector a share record pins. It is a
// REAL selector — no paths and no version selects nothing at all, which the
// engine refuses.
const PINNED_SELECTOR = { paths: ["docs"], versionId: null };

const WORKSPACE = "shared-view-ws";
const SHARE_ID = "share-1";
const TOKEN = "test:recipient";

// This file no longer references the legacy TypeScript engine at all — not by import
// and not by vi.mock. That is a stronger guarantee than a not-called spy: the
// module cannot be reached from here even indirectly. The production side is
// held by the #402 ratchet, which fails if sharedView.ts ever gains a runtime
// import of the legacy package.
//
// materializeSharedViewPaths touches exactly two store methods
// (sharedView.ts:68 ensureMainVersion, :91-104 readTextFile/readBinaryFile), so
// the two tests that drive it directly need nothing more than this.
function stubStore(
  readTextFile: () => Promise<{ text: string }>,
): Parameters<typeof materializeSharedViewPaths>[3] {
  return {
    ensureMainVersion: async () => ({ id: "main" }),
    readTextFile,
    readBinaryFile: async () => {
      throw new Error("stubStore: binary reads are not part of these two tests");
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof materializeSharedViewPaths>[3];
}

let roots: string[] = [];
let harnesses: ShareViewDaemonHarness[] = [];

beforeEach(() => {
  roots = [];
  harnesses = [];
});

afterEach(async () => {
  await Promise.all(harnesses.map((harness) => harness.closeAll()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await createTestScratch("dohc-shared-view-desktop-");
  roots.push(root);
  return root;
}

function daemonHarness(relay: FakeShareRelay): ShareViewDaemonHarness {
  const harness = createShareViewDaemonHarness(relay.connection());
  harnesses.push(harness);
  return harness;
}

// One refresh pass over the production daemon path: EngineRelayClient's
// share.view.pull for the pull, createCaptureLiveStores for the store. The
// store is opened and closed per pass exactly as the legacy fixture did, so a
// cursor that only survived inside one open session would fail the
// "unchanged" assertions below.
async function refreshSharedViewOnce(
  harness: ShareViewDaemonHarness,
  input: {
    rootDir: string;
    workspaceId: string;
    shareId: string;
    pinnedSelector?: unknown;
    recordRefusals?: (refusals: ShareViewRefusal[]) => Promise<void>;
  },
) {
  const target = { workspaceId: input.workspaceId, rootPath: input.rootDir };
  const pull = harness.pullFor(target);
  const store = harness.openStore(target);
  try {
    return await refreshSharedViewOnceWithPull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: harness.relay,
      shareId: input.shareId,
      pull,
      pinnedSelector: input.pinnedSelector ?? PINNED_SELECTOR,
      recordRefusals: input.recordRefusals ?? (async () => undefined),
      store,
    });
  } finally {
    await store.close();
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Minimal share-route double (same shape the engine share client tests use).
class FakeShareRelay {
  ops: Array<Record<string, unknown>> = [];
  blobs = new Map<string, Buffer>();
  ended = false;
  // The share metadata route is the ONLY route a re-pin could use. Counted so
  // a test can prove that a refresh never reaches it.
  metadataRequests = 0;
  private nextSeq = 1;

  // A moment the share never granted: same shape, another lineage. The pinned
  // selector follows main, so the recipient's boundary refuses this one.
  addWriteFromAnotherVersion(path: string, content: string, versionId: string): void {
    this.addWrite(path, content);
    const served = this.ops[this.ops.length - 1] as {
      payload: Record<string, unknown>;
    };
    served.payload.versionId = versionId;
  }

  addWrite(path: string, content: string): void {
    const relaySeq = this.nextSeq++;
    this.blobs.set(sha256(content), Buffer.from(content, "utf8"));
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        momentId: `moment-${relaySeq}`,
        versionId: "main",
        objectId: `object-${path}`,
        path,
        recordedAtMs: 1000 + relaySeq,
        operation: "write",
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        payloadAfterBlobSha256: sha256(content),
        payloadAfterPath: path,
        metadata: { origin: "local-file" },
        beforePresent: "null",
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  addDelete(path: string): void {
    const relaySeq = this.nextSeq++;
    this.ops.push({
      relaySeq,
      originId: "origin-granter",
      originSeq: relaySeq,
      opKind: "moment.append",
      payload: {
        momentId: `moment-${relaySeq}`,
        versionId: "main",
        objectId: `object-${path}`,
        path,
        recordedAtMs: 1000 + relaySeq,
        operation: "delete",
        payloadBeforeBlobSha256: null,
        payloadBeforePath: null,
        payloadAfterBlobSha256: sha256(""),
        payloadAfterPath: path,
        metadata: { origin: "local-file" },
        beforePresent: "present",
      },
      recordedAtMs: 1000 + relaySeq,
    });
  }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const parsed = new URL(href);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const notFound = () =>
      Response.json({ ok: false, error: "not found", code: "not_found" }, { status: 404 });
    if (this.ended) return notFound();
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] !== "sync" || parts[1] !== "shares" || parts[2] !== SHARE_ID) return notFound();
    if (parts.length === 3) {
      this.metadataRequests += 1;
      return notFound();
    }
    if (parts.length === 4 && parts[3] === "log") {
      const since = Number(parsed.searchParams.get("since") ?? 0);
      const rows = this.ops.filter((op) => Number(op.relaySeq) > since);
      const last = rows[rows.length - 1];
      return Response.json({
        ok: true,
        ops: rows,
        nextCursor: Number(last?.relaySeq ?? since),
        hasMore: false,
      });
    }
    if (parts.length === 5 && parts[3] === "blobs") {
      const blob = this.blobs.get(parts[4]!);
      if (!blob) return notFound();
      return new Response(new Uint8Array(blob), { status: 200 });
    }
    return notFound();
  };

  connection() {
    return { baseUrl: "http://relay.test", token: TOKEN, fetch: this.fetch };
  }
}

describe("shared view refresh", () => {
  it("pulls, materializes to disk, and reports honest statuses across refreshes", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "first body");
    relay.addWrite("docs/nested/deep.md", "deep body");

    const first = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(first).toEqual({
      status: "updated",
      changedPaths: 2,
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("first body");
    expect(await readFile(join(rootDir, "docs/nested/deep.md"), "utf8")).toBe("deep body");
    // The cursor moved because refreshSharedViewOnce committed it through
    // sync.commitCursor — the ONLY thing that advances it. Without this the
    // "unchanged" assertion below would pass on a pull that simply forgot to
    // ask for the ops again.
    expect(harness.transport.committedCursor(WORKSPACE)).toBe(2);

    const idle = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(idle).toEqual({
      status: "unchanged",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });

    relay.addWrite("docs/a.md", "updated body");
    relay.addDelete("docs/nested/deep.md");
    const second = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(second).toEqual({
      status: "updated",
      changedPaths: 2,
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");
    await expect(stat(join(rootDir, "docs/nested/deep.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(harness.transport.committedCursor(WORKSPACE)).toBe(4);

    // Revocation: the next refresh reports "ended" and the local files stay.
    relay.ended = true;
    const ended = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
    });
    expect(ended).toEqual({
      status: "ended",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");

    // Provable migration: the pull really went through the daemon share RPC.
    // (That no legacy store was built is structural here — this file has no
    // reference to the legacy TypeScript engine at all.)
    expect(
      harness.transport.requests.map((request) => request.method),
    ).toContain("share.view.pull");
  });

  // The pin is part of the share record's contract: both accept paths write a
  // selector before the record exists, so a record without a readable one is
  // DAMAGED. Every damaged shape must refuse the pull outright. It must not be
  // repaired from the relay — that ask is the one a relay able to damage or
  // race a record would answer with a wider scope, which is exactly the
  // widening the pin exists to stop.
  const damagedPins: Array<[string, unknown]> = [
    ["absent — the record was never written with one", undefined],
    ["null", null],
    ["not an object", "docs"],
    ["no paths array", { versionId: "v1" }],
    ["a non-string path", { paths: ["docs", 7], versionId: null }],
    // Selects NOTHING: the relay refuses to create this one
    // (`empty_selector`) and serves nothing through it.
    ["selects nothing", { paths: [], versionId: null }],
    // A version id the relay could not have issued. These are the dangerous
    // ones: the engine reads any version-bearing selector with no paths as
    // granting every tracked path, so a damaged version must never be read as
    // a version at all.
    ["an empty version id", { paths: [], versionId: "" }],
    ["a whitespace-only version id", { paths: [], versionId: "   " }],
    ["a padded version id", { paths: [], versionId: " v1 " }],
    ["an unbounded version id", { paths: [], versionId: "v".repeat(129) }],
  ];

  for (const [label, pinnedSelector] of damagedPins) {
    it(`refuses to pull when the pinned selector is ${label}`, async () => {
      const rootDir = await tempRoot();
      const relay = new FakeShareRelay();
      const harness = daemonHarness(relay);
      relay.addWrite("docs/a.md", "body the relay must not get to send");
      let pulls = 0;

      await expect(
        refreshSharedViewOnceWithPull({
          rootDir,
          workspaceId: WORKSPACE,
          relay: harness.relay,
          shareId: SHARE_ID,
          store: harness.openStore({
            workspaceId: WORKSPACE,
            rootPath: rootDir,
          }),
          pinnedSelector,
          recordRefusals: async () => undefined,
          pull: async (input) => {
            pulls += 1;
            return await harness.pullFor({
              workspaceId: WORKSPACE,
              rootPath: rootDir,
            })(input);
          },
        }),
      ).rejects.toBeInstanceOf(SharePinInvalidError);

      expect(
        pulls,
        `MUTATION: reading a ${label} pin as a grant pulls against a scope the relay never issued`,
      ).toBe(0);
      await expect(stat(join(rootDir, "docs/a.md"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await harness.closeAll();
    });
  }

  // The refusal names the constraint, so the handler above it can tell the
  // user what to do instead of reporting "refreshed, nothing new" forever.
  it("names the damaged record in the refusal", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);

    await expect(
      refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: harness.relay,
        shareId: SHARE_ID,
        store: harness.openStore({ workspaceId: WORKSPACE, rootPath: rootDir }),
        pinnedSelector: undefined,
        recordRefusals: async () => undefined,
        pull: async () => {
          throw new Error("unreachable");
        },
      }),
    ).rejects.toThrow(
      /Share share-1 has no readable pinned selector; its record is damaged and the share must be added again\./u,
    );
    await harness.closeAll();
  });

  // A pinned selector is used EXACTLY as recorded, and the relay is never
  // asked to restate it. There is no code path left that could.
  // The pull SKIPS an op it refuses and keeps going, which is the right
  // liveness call — one op a diverging relay serves must not wedge the share.
  // The cost is that the view quietly stops carrying part of what the granter
  // shares, so the refusal has to reach the caller and the user. The engine
  // produces these (see `share_view_pull_reports_why_it_skipped_a_version_
  // refused_op`); what this pins is that the refresh does not swallow them.
  //
  // The daemon double deliberately enforces no grant, so the refusal is
  // supplied here rather than provoked — provoking it would need a second
  // implementation of the boundary rule in a test double, which is how a
  // double starts certifying fiction.
  it("reports the refusals its pull returned instead of swallowing them", async () => {
    const rootDir = await tempRoot();
    const errors: string[] = [];
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      });
    try {
      const outcome = await refreshSharedViewOnceWithPull({
        rootDir,
        workspaceId: WORKSPACE,
        relay: { baseUrl: "http://relay.test", token: TOKEN },
        shareId: SHARE_ID,
        pinnedSelector: PINNED_SELECTOR,
        recordRefusals: async () => undefined,
        store: stubStore(async () => {
          throw new Error("no changed path is materialized in this test");
        }),
        pull: async () => ({
          fetched: 2,
          applied: 1,
          skipped: 1,
          refusalCount: 1,
          refusals: [
            {
              originId: "origin-granter",
              originSeq: 7,
              opKind: "moment.append",
              code: "share-boundary-violation",
              detail:
                "replicated moment is outside the share boundary: the share " +
                "granted version main, the relay offered version version-other",
            },
          ],
          changedPaths: [],
          nextCursor: 2,
          commitCursor: async () => undefined,
        }),
      });

      expect(
        outcome.refusedOps,
        "MUTATION: swallowing the refusal leaves a bare count the user never sees",
      ).toBe(1);
      expect(outcome.refusedDetail).toContain("version-other");
      // And it is logged whole, with the op it refused: the count alone
      // cannot be diagnosed.
      const log = errors.join(" | ");
      expect(log).toContain("origin-granter@7");
      expect(log).toContain("version-other");
    } finally {
      logged.mockRestore();
    }
  });

  it("pulls with the pinned selector and never asks the relay for another", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/a.md", "first body");

    const first = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
      pinnedSelector: { paths: ["docs"], versionId: null },
      recordRefusals: async () => undefined,
    });
    expect(first).toEqual({
      status: "updated",
      changedPaths: 1,
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("first body");

    relay.addWrite("docs/b.md", "second body");
    const second = await refreshSharedViewOnce(harness, {
      rootDir,
      workspaceId: WORKSPACE,
      shareId: SHARE_ID,
      pinnedSelector: { paths: ["docs"], versionId: null },
      recordRefusals: async () => undefined,
    });
    expect(second).toEqual({
      status: "updated",
      changedPaths: 1,
      refusedOps: 0,
      refusedDetail: null,
    });

    // The share metadata route is what a re-pin would have to call. Nothing
    // in a refresh touches it.
    expect(
      relay.metadataRequests,
      "MUTATION: re-fetching the selector lets the relay restate the grant on every pull",
    ).toBe(0);
  });

  // A read that fails must not cost the user the file they already had.
  // preparedTarget removes the existing projection, so reading afterwards
  // would leave a hole — and because the cursor is only committed after a
  // clean pass, every later refresh would replay into the same hole.
  it("leaves the existing projection intact when the content read fails", async () => {
    const rootDir = await tempRoot();
    const target = join(rootDir, "docs/a.md");
    await materializeSharedViewPaths(
      rootDir,
      WORKSPACE,
      [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
      stubStore(async () => ({ text: "good body" })),
    );
    expect(await readFile(target, "utf8")).toBe("good body");

    await expect(
      materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
        stubStore(async () => {
          throw new Error("over-cap text body");
        }),
      ),
    ).rejects.toThrow(/over-cap text body/);

    expect(await readFile(target, "utf8")).toBe("good body");
  });

  it("refuses to materialize a path that escapes the workspace root", async () => {
    const rootDir = await tempRoot();
    await expect(
      materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "../escape.md", operation: "write", contentKind: "text" }],
        // The refusal happens before any CONTENT read, so a store whose
        // readTextFile throws still yields the escape error. It is not before
        // every store call — `ensureMainVersion` does run first; making that
        // throw changes the error, which is how this was checked rather than
        // assumed.
        stubStore(async () => {
          throw new Error("stubStore: must not be read for an escaping path");
        }),
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });
});
