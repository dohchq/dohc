import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import {
  RefreshShareMountsResult,
  ShareMountStatusRow,
} from "../ipc/bridgeContract";
import { SharePinInvalidError } from "./shareViewRecords";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShareViewDaemonHarness,
  type ShareViewDaemonHarness,
} from "../testing/shareViewLoopbackTransport";
import {
  assertMountableSelector,
  allocateShareMountLabel,
  classifyShareMountRefreshError,
  shareMountResultRow,
  mountRootFor,
  mountStoreWorkspaceIdFor,
  refuseImportIntoShareProjection,
  refuseMoveAcrossShareMount,
  resolveShareMountPath,
  resolveShareProjectionPath,
  overlayCanonicalShareMountFiles,
  planShareMountRemoval,
  usableShareMountRecord,
  validMountLabel,
} from "./shareMounts";
import {
  createShareMountDirectoryThroughOwnerForTest as createMountDirectory,
  refreshShareMountThroughOwnerForTest,
  removeShareMountFolderThroughOwnerForTest as removeMountFolder,
} from "../testing/shareViewFilesMountHarness";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// These tests drive the pull with the selector a mount record pins. No paths
// selects the whole tracked workspace only WITH a version — no paths and no
// version selects nothing at all, which the engine refuses.
const PINNED_SELECTOR = {
  paths: [],
  versionId: "shared-version",
  access: "view",
} as const;
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import { createTestScratch } from "./testTemp";

const SHARE_ID = "share-1";
const HOST_WORKSPACE = "host-workspace-1";
const TOKEN = "test:recipient";

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

async function tempHostRoot(): Promise<string> {
  const root = await createTestScratch("dohc-share-mounts-");
  roots.push(root);
  return root;
}

function daemonHarness(relay: FakeShareRelay): ShareViewDaemonHarness {
  const harness = createShareViewDaemonHarness(relay.connection());
  harnesses.push(harness);
  return harness;
}

// Production `mountShare` creates the mount folder before the first refresh.
// The legacy fixture got that for free — opening a SQLite store created its
// parent directories — while a daemon `workspace.open` needs the directory to
// already be a real one.
async function ensureMountFolder(hostRoot: string, label: string): Promise<void> {
  if (existsSync(mountRootFor(hostRoot, label))) return;
  await createMountDirectory(hostRoot, label);
}

