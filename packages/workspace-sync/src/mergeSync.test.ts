import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "./cloudSync";
import { createMergeSync, ServerBindingMismatchError } from "./cloudSync";

// In-memory fake of the workspace-api surface the engine talks to: GET files,
// GET files/<path>, POST sync/apply. It mirrors the REAL backend's semantics
// that matter for merge correctness: monotonic per-path revisions, create is
// create-only (a second create of a live path conflicts), update REQUIRES a
// prior create (unknown path => conflict, like updateAsset/writeAtom), and
// sync/apply returns per-op results so a mid-batch failure doesn't wedge.
function fakeServer() {
  const files = new Map<
    string,
    { id: string; kind: string; contentType: string; revision: number; body: string }
  >();
  const seen: { authHeaders: string[]; appliedOps: unknown[][] } = {
    authHeaders: [],
    appliedOps: [],
  };

  function set(path: string, body: string, contentType = "text/markdown") {
    const prior = files.get(path);
    files.set(path, {
      id: `id-${path}`,
      kind: "atom",
      contentType,
      revision: (prior?.revision ?? 0) + 1,
      body,
    });
  }

  function fileSummary(path: string) {
    const f = files.get(path)!;
    return {
      id: f.id,
      path,
      kind: f.kind,
      contentType: f.contentType,
      revision: String(f.revision),
    };
  }

  function apply(op: Record<string, unknown>): { ok: boolean; error?: string; file?: unknown } {
    const path = String(op.path ?? "");
    const existing = files.get(path);
    if (op.op === "create") {
      if (existing) return { ok: false, error: "File path already exists" };
      set(path, String(op.body ?? ""), String(op.mediaType ?? "text/markdown"));
      return { ok: true, file: fileSummary(path) };
    }
    if (op.op === "update") {
      if (!existing) return { ok: false, error: "Asset not found" };
      if (String(existing.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      set(path, String(op.body ?? ""), String(op.mediaType ?? existing.contentType));
      return { ok: true, file: fileSummary(path) };
    }
    if (op.op === "delete") {
      if (existing && op.expectedRevision !== undefined && String(existing.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      files.delete(path);
      return { ok: true };
    }
    if (op.op === "rename") {
      // The real backend accepts SAME-FOLDER renames only (cross-folder is
      // decomposed client-side — pinned below); mirror that contract.
      const fromPath = String(op.fromPath ?? "");
      const toPath = String(op.toPath ?? "");
      const source = files.get(fromPath);
      if (!source) return { ok: false, error: "Asset not found" };
      if (files.has(toPath)) return { ok: false, error: "File path already exists" };
      if (String(source.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      files.delete(fromPath);
      files.set(toPath, { ...source, revision: source.revision + 1 });
      return { ok: true, file: fileSummary(toPath) };
    }
    return { ok: false, error: `unsupported op ${String(op.op)}` };
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.authHeaders.push(headers.get("authorization") ?? "");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.endsWith("/sync/apply") && init?.method === "POST") {
      const { operations } = JSON.parse(String(init.body)) as {
        operations: Array<Record<string, unknown>>;
      };
      seen.appliedOps.push(operations);
      const results = operations.map((op) => ({
        path: op.op === "rename" ? String(op.toPath) : String(op.path),
        ...apply(op),
      }));
      const applied = results.filter((r) => r.ok).length;
      const fileList = results.filter((r) => r.ok && "file" in r && r.file).map((r) => r.file);
      return json({ ok: true, applied, files: fileList, results });
    }
    if (/\/files$/.test(url)) {
      return json({ ok: true, files: [...files.keys()].map(fileSummary) });
    }
    const fileMatch = /\/files\/(.+)$/.exec(url);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]);
      const f = files.get(path);
      if (!f) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, file: { revision: String(f.revision), body: f.body } });
    }
    return json({ ok: false, error: `unexpected ${url}` }, 500);
  };

  return { fetchImpl, set, files, seen };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-merge-"));
  // A living desktop workspace: identity manifest + history ALREADY exist and
  // must survive every sync operation untouched.
  await mkdir(join(root, ".dohc", "history"), { recursive: true });
  await writeFile(
    join(root, ".dohc", "manifest.json"),
    JSON.stringify({ version: 1, workspaceId: "ws-1", kind: "personal", mode: "local-first" }),
  );
  await writeFile(join(root, ".dohc", "history", "index.json"), "[]");
});

function engine(server: ReturnType<typeof fakeServer>, serverUrl = "http://cloud.test") {
  return createMergeSync({
    rootDir: root,
    remoteWorkspaceId: "ws-1",
    serverUrl,
    token: "tok",
    fetch: server.fetchImpl,
  });
}

