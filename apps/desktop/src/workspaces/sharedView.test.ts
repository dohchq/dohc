import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVersionedTextStore,
  pullShareView,
} from "@dohc/workspace-engine";
import {
  materializeSharedViewPaths,
  refreshSharedViewOnce as refreshSharedViewOnceWithPull,
} from "./sharedView";

const WORKSPACE = "shared-view-ws";
const SHARE_ID = "share-1";
const TOKEN = "test:recipient";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-shared-view-desktop-"));
  roots.push(root);
  return root;
}

async function refreshSharedViewOnce(
  input: Omit<
    Parameters<typeof refreshSharedViewOnceWithPull>[0],
    "pull" | "store"
  >,
) {
  const store = createVersionedTextStore(input.rootDir);
  try {
    return await refreshSharedViewOnceWithPull({
      ...input,
      pull: pullShareView,
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

describe("shared view refresh", () => {
  it("pulls, materializes to disk, and reports honest statuses across refreshes", async () => {
    const rootDir = await tempRoot();
    const relay = new FakeShareRelay();
    relay.addWrite("docs/a.md", "first body");
    relay.addWrite("docs/nested/deep.md", "deep body");

    const first = await refreshSharedViewOnce({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(first).toEqual({ status: "updated", changedPaths: 2 });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("first body");
    expect(await readFile(join(rootDir, "docs/nested/deep.md"), "utf8")).toBe("deep body");

    const idle = await refreshSharedViewOnce({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(idle).toEqual({ status: "unchanged", changedPaths: 0 });

    relay.addWrite("docs/a.md", "updated body");
    relay.addDelete("docs/nested/deep.md");
    const second = await refreshSharedViewOnce({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(second).toEqual({ status: "updated", changedPaths: 2 });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");
    await expect(stat(join(rootDir, "docs/nested/deep.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Revocation: the next refresh reports "ended" and the local files stay.
    relay.ended = true;
    const ended = await refreshSharedViewOnce({
      rootDir,
      workspaceId: WORKSPACE,
      relay: relay.connection(),
      shareId: SHARE_ID,
    });
    expect(ended).toEqual({ status: "ended", changedPaths: 0 });
    expect(await readFile(join(rootDir, "docs/a.md"), "utf8")).toBe("updated body");
  });

  // A read that fails must not cost the user the file they already had.
  // preparedTarget removes the existing projection, so reading afterwards
  // would leave a hole — and because the cursor is only committed after a
  // clean pass, every later refresh would replay into the same hole.
  it("leaves the existing projection intact when the content read fails", async () => {
    const rootDir = await tempRoot();
    const store = createVersionedTextStore(rootDir);
    const target = join(rootDir, "docs/a.md");
    try {
      await materializeSharedViewPaths(
        rootDir,
        WORKSPACE,
        [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
        Object.assign(store, {
          readTextFile: async () => ({ text: "good body" }),
        }) as unknown as Parameters<typeof materializeSharedViewPaths>[3],
      );
      expect(await readFile(target, "utf8")).toBe("good body");

      await expect(
        materializeSharedViewPaths(
          rootDir,
          WORKSPACE,
          [{ path: "docs/a.md", operation: "write", contentKind: "text" }],
          Object.assign(store, {
            readTextFile: async () => {
              throw new Error("over-cap text body");
            },
          }) as unknown as Parameters<typeof materializeSharedViewPaths>[3],
        ),
      ).rejects.toThrow(/over-cap text body/);

      expect(await readFile(target, "utf8")).toBe("good body");
    } finally {
      await store.close();
    }
  });

  it("refuses to materialize a path that escapes the workspace root", async () => {
    const rootDir = await tempRoot();
    const store = createVersionedTextStore(rootDir);
    try {
      await expect(
        materializeSharedViewPaths(
          rootDir,
          WORKSPACE,
          [{ path: "../escape.md", operation: "write", contentKind: "text" }],
          store,
        ),
      ).rejects.toThrow(/escapes the workspace/);
    } finally {
      await store.close();
    }
  });
});