// One mount refresh over the production daemon path: EngineRelayClient's
// share.view.pull for the pull, createCaptureLiveStores for the mount's nested
// store. Binding the relay route before the refresh is what production does
// too (see engineRelayClient.test.ts), and it is what makes `workspace.open`
// carry the mount's relay configuration and captureMode.
async function refreshShareMount(
  harness: ShareViewDaemonHarness,
  input: {
    hostRoot: string;
    mount: { shareId: string; label: string };
    pinnedSelector?: unknown;
    openStore?: (workspace: {
      workspaceId: string;
      rootPath: string;
    }) => CaptureVersionedTextStore;
  },
) {
  await ensureMountFolder(input.hostRoot, input.mount.label);
  const target = {
    workspaceId: mountStoreWorkspaceIdFor(HOST_WORKSPACE, input.mount.shareId),
    rootPath: mountRootFor(input.hostRoot, input.mount.label),
    shareMount: true as const,
  };
  const pull = harness.pullFor(target);
  return await refreshShareMountThroughOwnerForTest({
    hostWorkspaceId: HOST_WORKSPACE,
    hostRoot: input.hostRoot,
    mount: input.mount,
    relay: harness.relay,
    pull,
    pinnedSelector: input.pinnedSelector ?? PINNED_SELECTOR,
    recordRefusals: async () => undefined,
    openStore: input.openStore ?? harness.openStore,
  });
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// Same minimal share-route double as sharedView.test.ts.
class FakeShareRelay {
  ops: Array<Record<string, unknown>> = [];
  blobs = new Map<string, Buffer>();
  ended = false;
  private nextSeq = 1;

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

describe("mount labels", () => {
  it("derives a safe label from the granter email and deduplicates", () => {
    const allocate = (
      granterEmail: string | null,
      onDiskNames: readonly string[] = [],
    ) =>
      allocateShareMountLabel({
        storedMounts: [],
        onDiskNames,
        granterEmail,
      });
    expect(allocate("alex@example.com")).toBe("alex");
    expect(allocate("alex@example.com", ["alex"])).toBe("alex (2)");
    expect(allocate("alex@example.com", ["alex", "alex (2)"])).toBe(
      "alex (3)",
    );
    expect(allocate("Wild! Chars?@x.com")).toBe("wild-chars");
    expect(allocate(null)).toBe("share");
    expect(allocate("...@x.com")).toBe("share");
    // A secret-shaped local part must not become a label the read
    // classifier would suppress (prod.env -> secret).
    expect(allocate("prod.env@example.com")).toBe("prod-env");
    expect(allocate(".env@example.com")).toBe("env");
  });

  it("reserves every string label held by damaged registry records", () => {
    const damaged = [
      { shareId: SHARE_ID, label: "alex" },
      { shareId: SHARE_ID, label: "sam" },
      { shareId: 7, label: "alex (2)" },
      { shareId: "missing-label", label: null },
    ];
    expect(usableShareMountRecord(damaged, damaged[0]!)).toBe(false);
    expect(usableShareMountRecord(damaged, damaged[1]!)).toBe(false);
    expect(usableShareMountRecord(damaged, damaged[2]!)).toBe(false);

    expect(
      allocateShareMountLabel({
        storedMounts: damaged,
        onDiskNames: [],
        granterEmail: "alex@example.com",
      }),
    ).toBe("alex (3)");
  });

  it("reserves on-disk names in the same allocation", () => {
    expect(
      allocateShareMountLabel({
        storedMounts: [{ shareId: "share-a", label: "alex" }],
        onDiskNames: ["alex (2)"],
        granterEmail: "alex@example.com",
      }),
    ).toBe("alex (3)");
  });

  it("refuses traversal, separators, reserved and secret-shaped labels", () => {
    for (const label of ["", "..", "a/b", "a\\b", ".dohc", "x".repeat(65), ". .", ".env", "prod.env"]) {
      expect(validMountLabel(label)).toBe(false);
    }
    expect(validMountLabel("alex (2)")).toBe(true);
    expect(validMountLabel("prod-env")).toBe(true);
  });

  // Daemon sessions and relay routes are keyed by workspace id ALONE, and the
  // session cache returns a binding without comparing rootPath. So two host
  // workspaces mounting the same share must not derive the same id, or the
  // second refresh reuses a connection bound to the first host's folder and
  // can read one host's store while writing into the other's tree.
  it("gives the same share a different store identity in each host workspace", () => {
    const a = mountStoreWorkspaceIdFor("host-a", SHARE_ID);
    const b = mountStoreWorkspaceIdFor("host-b", SHARE_ID);
    expect(a).not.toBe(b);

    // Same host + same share is stable, so a refresh reuses its own session
    // rather than leaking a new daemon workspace every pass.
    expect(mountStoreWorkspaceIdFor("host-a", SHARE_ID)).toBe(a);

    // The host is a fixed-width digest, not a raw id: concatenating two opaque
    // ids with a separator would let these two distinct pairs collide.
    expect(mountStoreWorkspaceIdFor("host-a", "s")).not.toBe(
      mountStoreWorkspaceIdFor("host", "a-s"),
    );

    // Two different shares in ONE host stay distinct too.
    expect(mountStoreWorkspaceIdFor("host-a", "share-2")).not.toBe(a);
  });

  it("mountRootFor refuses labels that escape shared-with-me", async () => {
    const host = await tempHostRoot();
    expect(() => mountRootFor(host, "../outside")).toThrow(/Invalid share mount label/);
    expect(() => mountRootFor(host, "a/b")).toThrow(/Invalid share mount label/);
    expect(mountRootFor(host, "alex")).toBe(
      join(host, SHARED_WITH_ME_FOLDER, "alex"),
    );
    // MUTATION (..-segment): a bare "..-prefix" isInside refuses this real contained name.
    expect(mountRootFor(host, "..cache")).toBe(
      join(host, SHARED_WITH_ME_FOLDER, "..cache"),
    );
  });

  it("routes a symlinked spelling to the mount that owns its real path", async () => {
    const host = await tempHostRoot();
    await createMountDirectory(host, "alex");
    await mkdir(join(mountRootFor(host, "alex"), "docs"), { recursive: true });
    await symlink(mountRootFor(host, "alex"), join(host, "inbox"), "dir");
    const mount = { shareId: SHARE_ID, label: "alex" };

    await expect(
      resolveShareMountPath(host, "shared-with-me/alex", [mount], true),
    ).resolves.toEqual({ mount, path: "" });
    await expect(
      resolveShareMountPath(host, "inbox", [mount], true),
    ).resolves.toEqual({ mount, path: "" });
    await expect(
      resolveShareMountPath(host, "inbox/docs/brief.md", [mount], true),
    ).resolves.toEqual({ mount, path: "docs/brief.md" });
    await expect(
      resolveShareMountPath(host, "notes/ordinary.md", [mount], true),
    ).resolves.toBeNull();
  });

  it("classifies aliases to the projection and workspace roots", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER), { recursive: true });
    await symlink(
      join(host, SHARED_WITH_ME_FOLDER),
      join(host, "projection-alias"),
      "dir",
    );
    await symlink(host, join(host, "workspace-alias"), "dir");

    await expect(
      resolveShareProjectionPath(host, "projection-alias", []),
    ).resolves.toEqual({ kind: "projection-root" });
    await expect(
      resolveShareProjectionPath(host, "workspace-alias", []),
    ).resolves.toEqual({ kind: "workspace-root" });
  });

  it("refuses a disk path claimed by an invalid registry label", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, ".env", "docs"), {
      recursive: true,
    });

    await expect(
      resolveShareMountPath(
        host,
        "shared-with-me/.env/docs/brief.md",
        [{ shareId: SHARE_ID, label: ".env" }],
        true,
      ),
      "MUTATION: skipping an invalid matching label lets the caller read the projection from disk",
    ).rejects.toThrow(/saved details are invalid/);
  });

  it("refuses an unclaimed projection path when a mount registry exists", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "orphan", "docs"), {
      recursive: true,
    });

    await expect(
      resolveShareMountPath(
        host,
        "shared-with-me/orphan/docs/brief.md",
        [],
        true,
      ),
      "MUTATION: an empty but present registry lets stale projection bytes fall through to disk",
    ).rejects.toThrow(
      "dohc cannot use this path because no share owns it. Add the share again, or move the file or folder outside shared-with-me/.",
    );
  });

  it("refuses a disk path claimed by more than one registry record", async () => {
    const host = await tempHostRoot();
    await createMountDirectory(host, "alex");
    const labels = ["alex", "Alex"];

    await expect(
      resolveShareMountPath(
        host,
        "shared-with-me/alex/docs/brief.md",
        labels.map((label, index) => ({
          shareId: `share-${index + 1}`,
          label,
        })),
        true,
      ),
      "MUTATION: first-match routing sends an ambiguous mount path to an arbitrary share",
    ).rejects.toThrow(/saved details are invalid/);
  });

  it("never gives case-colliding labels separate owner authority", () => {
    const mounts = [
      { shareId: "first", label: "alex" },
      { shareId: "second", label: "Alex" },
    ];

    expect(usableShareMountRecord(mounts, mounts[0]!)).toBe(false);
    expect(usableShareMountRecord(mounts, mounts[1]!)).toBe(false);
  });

  it("plans ambiguous or unusable records for registry-only removal", () => {
    const healthy = { shareId: "healthy", label: "healthy" };
    const duplicateOne = { shareId: SHARE_ID, label: "alex" };
    const duplicateTwo = { shareId: SHARE_ID, label: "sam" };
    expect(
      planShareMountRemoval(
        [healthy, duplicateOne, duplicateTwo],
        SHARE_ID,
      ),
    ).toEqual({ kind: "registry-only", remaining: [healthy] });
    expect(
      planShareMountRemoval(
        [healthy, { shareId: "damaged", label: ".env" }],
        "damaged",
      ),
    ).toEqual({ kind: "registry-only", remaining: [healthy] });
    expect(planShareMountRemoval([healthy], "missing")).toEqual({
      kind: "missing",
    });
  });

  it("refuses a move when either resolved endpoint belongs to a mount", async () => {
    const host = await tempHostRoot();
    await createMountDirectory(host, "alex");
    await mkdir(join(mountRootFor(host, "alex"), "docs"), { recursive: true });
    await symlink(mountRootFor(host, "alex"), join(host, "inbox"), "dir");
    const mounts = [{ shareId: SHARE_ID, label: "alex" }];

    await expect(
      refuseMoveAcrossShareMount(
        host,
        "notes/local.md",
        "inbox/docs/local.md",
        mounts,
        true,
      ),
    ).rejects.toThrow(/mounted share is read-only/i);
    await expect(
      refuseMoveAcrossShareMount(
        host,
        "inbox/docs/shared.md",
        "notes/shared.md",
        mounts,
        true,
      ),
    ).rejects.toThrow(/mounted share is read-only/i);
    await expect(
      refuseMoveAcrossShareMount(
        host,
        "notes/a.md",
        "notes/b.md",
        mounts,
        true,
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a move into stale projection bytes after the final unmount", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "orphan"), {
      recursive: true,
    });

    await expect(
      refuseMoveAcrossShareMount(
        host,
        "notes/local.md",
        "shared-with-me/orphan/local.md",
        [],
        true,
      ),
    ).rejects.toThrow(/no share owns it/i);
  });

  it("refuses imports into a mount through its projection path or an alias", async () => {
    const host = await tempHostRoot();
    await createMountDirectory(host, "alex");
    await symlink(mountRootFor(host, "alex"), join(host, "inbox"), "dir");
    const mounts = [{ shareId: SHARE_ID, label: "alex" }];

    await expect(
      refuseImportIntoShareProjection(
        host,
        "shared-with-me/alex",
        mounts,
        true,
      ),
    ).rejects.toThrow(/mounted share is read-only/i);
    await expect(
      refuseImportIntoShareProjection(host, "inbox", mounts, true),
    ).rejects.toThrow(/mounted share is read-only/i);
    await expect(
      refuseImportIntoShareProjection(host, "notes", mounts, true),
    ).resolves.toBeUndefined();
  });

  it("refuses imports into unowned projection paths when share state remains", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "orphan"), {
      recursive: true,
    });
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, ".env"), {
      recursive: true,
    });
    await symlink(
      join(host, SHARED_WITH_ME_FOLDER),
      join(host, "projection-alias"),
      "dir",
    );

    await expect(
      refuseImportIntoShareProjection(
        host,
        "shared-with-me/orphan",
        [],
        true,
      ),
      "MUTATION: an empty ownership tombstone must not turn stale projection bytes into a local import destination",
    ).rejects.toThrow(/no share owns it/i);
    await expect(
      refuseImportIntoShareProjection(host, "projection-alias", [], true),
      "MUTATION: a projection alias must not bypass an empty ownership tombstone",
    ).rejects.toThrow(/mounted share is read-only/i);
    await expect(
      refuseImportIntoShareProjection(
        host,
        "shared-with-me/.env",
        [{ shareId: SHARE_ID, label: ".env" }],
        true,
      ),
      "MUTATION: a matched but unusable record must not let its projection become a local import destination",
    ).rejects.toThrow(/saved details are invalid/i);
  });

  it("isolates a failed canonical listing to its mount", async () => {
    const failures: string[] = [];
    const mounts = [
      { shareId: "damaged", label: "alex" },
      { shareId: "healthy", label: "sam" },
    ];

    await expect(
      overlayCanonicalShareMountFiles({
        disk: {
          files: [
            { path: "notes/local.md", size: 5 },
            { path: "shared-with-me/alex/recipient-only.md", size: 10 },
            { path: "shared-with-me/sam/stale.md", size: 11 },
          ],
          folders: [
            "notes",
            "shared-with-me/alex",
            "shared-with-me/sam",
          ],
        },
        mounts,
        listCanonical: async (mount) => {
          if (mount.shareId === "damaged") throw new Error("broken store");
          return {
            files: [{ path: "docs/canonical.md", size: 12 }],
            folders: ["docs"],
          };
        },
        onFailure: (mount) => failures.push(mount.shareId),
      }),
    ).resolves.toEqual({
      files: [
        { path: "notes/local.md", size: 5 },
        { path: "shared-with-me/sam/docs/canonical.md", size: 12 },
      ],
      folders: [
        "notes",
        "shared-with-me/alex",
        "shared-with-me/sam",
        "shared-with-me/sam/docs",
      ],
    });
    expect(failures).toEqual(["damaged"]);
  });

  it("hides disk entries for an invalid mount record", async () => {
    const listCanonical = vi.fn();
    const failures: unknown[] = [];

    await expect(
      overlayCanonicalShareMountFiles({
        disk: {
          files: [
            { path: "notes/local.md", size: 5 },
            { path: "shared-with-me/.env/recipient-only.md", size: 10 },
          ],
          folders: ["notes", "shared-with-me/.env"],
        },
        mounts: [{ shareId: "invalid", label: ".env" }],
        listCanonical,
        onFailure: (_mount, error) => failures.push(error),
      }),
    ).resolves.toEqual({
      files: [{ path: "notes/local.md", size: 5 }],
      folders: ["notes"],
    });
    expect(listCanonical).not.toHaveBeenCalled();
    expect(failures).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/invalid/i) }),
    ]);
  });

  it("keeps local files but hides the projection for an empty owner set", async () => {
    await expect(
      overlayCanonicalShareMountFiles({
        disk: {
          files: [
            { path: "notes/local.md" },
            { path: "shared-with-me/orphan/recipient-only.md" },
          ],
          folders: ["notes", "shared-with-me/orphan"],
        },
        mounts: [],
        listCanonical: async () => ({ files: [] }),
      }),
    ).resolves.toEqual({
      files: [{ path: "notes/local.md" }],
      folders: ["notes"],
    });
  });

  it("hides an ambiguous projection claimed by two mount records", async () => {
    const listCanonical = vi.fn();
    const mounts = [
      { shareId: "first", label: "owner" },
      { shareId: "second", label: "owner" },
    ];

    await expect(
      overlayCanonicalShareMountFiles({
        disk: {
          files: [{ path: "shared-with-me/owner/stale.md" }],
          folders: ["shared-with-me/owner"],
        },
        mounts,
        listCanonical,
      }),
    ).resolves.toEqual({ files: [], folders: [] });
    expect(listCanonical).not.toHaveBeenCalled();
  });

  it("contains malformed records and still overlays a later healthy mount", async () => {
    const failures: unknown[] = [];
    const malformed = { shareId: "damaged", label: null } as never;
    const healthy = { shareId: "healthy", label: "healthy" };

    await expect(
      overlayCanonicalShareMountFiles({
        disk: {
          files: [
            { path: "shared-with-me/unknown/recipient-only.md" },
            { path: "shared-with-me/healthy/stale.md" },
          ],
          folders: ["shared-with-me/unknown", "shared-with-me/healthy"],
        },
        mounts: [malformed, healthy],
        listCanonical: async (mount) => ({
          files: [{ path: `${mount.shareId}.md` }],
        }),
        onFailure: (_mount, error) => failures.push(error),
      }),
    ).resolves.toEqual({
      files: [{ path: "shared-with-me/healthy/healthy.md" }],
      folders: ["shared-with-me/healthy"],
    });
    expect(failures).toHaveLength(1);
  });
});