async function dohcSurvived(): Promise<void> {
  const identity = JSON.parse(await readFile(join(root, ".dohc", "manifest.json"), "utf8"));
  expect(identity).toMatchObject({ kind: "personal", mode: "local-first" });
  expect(existsSync(join(root, ".dohc", "history", "index.json"))).toBe(true);
}

describe("merge push", () => {
  it("first push sends local files as creates with the Bearer token and records the baseline", async () => {
    const server = fakeServer();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "a.md"), "# A");
    const sync = engine(server);

    await sync.initialize();
    const result = await sync.push();
    expect(result.pushed).toBe(1);
    expect(server.files.get("notes/a.md")?.body).toBe("# A");
    expect(server.seen.authHeaders.every((h) => h === "Bearer tok")).toBe(true);

    // Baseline recorded so the next push is a no-op.
    expect((await sync.push()).pushed).toBe(0);
    await dohcSurvived();
  });

  it("pushes local edits and deletions after the baseline exists", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "v1");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    await writeFile(join(root, "a.md"), "v2");
    expect((await sync.push()).pushed).toBe(1);
    expect(server.files.get("a.md")?.body).toBe("v2");

    await rm(join(root, "a.md"));
    await sync.push();
    expect(server.files.has("a.md")).toBe(false);
    await dohcSurvived();
  });

  it("an edit made DURING the push window is not lost (no post-push rescan absorbs it)", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "v1");
    const sync = engine(server);
    await sync.initialize();

    // Simulate an edit landing after the diff scan but reflected on disk before
    // the baseline is written: the baseline must record the PUSHED sha (v1),
    // not whatever is on disk now, so the next push still sends v2.
    let editedDuringPush = false;
    const racingServer = {
      ...server,
      fetchImpl: (async (input, init) => {
        const res = await server.fetchImpl(input, init);
        if (String(input).endsWith("/sync/apply") && !editedDuringPush) {
          editedDuringPush = true;
          await writeFile(join(root, "a.md"), "v2-mid-push");
        }
        return res;
      }) as FetchLike,
    };
    const racing = createMergeSync({
      rootDir: root,
      remoteWorkspaceId: "ws-1",
      serverUrl: "http://cloud.test",
      token: "tok",
      fetch: racingServer.fetchImpl,
    });
    await racing.push();

    // The mid-push edit is still pending: a follow-up push delivers it.
    const result = await sync.push();
    expect(result.pushed).toBe(1);
    expect(server.files.get("a.md")?.body).toBe("v2-mid-push");
  });

  it("never uploads .conflict artifacts", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "v1");
    await writeFile(join(root, "a.md.conflict"), "remote copy");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    expect(server.files.has("a.md")).toBe(true);
    expect(server.files.has("a.md.conflict")).toBe(false);
  });

  it("decomposes a cross-folder move into delete+create (server rejects renames)", async () => {
    const server = fakeServer();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "x.md"), "moved");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // Move src/x.md -> dst/x.md (same content => would pair as a rename).
    await mkdir(join(root, "dst"), { recursive: true });
    await rm(join(root, "src", "x.md"));
    await writeFile(join(root, "dst", "x.md"), "moved");
    await sync.push();

    expect(server.files.has("src/x.md")).toBe(false);
    expect(server.files.get("dst/x.md")?.body).toBe("moved");
    // No rename op ever reached the server.
    const allOps = server.seen.appliedOps.flat() as Array<{ op: string }>;
    expect(allOps.some((op) => op.op === "rename")).toBe(false);
  });
});

