import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "./cloudSync";
import { createMergeSync } from "./cloudSync";

// In-memory fake of the workspace-api surface the engine talks to: GET files,
// GET files/<path>, POST sync/apply. Content-addressed revisions so a second
// identical write keeps its revision (matching the real backend's semantics
// closely enough for merge logic).
function fakeServer() {
  const files = new Map<
    string,
    { id: string; kind: string; contentType: string; revision: string; body: string }
  >();
  let revisionCounter = 0;
  const seen: { authHeaders: string[]; appliedOps: unknown[][] } = {
    authHeaders: [],
    appliedOps: [],
  };

  function set(path: string, body: string, contentType = "text/markdown") {
    files.set(path, {
      id: `id-${path}`,
      kind: "atom",
      contentType,
      revision: `rev-${++revisionCounter}`,
      body,
    });
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
      for (const op of operations) {
        if (op.op === "create" || op.op === "update") {
          set(String(op.path), String(op.body ?? ""), String(op.mediaType));
        } else if (op.op === "delete") {
          files.delete(String(op.path));
        }
      }
      return json({ ok: true, applied: operations.length });
    }
    if (/\/files$/.test(url)) {
      return json({
        ok: true,
        files: [...files.entries()].map(([path, f]) => ({
          id: f.id,
          path,
          kind: f.kind,
          contentType: f.contentType,
          revision: f.revision,
        })),
      });
    }
    const fileMatch = /\/files\/(.+)$/.exec(url);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]);
      const f = files.get(path);
      if (!f) return json({ ok: false, error: "not found" }, 404);
      return json({ ok: true, file: { revision: f.revision, body: f.body } });
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

function engine(server: ReturnType<typeof fakeServer>) {
  return createMergeSync({
    rootDir: root,
    remoteWorkspaceId: "ws-1",
    serverUrl: "http://cloud.test",
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

    const { rm } = await import("node:fs/promises");
    await rm(join(root, "a.md"));
    await sync.push();
    expect(server.files.has("a.md")).toBe(false);
    await dohcSurvived();
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

  it("refuses remote paths that collide with dohc metadata", async () => {
    const server = fakeServer();
    server.set(".dohc/manifest.json", '{"hostile":true}');
    const sync = engine(server);
    await sync.initialize();
    await expect(sync.pull()).rejects.toThrow(/collides with dohc metadata/);
    await dohcSurvived();
  });
});