describe("refreshShareMount", () => {
  it("materializes shared files under shared-with-me/<label>/ and reports statuses", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "the brief");
    relay.addWrite("docs/deep/notes.md", "deep notes");

    const first = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(first.status).toBe("updated");
    expect(first.changedPaths).toBe(2);
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe("the brief");
    expect(await readFile(join(mountRoot, "docs/deep/notes.md"), "utf8")).toBe(
      "deep notes",
    );
    expect(harness.transport.requests).toContainEqual(
      expect.objectContaining({
        method: "workspace.open",
        params: expect.objectContaining({
          workspaceId: mountStoreWorkspaceIdFor(HOST_WORKSPACE, SHARE_ID),
          rootDir: mountRoot,
        }),
      }),
    );

    const second = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(second).toEqual({
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });

    relay.addWrite("docs/brief.md", "the brief v2");
    const third = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(third.status).toBe("updated");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe(
      "the brief v2",
    );
  });

  // The mount closes its own store, and that close is now an RPC that can
  // fail. It must stay best-effort: mountShare treats a rejection here as a
  // failed mount and DELETES the folder, so a dying sidecar after a committed
  // cursor would destroy files that had already materialized.
  it("keeps a successful refresh when closing the mount's store fails", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "the brief");

    const outcome = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      openStore: (workspace) => {
        const store = harness.openStore(workspace);
        // Release the session first, then fail the way a dying sidecar would
        // once its close RPC has already landed.
        const realClose = store.close.bind(store);
        return Object.assign(store, {
          close: async () => {
            await realClose();
            throw new Error("daemon went away during close");
          },
        });
      },
    });

    expect(outcome).toEqual({
      status: "updated",
      changedPaths: 1,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(
      await readFile(join(host, SHARED_WITH_ME_FOLDER, "alex/docs/brief.md"), "utf8"),
    ).toBe("the brief");
  });

  it("reports ended on revocation and leaves the files untouched", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("plan.md", "keep me");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });

    relay.ended = true;
    const outcome = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(outcome).toEqual({
      status: "ended",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
    expect(
      await readFile(join(host, SHARED_WITH_ME_FOLDER, "alex", "plan.md"), "utf8"),
    ).toBe("keep me");
  });

  it("refuses a symlinked shared-with-me or label directory (real-path guard)", async () => {
    const elsewhere = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "the brief");

    // Symlinked container: shared-with-me itself points outside.
    const hostA = await tempHostRoot();
    await symlink(elsewhere, join(hostA, SHARED_WITH_ME_FOLDER), "dir");
    await expect(
      refreshShareMount(harness, {
        hostRoot: hostA,
        mount: { shareId: SHARE_ID, label: "alex" },
      }),
    ).rejects.toThrow(/not a real directory/);
    expect(existsSync(join(elsewhere, "alex"))).toBe(false);

    // Symlinked label directory inside a real shared-with-me.
    const hostB = await tempHostRoot();
    await mkdir(join(hostB, SHARED_WITH_ME_FOLDER), { recursive: true });
    await symlink(elsewhere, join(hostB, SHARED_WITH_ME_FOLDER, "alex"), "dir");
    await expect(
      refreshShareMount(harness, {
        hostRoot: hostB,
        mount: { shareId: SHARE_ID, label: "alex" },
      }),
    ).rejects.toThrow(/not a real directory/);
    expect(existsSync(join(elsewhere, "docs"))).toBe(false);
    expect(harness.transport.requests).toEqual([]);
  });

  it("never follows a symlink planted INSIDE the mount (directory or file)", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "v1");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");

    // A planted FILE symlink at a materialized path is deleted, not
    // followed: the update lands as a fresh regular file.
    await writeFile(join(elsewhere, "victim.md"), "untouched");
    await rm(join(mountRoot, "docs/brief.md"));
    await symlink(join(elsewhere, "victim.md"), join(mountRoot, "docs/brief.md"), "file");
    relay.addWrite("docs/brief.md", "v2");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(await readFile(join(elsewhere, "victim.md"), "utf8")).toBe("untouched");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe("v2");

    // A planted DIRECTORY symlink on the write path SELF-HEALS: the repair
    // pass removes the link (as a link), rebuilds the real tree, and the
    // pull lands v3 inside the workspace — never a byte through the link.
    await rm(join(mountRoot, "docs"), { recursive: true, force: true });
    await symlink(elsewhere, join(mountRoot, "docs"), "dir");
    relay.addWrite("docs/brief.md", "v3");
    const healed = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(healed.status).toBe("updated");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe("v3");
    expect(existsSync(join(elsewhere, "brief.md"))).toBe(false);
  });

  it("repairs local tampering on refresh even when the relay has nothing new", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "authoritative");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mounted = join(host, SHARED_WITH_ME_FOLDER, "alex", "docs/brief.md");
    const target = {
      workspaceId: mountStoreWorkspaceIdFor(HOST_WORKSPACE, SHARE_ID),
      rootPath: mountRootFor(host, "alex"),
      shareMount: true as const,
    };
    const storeBefore = harness.openStore(target);
    const momentIdsBefore = (
      await storeBefore.listMoments({ workspaceId: target.workspaceId, limit: 100 })
    ).moments.map((moment) => moment.id);
    expect(momentIdsBefore.length).toBeGreaterThan(0);
    await storeBefore.close();

    // A rogue tool edits the mounted file directly; the relay is unchanged.
    await writeFile(mounted, "defaced");
    const repaired = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(repaired.status).toBe("updated");
    expect(repaired.changedPaths).toBe(1);
    expect(await readFile(mounted, "utf8")).toBe("authoritative");
    const storeAfter = harness.openStore(target);
    expect(
      (
        await storeAfter.listMoments({ workspaceId: target.workspaceId, limit: 100 })
      ).moments.map((moment) => moment.id),
    ).toEqual(momentIdsBefore);
    await storeAfter.close();

    // Deleting the file locally is repaired the same way.
    const storeBeforeDelete = harness.openStore(target);
    const momentIdsBeforeDelete = (
      await storeBeforeDelete.listMoments({
        workspaceId: target.workspaceId,
        limit: 100,
      })
    ).moments.map((moment) => moment.id);
    expect(momentIdsBeforeDelete.length).toBeGreaterThan(0);
    await storeBeforeDelete.close();
    await rm(mounted);
    const restored = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(restored.status).toBe("updated");
    expect(restored.changedPaths).toBe(1);
    expect(await readFile(mounted, "utf8")).toBe("authoritative");
    const storeAfterDelete = harness.openStore(target);
    expect(
      (
        await storeAfterDelete.listMoments({
          workspaceId: target.workspaceId,
          limit: 100,
        })
      ).moments.map((moment) => moment.id),
    ).toEqual(momentIdsBeforeDelete);
    await storeAfterDelete.close();

    // An untouched projection stays "unchanged" — no busy repainting.
    const quiet = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(quiet).toEqual({
      status: "unchanged",
      changedPaths: 0,
      excludedPaths: [],
      unjournalablePaths: [],
      refusedOps: 0,
      refusedDetail: null,
    });
  });

  it("creates NOTHING outside the workspace when a dir symlink sits on a deep write path", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/top.md", "v1");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");
    await rm(join(mountRoot, "docs"), { recursive: true, force: true });
    await symlink(elsewhere, join(mountRoot, "docs"), "dir");
    // The granter writes a DEEP path: the repair pass heals the planted
    // link first, so the deep write lands inside the workspace and nothing
    // is ever created through the link.
    relay.addWrite("docs/deep/file.md", "payload");
    const outcome = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(outcome.status).toBe("updated");
    expect(
      await readFile(join(mountRoot, "docs/deep/file.md"), "utf8"),
    ).toBe("payload");
    expect(existsSync(join(elsewhere, "deep"))).toBe(false);
  });

  it("unmount removes a tampered symlinked mount root as a link (never through it)", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    await writeFile(join(elsewhere, "victim.md"), "untouched");
    await mkdir(join(host, SHARED_WITH_ME_FOLDER), { recursive: true });
    await symlink(elsewhere, join(host, SHARED_WITH_ME_FOLDER, "alex"), "dir");

    await removeMountFolder(host, "alex");

    expect(existsSync(join(host, SHARED_WITH_ME_FOLDER, "alex"))).toBe(false);
    expect(await readFile(join(elsewhere, "victim.md"), "utf8")).toBe("untouched");
  });

  it("heals a FILE squatting on an ancestor directory path", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "v1");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");

    // Replace the docs DIRECTORY with a plain file; the next refresh must
    // rebuild the real chain instead of wedging on ENOTDIR.
    await rm(join(mountRoot, "docs"), { recursive: true, force: true });
    await writeFile(join(mountRoot, "docs"), "squatter");
    const healed = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(healed.status).toBe("updated");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe("v1");
  });

  it("routes DELETE ops through the same real-parent containment", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "v1");
    await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");

    // Plant a directory symlink where the granter's delete will point: the
    // repair pass heals the link first, the delete lands on the REAL tree,
    // and the file behind the link is never touched.
    await writeFile(join(elsewhere, "brief.md"), "victim");
    await rm(join(mountRoot, "docs"), { recursive: true, force: true });
    await symlink(elsewhere, join(mountRoot, "docs"), "dir");
    relay.addDelete("docs/brief.md");
    const outcome = await refreshShareMount(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(outcome.status).toBe("updated");
    expect(existsSync(join(mountRoot, "docs/brief.md"))).toBe(false);
    expect(await readFile(join(elsewhere, "brief.md"), "utf8")).toBe("victim");
  });

  it("createMountDirectory refuses a symlinked container BEFORE any write", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    await symlink(elsewhere, join(host, SHARED_WITH_ME_FOLDER), "dir");
    await expect(createMountDirectory(host, "alex")).rejects.toThrow(
      /not a real directory/,
    );
    // The guard ran before mkdir: nothing was created through the link.
    expect(existsSync(join(elsewhere, "alex"))).toBe(false);
  });

  it("createMountDirectory never adopts an existing folder (exclusive create)", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await expect(createMountDirectory(host, "alex")).rejects.toThrow();
    await createMountDirectory(host, "sam");
    expect(existsSync(join(host, SHARED_WITH_ME_FOLDER, "sam"))).toBe(true);
  });

  it("refuses to mount a selector with no file content (chat-channel codes)", () => {
    expect(() => assertMountableSelector(null)).toThrow(/shared chat channel/);
    expect(() =>
      assertMountableSelector({
        paths: ["docs"],
        versionId: null,
        access: "view",
      }),
    ).not.toThrow();
    expect(() =>
      assertMountableSelector({
        paths: [],
        versionId: "main",
        access: "comment",
      }),
    ).not.toThrow();
  });

  it("refuses to refresh a mount whose registry label was tampered into traversal", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    await expect(
      refreshShareMount(harness, {
        hostRoot: host,
        mount: { shareId: SHARE_ID, label: "../../etc" },
      }),
    ).rejects.toThrow(/Invalid share mount label/);
    expect(harness.transport.requests).toEqual([]);
  });
});