describe("merge pull", () => {
  it("writes new and remotely-changed files, leaving everything else alone", async () => {
    const server = fakeServer();
    server.set("notes/remote.md", "from cloud");
    await writeFile(join(root, "local-only.md"), "never pushed");
    const sync = engine(server);
    await sync.initialize();

    const result = await sync.pull();
    expect(result.pulled).toBe(1);
    expect(await readFile(join(root, "notes", "remote.md"), "utf8")).toBe("from cloud");
    // A pull must NEVER clone-clobber: local-only files and .dohc survive.
    expect(await readFile(join(root, "local-only.md"), "utf8")).toBe("never pushed");
    await dohcSurvived();
  });

  it("a dirty local file gets the remote content as <path>.conflict, untouched otherwise", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "shared v1");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // Both sides edit.
    await writeFile(join(root, "a.md"), "LOCAL edit");
    server.set("a.md", "REMOTE edit");

    const result = await sync.pull();
    expect(result.conflicts).toEqual(["a.md"]);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("LOCAL edit");
    expect(await readFile(join(root, "a.md.conflict"), "utf8")).toBe("REMOTE edit");
    await dohcSurvived();
  });

  it("self-heals when fetched bytes already match local: adopts baseline, no spurious conflict", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "same content");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // Wedge the baseline (as a corrupt/empty/partial-push state would): drop
    // a.md from the manifest while disk + server stay byte-identical.
    const manifestPath = join(root, ".dohc", "sync-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    delete manifest.files["a.md"];
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await sync.pull();
    expect(result.conflicts).toEqual([]);
    expect(existsSync(join(root, "a.md.conflict"))).toBe(false);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("same content");
    // Baseline re-adopted, so the next pull is a clean no-op.
    expect((await sync.pull()).pulled).toBe(0);
  });

  it("an edit made mid-pull (after listRemote) becomes a conflict, never an overwrite", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "shared");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();
    server.set("a.md", "REMOTE edit");

    // Edit the file AFTER listRemote but BEFORE the per-file GET — the engine
    // re-hashes live disk immediately before deciding, so this is a conflict.
    const racingFetch: FetchLike = async (input, init) => {
      const res = await server.fetchImpl(input, init);
      if (/\/files$/.test(String(input))) {
        await writeFile(join(root, "a.md"), "MID-PULL local edit");
      }
      return res;
    };
    const racing = createMergeSync({
      rootDir: root,
      remoteWorkspaceId: "ws-1",
      serverUrl: "http://cloud.test",
      token: "tok",
      fetch: racingFetch,
    });
    const result = await racing.pull();
    expect(result.conflicts).toEqual(["a.md"]);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("MID-PULL local edit");
    expect(await readFile(join(root, "a.md.conflict"), "utf8")).toBe("REMOTE edit");
  });

  it("follows a remote deletion only when the local copy is clean", async () => {
    const server = fakeServer();
    await writeFile(join(root, "clean.md"), "same");
    await writeFile(join(root, "dirty.md"), "same");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    server.files.delete("clean.md");
    server.files.delete("dirty.md");
    await writeFile(join(root, "dirty.md"), "edited after last sync");

    const result = await sync.pull();
    expect(result.deletedLocally).toBe(1);
    expect(existsSync(join(root, "clean.md"))).toBe(false);
    expect(await readFile(join(root, "dirty.md"), "utf8")).toBe("edited after last sync");

    // The dirty file dropped from the baseline, so the next push re-creates it.
    await sync.push();
    expect(server.files.get("dirty.md")?.body).toBe("edited after last sync");
    await dohcSurvived();
  });

  it("does NOT resurrect a locally-deleted file; writes remote content as .conflict", async () => {
    const server = fakeServer();
    await writeFile(join(root, "note.md"), "shared");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // The user deletes note.md locally but it has NOT been pushed yet, and the
    // remote still has it. A naive pull would resurrect it.
    await rm(join(root, "note.md"));
    // Remote advances independently.
    server.set("note.md", "remote update");

    const result = await sync.pull();
    expect(existsSync(join(root, "note.md"))).toBe(false);
    expect(result.conflicts).toEqual(["note.md"]);
    expect(await readFile(join(root, "note.md.conflict"), "utf8")).toBe("remote update");
  });

  it("refuses remote paths that collide with dohc metadata", async () => {
    const server = fakeServer();
    server.set(".dohc/manifest.json", '{"hostile":true}');
    const sync = engine(server);
    await sync.initialize();
    await expect(sync.pull()).rejects.toThrow(/collides with dohc metadata/);
    await dohcSurvived();
  });

  it("never pulls down a remote *.conflict artifact", async () => {
    const server = fakeServer();
    server.set("a.md", "real");
    server.set("a.md.conflict", "should not land");
    const sync = engine(server);
    await sync.initialize();
    await sync.pull();
    expect(existsSync(join(root, "a.md.conflict"))).toBe(false);
    expect(await readFile(join(root, "a.md"), "utf8")).toBe("real");
  });
});

describe("manifest server binding", () => {
  it("refuses to sync (no deletes) when the manifest is bound to a different server", async () => {
    const server = fakeServer();
    await writeFile(join(root, "keep.md"), "important");
    const sync = engine(server, "http://server-a.test");
    await sync.initialize();
    await sync.push();

    // Re-point the engine at a DIFFERENT (empty) server B: pull must refuse
    // rather than treat every baselined file as a remote deletion.
    const serverB = fakeServer();
    const wrong = engine(serverB, "http://server-b.test");
    await expect(wrong.pull()).rejects.toThrow(ServerBindingMismatchError);
    // The clean local file is untouched.
    expect(await readFile(join(root, "keep.md"), "utf8")).toBe("important");
  });
});

