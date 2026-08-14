import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { SharePinInvalidError } from "./sharedView";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createShareViewDaemonHarness,
  type ShareViewDaemonHarness,
} from "../testing/shareViewLoopbackTransport";
import {
  assertMountableSelector,
  classifyShareMountRefreshError,
  createMountDirectory,
  mountLabelFor,
  mountRootFor,
  mountStoreWorkspaceIdFor,
  refreshShareMountOnce as refreshShareMountOnceWithPull,
  relayTargetForShareMount,
  removeMountFolder,
  validMountLabel,
} from "./shareMounts";
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
async function refreshShareMountOnce(
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
  const target = relayTargetForShareMount(
    HOST_WORKSPACE,
    input.hostRoot,
    input.mount,
  );
  const pull = harness.pullFor(target);
  return await refreshShareMountOnceWithPull({
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
    expect(mountLabelFor("alex@example.com", [])).toBe("alex");
    expect(mountLabelFor("alex@example.com", ["alex"])).toBe("alex (2)");
    expect(mountLabelFor("alex@example.com", ["alex", "alex (2)"])).toBe("alex (3)");
    expect(mountLabelFor("Wild! Chars?@x.com", [])).toBe("wild-chars");
    expect(mountLabelFor(null, [])).toBe("share");
    expect(mountLabelFor("...@x.com", [])).toBe("share");
    // A secret-shaped local part must not become a label the read
    // classifier would suppress (prod.env -> secret).
    expect(mountLabelFor("prod.env@example.com", [])).toBe("prod-env");
    expect(mountLabelFor(".env@example.com", [])).toBe("env");
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
  });
});

describe("refreshShareMountOnce", () => {
  it("materializes shared files under shared-with-me/<label>/ and reports statuses", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    const harness = daemonHarness(relay);
    relay.addWrite("docs/brief.md", "the brief");
    relay.addWrite("docs/deep/notes.md", "deep notes");

    const first = await refreshShareMountOnce(harness, {
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

    const second = await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(second).toEqual({
      status: "unchanged",
      changedPaths: 0,
      refusedOps: 0,
      refusedDetail: null,
    });

    relay.addWrite("docs/brief.md", "the brief v2");
    const third = await refreshShareMountOnce(harness, {
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

    const outcome = await refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });

    relay.ended = true;
    const outcome = await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(outcome).toEqual({
      status: "ended",
      changedPaths: 0,
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
      refreshShareMountOnce(harness, {
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
      refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
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
    const healed = await refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mounted = join(host, SHARED_WITH_ME_FOLDER, "alex", "docs/brief.md");

    // A rogue tool edits the mounted file directly; the relay is unchanged.
    await writeFile(mounted, "defaced");
    const repaired = await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(repaired.status).toBe("updated");
    expect(repaired.changedPaths).toBe(1);
    expect(await readFile(mounted, "utf8")).toBe("authoritative");

    // Deleting the file locally is repaired the same way.
    await rm(mounted);
    const restored = await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(restored.status).toBe("updated");
    expect(restored.changedPaths).toBe(1);
    expect(await readFile(mounted, "utf8")).toBe("authoritative");

    // An untouched projection stays "unchanged" — no busy repainting.
    const quiet = await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    expect(quiet).toEqual({
      status: "unchanged",
      changedPaths: 0,
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
    await refreshShareMountOnce(harness, {
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
    const outcome = await refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
    });
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");

    // Replace the docs DIRECTORY with a plain file; the next refresh must
    // rebuild the real chain instead of wedging on ENOTDIR.
    await rm(join(mountRoot, "docs"), { recursive: true, force: true });
    await writeFile(join(mountRoot, "docs"), "squatter");
    const healed = await refreshShareMountOnce(harness, {
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
    await refreshShareMountOnce(harness, {
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
    const outcome = await refreshShareMountOnce(harness, {
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
      refreshShareMountOnce(harness, {
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