describe("removeMountFolder", () => {
  it("removes exactly the mount folder", async () => {
    const host = await tempHostRoot();
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "alex"), { recursive: true });
    await mkdir(join(host, SHARED_WITH_ME_FOLDER, "sam"), { recursive: true });
    await writeFile(join(host, SHARED_WITH_ME_FOLDER, "alex", "a.md"), "x");
    await writeFile(join(host, SHARED_WITH_ME_FOLDER, "sam", "s.md"), "y");

    await removeMountFolder(host, "alex");

    expect(existsSync(join(host, SHARED_WITH_ME_FOLDER, "alex"))).toBe(false);
    expect(existsSync(join(host, SHARED_WITH_ME_FOLDER, "sam", "s.md"))).toBe(true);
  });

  it("refuses tampered labels", async () => {
    const host = await tempHostRoot();
    await expect(removeMountFolder(host, "..")).rejects.toThrow(
      /Invalid share mount label/,
    );
  });

  it("leaves the folder present when the container is a symlink", async () => {
    const host = await tempHostRoot();
    const elsewhere = await tempHostRoot();
    await mkdir(join(elsewhere, "alex"));
    await writeFile(join(elsewhere, "alex", "victim.md"), "untouched");
    await symlink(elsewhere, join(host, SHARED_WITH_ME_FOLDER), "dir");

    await expect(
      removeMountFolder(host, "alex"),
    ).resolves.toMatchObject({ folderLeft: true, error: expect.any(Error) });
    expect(await readFile(join(elsewhere, "alex", "victim.md"), "utf8")).toBe(
      "untouched",
    );
  });
});