// Phase E3 pins: the desktop explorer's movePath is one fs.rename, so these
// lock how renames flow through sync — the clean steady-state path AND the
// known wart — before renames become a first-class UI affordance. Recorded
// in the phase ledger.
describe("rename sync semantics (E3 pins)", () => {
  it("a same-folder rename pushes ONE rename op (never delete+create)", async () => {
    const server = fakeServer();
    await mkdir(join(root, "notes"), { recursive: true });
    await writeFile(join(root, "notes", "draft.md"), "same bytes");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // One fs.rename (what desktop movePath does), then a steady-state push.
    await rm(join(root, "notes", "draft.md"));
    await writeFile(join(root, "notes", "final.md"), "same bytes");
    const batchesBefore = server.seen.appliedOps.length;
    const result = await sync.push();
    expect(result.pushed).toBe(1);

    expect(server.files.has("notes/draft.md")).toBe(false);
    expect(server.files.get("notes/final.md")?.body).toBe("same bytes");
    const renameOps = server.seen.appliedOps
      .slice(batchesBefore)
      .flat() as Array<{ op: string }>;
    expect(renameOps).toEqual([
      expect.objectContaining({
        op: "rename",
        fromPath: "notes/draft.md",
        toPath: "notes/final.md",
      }),
    ]);
  });

  it("an OFFLINE rename with no remote change survives pull-before-push cleanly (no resurrect, no conflict)", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "v1");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    // Rename while no engine runs, then the firstContact order: pull, push.
    await rm(join(root, "a.md"));
    await writeFile(join(root, "b.md"), "v1");
    const pulled = await sync.pull();
    // The remote revision still matches the baseline, so pull leaves the
    // renamed-away old path alone — no resurrect, no spurious conflict.
    expect(pulled.conflicts).toEqual([]);
    expect(existsSync(join(root, "a.md.conflict"))).toBe(false);

    const pushed = await sync.push();
    expect(pushed.pushed).toBe(1);
    expect([...server.files.keys()]).toEqual(["b.md"]);
  });

  // ⚠ KNOWN WART, pinned as the CURRENT contract (accepted for E3, recorded
  // in the phase ledger — do NOT change engine behavior this phase). Rename
  // a synced file while OFFLINE *and* let the remote edit the old path; on
  // relaunch firstContact pulls BEFORE it pushes:
  //   1. pull sees a baseline entry whose local file is gone (the rename's
  //      old path) with a NEWER remote revision, applies the no-resurrect
  //      rule, and lands the remote content as a spurious `<old>.conflict`;
  //   2. push then sends the rename with the BASELINE's expectedRevision —
  //      now stale — so the server refuses it, the baseline never advances,
  //      and the rename op retries (and fails) identically on every push:
  //      the new path NEVER reaches the server.
  // FIX CONDITION: pull must sha-pair a missing baseline entry against a new
  // local file with the same hash (recognize delete+create as a rename)
  // before declaring a local deletion, and rebase the pending rename's
  // expectedRevision — engine work out of E3 scope. If this pin fails
  // because the conflict no longer appears AND b.md reaches the server,
  // the wart was fixed: delete this test and the ledger entry.
  it("offline-rename + remote-edit-of-old-path: spurious <old>.conflict and the rename WEDGES (current contract)", async () => {
    const server = fakeServer();
    await writeFile(join(root, "a.md"), "v1");
    const sync = engine(server);
    await sync.initialize();
    await sync.push();

    await rm(join(root, "a.md"));
    await writeFile(join(root, "b.md"), "v1");
    server.set("a.md", "v2-remote"); // concurrent remote edit (revision 2)

    const pulled = await sync.pull();
    // The spurious user-facing artifact this pin documents:
    expect(pulled.conflicts).toContain("a.md");
    expect(await readFile(join(root, "a.md.conflict"), "utf8")).toBe("v2-remote");

    // And the wedge: the rename op carries the stale baseline revision, the
    // server refuses it, and retrying changes nothing.
    const pushed = await sync.push();
    expect(pushed.pushed).toBe(0);
    const again = await sync.push();
    expect(again.pushed).toBe(0);
    expect(server.files.has("b.md")).toBe(false);
    expect(server.files.get("a.md")?.body).toBe("v2-remote");
    // The conflict artifact itself never uploads.
    expect(server.files.has("a.md.conflict")).toBe(false);
  });
});
