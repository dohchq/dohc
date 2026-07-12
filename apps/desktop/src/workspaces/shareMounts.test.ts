import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mountLabelFor,
  mountRootFor,
  refreshShareMountOnce,
  removeMountFolder,
  validMountLabel,
} from "./shareMounts";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";

const SHARE_ID = "share-1";
const TOKEN = "test:recipient";

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHostRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-share-mounts-"));
  roots.push(root);
  return root;
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
  });

  it("refuses traversal, separators, and reserved names as labels", () => {
    for (const label of ["", "..", "a/b", "a\\b", ".dohc", "x".repeat(65), ". ."]) {
      expect(validMountLabel(label)).toBe(false);
    }
    expect(validMountLabel("alex (2)")).toBe(true);
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
    relay.addWrite("docs/brief.md", "the brief");
    relay.addWrite("docs/deep/notes.md", "deep notes");

    const first = await refreshShareMountOnce({
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      relay: relay.connection(),
    });
    expect(first.status).toBe("updated");
    expect(first.changedPaths).toBe(2);
    const mountRoot = join(host, SHARED_WITH_ME_FOLDER, "alex");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe("the brief");
    expect(await readFile(join(mountRoot, "docs/deep/notes.md"), "utf8")).toBe(
      "deep notes",
    );
    // The mount's pull state is its own nested engine store, invisible to
    // the host's tree/watcher (`.dohc` is ignored at any depth).
    expect(existsSync(join(mountRoot, ".dohc/engine/engine.db"))).toBe(true);

    const second = await refreshShareMountOnce({
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      relay: relay.connection(),
    });
    expect(second).toEqual({ status: "unchanged", changedPaths: 0 });

    relay.addWrite("docs/brief.md", "the brief v2");
    const third = await refreshShareMountOnce({
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      relay: relay.connection(),
    });
    expect(third.status).toBe("updated");
    expect(await readFile(join(mountRoot, "docs/brief.md"), "utf8")).toBe(
      "the brief v2",
    );
  });

  it("reports ended on revocation and leaves the files untouched", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    relay.addWrite("plan.md", "keep me");
    await refreshShareMountOnce({
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      relay: relay.connection(),
    });

    relay.ended = true;
    const outcome = await refreshShareMountOnce({
      hostRoot: host,
      mount: { shareId: SHARE_ID, label: "alex" },
      relay: relay.connection(),
    });
    expect(outcome).toEqual({ status: "ended", changedPaths: 0 });
    expect(
      await readFile(join(host, SHARED_WITH_ME_FOLDER, "alex", "plan.md"), "utf8"),
    ).toBe("keep me");
  });

  it("refuses to refresh a mount whose registry label was tampered into traversal", async () => {
    const host = await tempHostRoot();
    const relay = new FakeShareRelay();
    await expect(
      refreshShareMountOnce({
        hostRoot: host,
        mount: { shareId: SHARE_ID, label: "../../etc" },
        relay: relay.connection(),
      }),
    ).rejects.toThrow(/Invalid share mount label/);
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