// One mount's permanent failure must stay ONE mount's failure. A damaged pin
// used to throw out of the refresh loop, so a single damaged record stopped
// every healthy share after it from refreshing at all.
describe("share mount refresh failures", () => {
  it("contains a damaged pin to its own row and keeps the loop going", () => {
    expect(
      classifyShareMountRefreshError(new SharePinInvalidError("share-1")),
      "MUTATION: a damaged pin abandons every mount after it",
    ).toEqual({ kind: "row", status: "damaged" });
  });

  it("does not hide a damaged mount behind unchanged", () => {
    const verdict = classifyShareMountRefreshError(new SharePinInvalidError("s"));
    expect(verdict.kind === "row" && verdict.status).not.toBe("unchanged");
  });

  // The one failure that DOES make every remaining pull pointless.
  it("abandons the refresh only when the session expired", () => {
    expect(classifyShareMountRefreshError(new RelayUnauthorizedError())).toEqual({
      kind: "abort",
      message: "Your dohc Cloud session expired. Sign in again, then refresh shares.",
    });
  });

  it("reports an ordinary failure as unchanged and moves on", () => {
    for (const error of [new Error("offline"), "nonsense", null]) {
      expect(classifyShareMountRefreshError(error)).toEqual({
        kind: "row",
        status: "unchanged",
      });
    }
  });
});

// The wire schema is the seam a status has to survive, and it is where the
// mount handler bug hid too: main built a value the schema could not carry,
// unit suites tested each side alone, and nothing drove one through the
// other. A status main can emit but the result cannot parse is containment
// that defeats itself at the boundary.
describe("refresh result wire shape", () => {
  const row = (status: string) => ({
    shareId: "share-1",
    label: "alex",
    status,
    changedPaths: 0,
  });

  it("carries every status the refresh loop can emit", () => {
    for (const status of ["updated", "unchanged", "ended", "damaged"]) {
      expect(
        RefreshShareMountsResult.safeParse({ results: [row(status)] }).success,
        `MUTATION: main emits ${status} but the wire schema drops the whole result`,
      ).toBe(true);
    }
  });

  it("still refuses a status nothing emits", () => {
    expect(RefreshShareMountsResult.safeParse({ results: [row("invented")] }).success).toBe(
      false,
    );
  });

  // The classifier and the schema must agree: whatever the classifier can
  // return as a row status has to be a status the result can carry.
  it("carries whatever the classifier decides a row is", () => {
    for (const error of [
      new SharePinInvalidError("s"),
      new Error("offline"),
      null,
    ]) {
      const verdict = classifyShareMountRefreshError(error);
      if (verdict.kind !== "row") continue;
      expect(
        RefreshShareMountsResult.safeParse({ results: [row(verdict.status)] }).success,
        `MUTATION: the classifier returns ${verdict.status}, which the wire cannot carry`,
      ).toBe(true);
    }
  });
});

// Identity damage is contained per ROW, like grant damage. The loop used to
// push raw registry values and parse the whole array at the end, so one
// record with a 65-character label threw AFTER every pull had run: no row
// survived, and the user was told the refresh failed while the healthy
// mounts had in fact refreshed.
describe("share mount result rows", () => {
  it("carries a row the schema can hold", () => {
    expect(
      shareMountResultRow({
        shareId: "s-1",
        label: "alex",
        status: "updated",
        changedPaths: 3,
      }),
    ).toEqual({ shareId: "s-1", label: "alex", status: "updated", changedPaths: 3 });
  });

  it("drops a row whose identity the schema cannot carry, and nothing else", () => {
    for (const bad of [
      { shareId: "s-1", label: "x".repeat(65) },
      { shareId: "s-1", label: "" },
      { shareId: "s-1", label: 7 },
      { shareId: "", label: "alex" },
      { shareId: null, label: "alex" },
      { shareId: "s".repeat(201), label: "alex" },
    ]) {
      expect(
        shareMountResultRow({ ...bad, status: "unchanged", changedPaths: 0 }),
        `MUTATION: ${JSON.stringify(bad).slice(0, 40)} fails the whole refresh report`,
      ).toBeNull();
    }
  });

  // A count the schema cannot carry must not cost the mount its STATUS. The
  // schema parse alone would drop the whole row, so the count is clamped
  // first: the row survives, and it claims the minimum rather than a number
  // nobody can trust.
  it("keeps a mount's status when its changed count is unusable", () => {
    for (const changedPaths of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -4,
      1.7,
    ]) {
      const row = shareMountResultRow({
        shareId: "s-1",
        label: "alex",
        status: "damaged",
        changedPaths,
      });
      expect(
        row,
        `MUTATION: ${String(changedPaths)} drops the row, losing the mount's status`,
      ).not.toBeNull();
      expect(row?.status).toBe("damaged");
      // Derived from the SCHEMA, not from a restatement of its bounds.
      expect(ShareMountStatusRow.safeParse(row).success).toBe(true);
    }
  });

  // The bounds are the schema's, so the guard is checked against the schema
  // rather than against numbers copied out of it.
  it("returns only rows the wire schema accepts, for every identity shape", () => {
    for (const identity of [
      { shareId: "s-1", label: "alex" },
      { shareId: "s-1", label: "x".repeat(64) },
      { shareId: "s-1", label: "x".repeat(65) },
      { shareId: "s".repeat(200), label: "alex" },
      { shareId: "s".repeat(201), label: "alex" },
      { shareId: "", label: "alex" },
      { shareId: null, label: "alex" },
      { shareId: "s-1", label: 7 },
      { shareId: "s-1", label: undefined },
    ]) {
      const row = shareMountResultRow({
        ...identity,
        status: "unchanged",
        changedPaths: 0,
      });
      const schemaAccepts = ShareMountStatusRow.safeParse({
        ...identity,
        status: "unchanged",
        changedPaths: 0,
      }).success;
      expect(
        row !== null,
        `MUTATION: builder and schema disagree for ${JSON.stringify(identity).slice(0, 40)}`,
      ).toBe(schemaAccepts);
    }
  });

  // The seam rule: whatever this builder produces, the wire must carry.
  it("produces rows the refresh result always parses", () => {
    for (const status of ["updated", "unchanged", "ended", "damaged"] as const) {
      const row = shareMountResultRow({
        shareId: "s-1",
        label: "alex",
        status,
        changedPaths: 1,
      });
      expect(RefreshShareMountsResult.safeParse({ results: [row] }).success, status).toBe(
        true,
      );
    }
  });
});
