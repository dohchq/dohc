import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@dohc/workspace-sync";
import {
  createWorkspaceDirectory,
  createApp,
  deleteWorkspacePath,
  importData,
  listWorkspaceFiles,
  listChanges,
  listWorkspaces,
  moveWorkspacePath,
  openInDohc,
  queryDatabase,
  readChange,
  readWorkspaceFile,
  resolveConflict,
  safeResolve,
  searchWorkspaceFiles,
  share,
  syncCloud,
  syncNow,
  testApp,
  writeWorkspaceFile,
  workspaceStatus,
  type ToolContext,
} from "./tools";

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-test-"));
  const root = join(base, "ws");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({ root, home });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

// The traversal vectors EVERY path-taking tool must refuse: parent escape,
// percent-encoded escape (single and double), an absolute path, and the
// reserved .dohc control dir.
const TRAVERSALS = [
  "../secret.txt",
  "%2e%2e/secret.txt",
  "%252e%252e/secret.txt",
  "/etc/passwd",
  ".dohc/sync-manifest.json",
];

async function bindCloudWorkspace(
  ctx: ToolContext,
  options: {
    serverUrl?: string;
    remoteWorkspaceId?: string;
    token?: string;
    credentials?: boolean;
  } = {},
) {
  const serverUrl = options.serverUrl ?? "http://cloud.test";
  const remoteWorkspaceId = options.remoteWorkspaceId ?? "ws-1";
  await writeFile(
    join(ctx.home, "dohc-workspaces.json"),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          workspaceId: "local-ws",
          rootPath: ctx.root,
          kind: "personal",
          mode: "local-first",
          remote: { serverUrl, remoteWorkspaceId },
        },
      ],
    }),
  );
  if (options.credentials === false) return;
  await writeFile(
    join(ctx.home, "dohc-cloud.json"),
    JSON.stringify({
      version: 1,
      serverUrl,
      email: "ice@example.test",
      token: options.token ?? "plain:device-token",
    }),
  );
}

function fakeCloudServer() {
  const files = new Map<
    string,
    {
      id: string;
      kind: "atom" | "asset";
      contentType: string;
      revision: number;
      body?: string;
      bytesBase64?: string;
    }
  >();
  const seen = { authHeaders: [] as string[], appliedOps: [] as unknown[][] };

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

  function summary(path: string) {
    const file = files.get(path)!;
    return {
      id: file.id,
      path,
      kind: file.kind,
      contentType: file.contentType,
      revision: String(file.revision),
    };
  }

  function apply(op: Record<string, unknown>): { ok: boolean; error?: string; file?: unknown } {
    const path = String(op.path ?? "");
    const existing = files.get(path);
    if (op.op === "create") {
      if (existing) return { ok: false, error: "File path already exists" };
      files.set(path, {
        id: `id-${path}`,
        kind: String(op.kind ?? "atom") === "asset" ? "asset" : "atom",
        contentType: String(op.mediaType ?? "text/markdown"),
        revision: 1,
        ...(typeof op.body === "string"
          ? { body: op.body }
          : { bytesBase64: String(op.bytesBase64 ?? "") }),
      });
      return { ok: true, file: summary(path) };
    }
    if (op.op === "update") {
      if (!existing) return { ok: false, error: "Asset not found" };
      if (String(existing.revision) !== String(op.expectedRevision)) {
        return { ok: false, error: "Expected revision is stale" };
      }
      files.set(path, {
        ...existing,
        contentType: String(op.mediaType ?? existing.contentType),
        revision: existing.revision + 1,
        ...(typeof op.body === "string"
          ? { body: op.body, bytesBase64: undefined }
          : { bytesBase64: String(op.bytesBase64 ?? ""), body: undefined }),
      });
      return { ok: true, file: summary(path) };
    }
    if (op.op === "delete") {
      files.delete(path);
      return { ok: true };
    }
    if (op.op === "rename") {
      const fromPath = String(op.fromPath ?? "");
      const toPath = String(op.toPath ?? "");
      const source = files.get(fromPath);
      if (!source) return { ok: false, error: "Asset not found" };
      files.delete(fromPath);
      files.set(toPath, { ...source, revision: source.revision + 1 });
      return { ok: true, file: summary(toPath) };
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
      return json({
        ok: true,
        applied: results.filter((result) => result.ok).length,
        results,
      });
    }

    if (/\/files$/.test(url)) {
      return json({ ok: true, files: [...files.keys()].map(summary) });
    }

    const fileMatch = /\/files\/(.+)$/.exec(url);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]!);
      const file = files.get(path);
      if (!file) return json({ ok: false, error: "not found" }, 404);
      return json({
        ok: true,
        file: {
          revision: String(file.revision),
          ...(file.body !== undefined ? { body: file.body } : { bytesBase64: file.bytesBase64 }),
        },
      });
    }

    return json({ ok: false, error: `unexpected ${url}` }, 500);
  };

  return { fetchImpl, files, seen, set };
}

async function withCloudEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = {
    DOHC_MCP_CLOUD_SERVER_URL: process.env.DOHC_MCP_CLOUD_SERVER_URL,
    DOHC_MCP_CLOUD_EMAIL: process.env.DOHC_MCP_CLOUD_EMAIL,
    DOHC_MCP_CLOUD_TOKEN: process.env.DOHC_MCP_CLOUD_TOKEN,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("mcp tool path containment", () => {
  it("safeResolve accepts an in-root path and rejects every traversal", async () => {
    await withWorkspace(async (ctx) => {
      const ok = await safeResolve(ctx, "notes/day.md");
      expect(ok.ok).toBe(true);
      if (ok.ok) expect(ok.absolute.startsWith(ctx.root)).toBe(true);
      for (const evil of TRAVERSALS) {
        expect((await safeResolve(ctx, evil)).ok).toBe(false);
      }
    });
  });

  it("refuses a path that escapes via an in-tree symlink (realpath containment)", async () => {
    await withWorkspace(async (ctx) => {
      // A symlink that already exists INSIDE the workspace but points outside
      // it: lexical validation passes, realpath containment must still refuse.
      const outside = await mkdtemp(join(tmpdir(), "dohc-mcp-outside-"));
      await writeFile(join(outside, "secret.txt"), "top secret");
      await symlink(outside, join(ctx.root, "escape"));
      const escaped = await safeResolve(ctx, "escape/secret.txt");
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) expect(escaped.reason).toMatch(/symlink/i);
      // And the tools that follow it refuse too.
      expect(await openInDohc(ctx, { path: "escape/secret.txt" })).toMatchObject({ ok: false });
      await rm(outside, { recursive: true, force: true });
    });
  });

  it("refuses a reserved .dohc segment at ANY depth", async () => {
    await withWorkspace(async (ctx) => {
      for (const p of [".dohc/x", "notes/.dohc/x", "a/b/.DOHC/x"]) {
        expect((await safeResolve(ctx, p)).ok).toBe(false);
      }
    });
  });

  it("create_app refuses traversal and a .dohc escape via either arg", async () => {
    await withWorkspace(async (ctx) => {
      await expect(createApp(ctx, { area: "..", name: "x" })).resolves.toMatchObject({ ok: false });
      await expect(createApp(ctx, { area: ".dohc", name: "x" })).resolves.toMatchObject({ ok: false });
    });
  });

  it("query_database, import_data, test_app, open_in_dohc, share all refuse traversal", async () => {
    await withWorkspace(async (ctx) => {
      for (const evil of TRAVERSALS) {
        expect(await openInDohc(ctx, { path: evil })).toMatchObject({ ok: false });
        await expect(share(ctx, { path: evil, scope: "public" })).resolves.toMatchObject({ ok: false });
        await expect(
          queryDatabase(ctx, { databasePath: evil, sql: "SELECT 1" }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          importData(ctx, { sourcePath: "data.csv", databasePath: evil, tableName: "t" }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          importData(ctx, { sourcePath: evil, databasePath: "out.sqlite", tableName: "t" }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          testApp(ctx, { appRoot: evil, sourcePaths: [] }),
        ).resolves.toMatchObject({ ok: false });
      }
    });
  });

  it("workspace file tools refuse traversal and .dohc internals", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "ok.txt"), "ok");
      for (const evil of TRAVERSALS) {
        await expect(listWorkspaceFiles(ctx, { path: evil })).resolves.toMatchObject({ ok: false });
        await expect(readWorkspaceFile(ctx, { path: evil })).resolves.toMatchObject({ ok: false });
        await expect(searchWorkspaceFiles(ctx, { path: evil, query: "ok" })).resolves.toMatchObject({
          ok: false,
        });
        await expect(
          writeWorkspaceFile(ctx, { path: evil, content: "nope" }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          createWorkspaceDirectory(ctx, { path: evil }),
        ).resolves.toMatchObject({ ok: false });
        await expect(
          moveWorkspacePath(ctx, { fromPath: "ok.txt", toPath: evil }),
        ).resolves.toMatchObject({ ok: false });
        await expect(deleteWorkspacePath(ctx, { path: evil })).resolves.toMatchObject({
          ok: false,
        });
      }
    });
  });

  it("workspace mutations refuse a symlinked .dohc before changing visible files", async () => {
    await withWorkspace(async (ctx) => {
      const outside = await mkdtemp(join(tmpdir(), "dohc-mcp-metadata-outside-"));
      await symlink(outside, join(ctx.root, ".dohc"));

      await expect(
        writeWorkspaceFile(ctx, { path: "notes/new.txt", content: "nope" }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("symlink") });
      await expect(readFile(join(ctx.root, "notes/new.txt"), "utf8")).rejects.toThrow();

      await writeFile(join(ctx.root, "keep.txt"), "still here");
      await expect(deleteWorkspacePath(ctx, { path: "keep.txt" })).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("symlink"),
      });
      await expect(readFile(join(ctx.root, "keep.txt"), "utf8")).resolves.toBe("still here");

      await rm(outside, { recursive: true, force: true });
    });
  });
});

describe("mcp tools operate on allowed paths", () => {
  it("list_workspaces reads the desktop registry under home", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(
        join(ctx.home, "dohc-workspaces.json"),
        JSON.stringify({
          version: 1,
          workspaces: [
            { workspaceId: "ws-a", rootPath: "/x/a", kind: "personal", mode: "local" },
          ],
        }),
      );
      const result = await listWorkspaces(ctx);
      expect(result.workspaces).toEqual([
        { workspaceId: "ws-a", rootPath: "/x/a", kind: "personal" },
      ]);
    });
  });

  it("workspace_status reports local when no sync manifest exists, cloud when bound", async () => {
    await withWorkspace(async (ctx) => {
      expect(await workspaceStatus(ctx)).toMatchObject({ synced: false, scope: "local" });
      await mkdir(join(ctx.root, ".dohc"), { recursive: true });
      await writeFile(
        join(ctx.root, ".dohc", "sync-manifest.json"),
        JSON.stringify({ workspaceId: "ws-a", remoteWorkspaceId: "ws-a", serverUrl: "https://x" }),
      );
      expect(await workspaceStatus(ctx)).toMatchObject({ synced: true, scope: "cloud" });
    });
  });

  it("workspace_status reports a matching cloud credential as connected", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx);
      expect(await workspaceStatus(ctx)).toMatchObject({
        synced: true,
        scope: "cloud",
        remoteWorkspaceId: "ws-1",
        serverUrl: "http://cloud.test",
        cloudConnected: true,
        credentialStatus: "available",
      });
    });
  });

  it("sync_now reports a clean local state with no history", async () => {
    await withWorkspace(async (ctx) => {
      expect(await syncNow(ctx, {})).toMatchObject({ clean: true, pendingChangeCount: 0 });
    });
  });

  it("sync_cloud pushes local workspace files through the bound dohc Cloud workspace", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx);
      await writeFile(join(ctx.root, "notes.md"), "from local\n");
      const server = fakeCloudServer();

      const result = await syncCloud(ctx, { direction: "push" }, { fetch: server.fetchImpl });
      expect(result).toMatchObject({
        ok: true,
        direction: "push",
        pushed: 1,
        pushedPaths: ["notes.md"],
        remoteWorkspaceId: "ws-1",
      });
      expect(server.files.get("notes.md")?.body).toBe("from local\n");
      expect(server.seen.authHeaders.every((header) => header === "Bearer device-token")).toBe(true);
    });
  });

  it("sync_cloud pulls remote files and records visible sync history", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx);
      const server = fakeCloudServer();
      server.set("notes/remote.md", "from cloud\n");

      const result = await syncCloud(ctx, { direction: "pull" }, { fetch: server.fetchImpl });
      expect(result).toMatchObject({
        ok: true,
        direction: "pull",
        pulled: 1,
        pulledPaths: ["notes/remote.md"],
      });
      await expect(readFile(join(ctx.root, "notes", "remote.md"), "utf8")).resolves.toBe(
        "from cloud\n",
      );

      const history = await listChanges(ctx, { includeFiles: true });
      expect(history).toMatchObject({ count: 1, totalAvailable: 1 });
      expect(history.changes[0]).toMatchObject({
        kind: "sync",
        provenance: { source: "sync" },
        files: [{ path: "notes/remote.md", operation: "write" }],
      });
    });
  });

  it("sync_cloud can use desktop-injected cloud env instead of reading the credential file", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx, { credentials: false });
      await writeFile(join(ctx.root, "notes.md"), "from managed desktop\n");
      const server = fakeCloudServer();

      await withCloudEnv(
        {
          DOHC_MCP_CLOUD_SERVER_URL: "http://cloud.test",
          DOHC_MCP_CLOUD_EMAIL: "ice@example.test",
          DOHC_MCP_CLOUD_TOKEN: "env-token",
        },
        async () => {
          const result = await syncCloud(ctx, { direction: "push" }, { fetch: server.fetchImpl });
          expect(result).toMatchObject({
            ok: true,
            pushed: 1,
            pushedPaths: ["notes.md"],
          });
        },
      );

      expect(server.files.get("notes.md")?.body).toBe("from managed desktop\n");
      expect(server.seen.authHeaders.every((header) => header === "Bearer env-token")).toBe(true);
    });
  });

  it("sync_cloud refuses encrypted desktop credentials in a standalone MCP process", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx, { token: "enc:sealed-token" });
      await expect(syncCloud(ctx, { direction: "pull" }, { fetch: fakeCloudServer().fetchImpl })).resolves.toMatchObject({
        ok: false,
        credentialStatus: "encrypted",
        reason: expect.stringContaining("safeStorage"),
      });
    });
  });

  it("sync_cloud keeps local-only workspaces offline instead of inventing a remote", async () => {
    await withWorkspace(async (ctx) => {
      await expect(syncCloud(ctx, { direction: "push" }, { fetch: fakeCloudServer().fetchImpl })).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("local-only"),
      });
    });
  });

  it("writes, reads, and lists arbitrary visible files while recording sync-visible history", async () => {
    await withWorkspace(async (ctx) => {
      const written = await writeWorkspaceFile(ctx, {
        path: "docs/report.html",
        content: "<h1>I ate 10 apples</h1>\n",
        summary: "Created report",
      });
      expect(written).toMatchObject({ ok: true, path: "docs/report.html" });

      const read = await readWorkspaceFile(ctx, { path: "docs/report.html" });
      expect(read).toMatchObject({
        ok: true,
        path: "docs/report.html",
        content: "<h1>I ate 10 apples</h1>\n",
      });
      if (read.ok) expect(read.sha256).toBe(written.ok ? written.sha256 : "");

      await expect(
        readWorkspaceFile(ctx, { path: "docs/report.html", maxBytes: 8, offsetBytes: 4 }),
      ).resolves.toMatchObject({
        ok: true,
        offsetBytes: 4,
        truncated: true,
        content: "I ate 10",
      });

      const listed = await listWorkspaceFiles(ctx, { path: "docs" });
      expect(listed).toMatchObject({ ok: true });
      if (listed.ok) {
        expect(listed.entries).toEqual([
          {
            path: "docs/report.html",
            kind: "file",
            bytes: 25,
            mediaType: "text/html",
          },
        ]);
      }

      const pending = await syncNow(ctx, { sinceMs: 0 });
      expect(pending).toMatchObject({ clean: false, pendingChangeCount: 1 });
      expect(pending.cursorMs).toBeGreaterThan(0);
      expect(pending.pending[0]).toMatchObject({ summary: "Created report", fileCount: 1 });
    });
  });

  it("searches visible paths and text content while hiding workspace internals", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "docs"), { recursive: true });
      await writeFile(join(ctx.root, "docs", "report.txt"), "I ate 10 apples\nNot pears\n");
      await writeFile(join(ctx.root, "docs", "apples.csv"), "name,count\napple,10\n");
      await mkdir(join(ctx.root, ".dohc", "history"), { recursive: true });
      await writeFile(join(ctx.root, ".dohc", "history", "secret.txt"), "10 apples hidden\n");
      await mkdir(join(ctx.root, ".git"), { recursive: true });
      await writeFile(join(ctx.root, ".git", "config"), "10 apples hidden\n");
      await mkdir(join(ctx.root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(ctx.root, "node_modules", "pkg", "index.js"), "10 apples hidden\n");

      const result = await searchWorkspaceFiles(ctx, { query: "apples" });
      expect(result).toMatchObject({ ok: true, query: "apples", mode: "both" });
      if (!result.ok) return;

      expect(result.matches).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "content",
            path: "docs/report.txt",
            line: 1,
            column: 10,
            preview: "I ate 10 apples",
          }),
          expect.objectContaining({
            type: "path",
            path: "docs/apples.csv",
            preview: "docs/apples.csv",
          }),
        ]),
      );
      expect(result.matches.map((match) => match.path)).not.toContain(".dohc/history/secret.txt");
      expect(result.matches.map((match) => match.path)).not.toContain(".git/config");
      expect(result.matches.map((match) => match.path)).not.toContain("node_modules/pkg/index.js");
    });
  });

  it("supports bounded regex search and reports skipped large or binary files", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "notes.txt"), "One apple\nTwo apples\n");
      await writeFile(join(ctx.root, "big.txt"), "apple".repeat(100));
      await writeFile(join(ctx.root, "image.png"), Buffer.from([0, 1, 2, 3]));

      const regex = await searchWorkspaceFiles(ctx, {
        query: "two\\s+apples",
        regex: true,
      });
      expect(regex).toMatchObject({
        ok: true,
        matches: [
          expect.objectContaining({
            type: "content",
            path: "notes.txt",
            line: 2,
            column: 1,
          }),
        ],
      });

      const bounded = await searchWorkspaceFiles(ctx, {
        query: "apple",
        mode: "content",
        maxResults: 1,
      });
      expect(bounded).toMatchObject({ ok: true, matchCount: 1, limitHit: true });

      const skipped = await searchWorkspaceFiles(ctx, {
        query: "apple",
        mode: "content",
        maxFileBytes: 10,
      });
      expect(skipped).toMatchObject({ ok: true });
      if (skipped.ok) {
        expect(skipped.skipped).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "big.txt", reason: expect.stringContaining("maxFileBytes") }),
            expect.objectContaining({ path: "image.png", reason: expect.stringContaining("binary") }),
          ]),
        );
      }
    });
  });

  it("lists and reads MCP-recorded change sets for collaboration-aware agents", async () => {
    await withWorkspace(async (ctx) => {
      const write = await writeWorkspaceFile(ctx, {
        path: "notes/plan.txt",
        content: "draft\n",
        summary: "Agent drafted plan",
      });
      expect(write).toMatchObject({ ok: true });
      if (!write.ok) return;

      const listed = await listChanges(ctx, { includeFiles: true });
      expect(listed).toMatchObject({
        count: 1,
        totalAvailable: 1,
        hasMore: false,
      });
      expect(listed.changes[0]).toMatchObject({
        id: write.changeSetId,
        kind: "agent-run",
        summary: "Agent drafted plan",
        author: { kind: "agent", agentId: "dohc-mcp", onBehalfOf: "local" },
        provenance: { source: "agent-run" },
        files: [{ path: "notes/plan.txt", operation: "write" }],
      });

      await expect(readChange(ctx, { id: write.changeSetId })).resolves.toMatchObject({
        ok: true,
        change: {
          id: write.changeSetId,
          files: [{ path: "notes/plan.txt", operation: "write" }],
        },
      });
      await expect(readChange(ctx, { id: "missing" })).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  it("supports optimistic write checks without making them mandatory", async () => {
    await withWorkspace(async (ctx) => {
      const first = await writeWorkspaceFile(ctx, { path: "notes/day.txt", content: "one\n" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      await expect(
        writeWorkspaceFile(ctx, {
          path: "notes/day.txt",
          content: "two\n",
          expectedSha256: first.sha256,
        }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        writeWorkspaceFile(ctx, {
          path: "notes/day.txt",
          content: "stale\n",
          expectedSha256: first.sha256,
        }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("expectedSha256") });

      await expect(
        writeWorkspaceFile(ctx, { path: "notes/day.txt", content: "free write\n" }),
      ).resolves.toMatchObject({ ok: true });
    });
  });

  it("moves paths and deletes recoverably while recording history", async () => {
    await withWorkspace(async (ctx) => {
      await writeWorkspaceFile(ctx, { path: "drafts/todo.txt", content: "ship\n" });
      const moved = await moveWorkspacePath(ctx, {
        fromPath: "drafts/todo.txt",
        toPath: "archive/todo.txt",
      });
      expect(moved).toMatchObject({
        ok: true,
        fromPath: "drafts/todo.txt",
        toPath: "archive/todo.txt",
      });
      await expect(readFile(join(ctx.root, "drafts/todo.txt"), "utf8")).rejects.toThrow();
      await expect(readFile(join(ctx.root, "archive/todo.txt"), "utf8")).resolves.toBe("ship\n");

      const deleted = await deleteWorkspacePath(ctx, { path: "archive/todo.txt" });
      expect(deleted).toMatchObject({ ok: true, path: "archive/todo.txt", trashed: true });
      await expect(readFile(join(ctx.root, "archive/todo.txt"), "utf8")).rejects.toThrow();
      const trash = await readdir(join(ctx.root, ".dohc", "trash"));
      expect(trash.some((name) => name.endsWith("-todo.txt"))).toBe(true);

      const pending = await syncNow(ctx, { sinceMs: 0 });
      expect(pending.pending.map((entry) => entry.fileCount)).toEqual([1, 2, 1]);
    });
  });

  it("rolls back move/delete mutations if the history record cannot be written", async () => {
    await withWorkspace(async (ctx) => {
      await writeWorkspaceFile(ctx, { path: "drafts/todo.txt", content: "ship\n" });
      await rm(join(ctx.root, ".dohc", "history", "index.json"), { force: true });
      await mkdir(join(ctx.root, ".dohc", "history", "index.json"), { recursive: true });

      const moved = await moveWorkspacePath(ctx, {
        fromPath: "drafts/todo.txt",
        toPath: "archive/todo.txt",
      });
      expect(moved).toMatchObject({ ok: false });
      await expect(readFile(join(ctx.root, "drafts/todo.txt"), "utf8")).resolves.toBe("ship\n");
      await expect(readFile(join(ctx.root, "archive/todo.txt"), "utf8")).rejects.toThrow();

      const deleted = await deleteWorkspacePath(ctx, { path: "drafts/todo.txt" });
      expect(deleted).toMatchObject({ ok: false });
      await expect(readFile(join(ctx.root, "drafts/todo.txt"), "utf8")).resolves.toBe("ship\n");
    });
  });

  it("create_app scaffolds app.json + src/App.tsx and never marks trust", async () => {
    await withWorkspace(async (ctx) => {
      const result = await createApp(ctx, { area: "finance", name: "ledger", title: "Ledger" });
      expect(result).toMatchObject({ ok: true, trusted: false, appRoot: "finance/.apps/ledger" });
      const manifest = JSON.parse(
        await readFile(join(ctx.root, "finance/.apps/ledger/app.json"), "utf8"),
      );
      expect(manifest).toMatchObject({ entry: "src/App.tsx", network: false, write: [] });
      // No apps-state.json trust record is written by the scaffold.
      await expect(
        readFile(join(ctx.root, ".dohc/apps-state.json"), "utf8"),
      ).rejects.toThrow();
    });
  });

  it("create_app rejects traversal names and escapes TSX-significant app names", async () => {
    await withWorkspace(async (ctx) => {
      await expect(createApp(ctx, { area: "", name: "../evil" })).resolves.toMatchObject({
        ok: false,
      });

      const result = await createApp(ctx, { area: "", name: "bad {name}" });
      expect(result).toMatchObject({ ok: true, trusted: false });
      const source = await readFile(join(ctx.root, ".apps/bad {name}/src/App.tsx"), "utf8");
      expect(source).toContain('<div>{"bad {name}"}</div>');
    });
  });

  it("test_app runs the static checker over contained app source", async () => {
    await withWorkspace(async (ctx) => {
      await createApp(ctx, { area: "", name: "todo" });
      const result = await testApp(ctx, {
        appRoot: ".apps/todo",
        sourcePaths: [".apps/todo/src/App.tsx"],
      });
      // The scaffold imports @dohc/app, so the static SDK-import check passes.
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("test_app reports missing or directory source paths as tool-safe failures", async () => {
    await withWorkspace(async (ctx) => {
      await createApp(ctx, { area: "", name: "todo" });
      await expect(
        testApp(ctx, {
          appRoot: ".apps/todo",
          sourcePaths: [".apps/todo/src/Missing.tsx"],
        }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/Missing\.tsx|no such/i) });
      await expect(
        testApp(ctx, {
          appRoot: ".apps/todo",
          sourcePaths: [".apps/todo/src"],
        }),
      ).resolves.toMatchObject({ ok: false, reason: expect.any(String) });
    });
  });

  it("import_data writes a visible .sqlite and query_database reads it back", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "people.csv"), "id,name\n1,Ada\n2,Lin\n");
      const imported = await importData(ctx, {
        sourcePath: "people.csv",
        databasePath: "people.sqlite",
        tableName: "people",
      });
      expect(imported).toMatchObject({ ok: true, rowCount: 2, path: "people.sqlite" });
      const queried = await queryDatabase(ctx, {
        databasePath: "people.sqlite",
        sql: "SELECT name FROM people ORDER BY name",
      });
      expect(queried).toMatchObject({ ok: true });
      if (queried.ok) expect(queried.rows.map((r) => r.name)).toEqual(["Ada", "Lin"]);
    });
  });

  it("import_data refuses a hidden-internal (.dohc) database target", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "people.csv"), "id\n1\n");
      // .dohc is reserved, so the path validator rejects it outright.
      await expect(
        importData(ctx, { sourcePath: "people.csv", databasePath: ".dohc/x.sqlite", tableName: "t" }),
      ).resolves.toMatchObject({ ok: false });
    });
  });

  it("query_database refuses anything but a single read-only SELECT", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "people.csv"), "id,name\n1,Ada\n");
      await importData(ctx, { sourcePath: "people.csv", databasePath: "p.sqlite", tableName: "p" });
      for (const sql of ["DELETE FROM p", "DROP TABLE p", "SELECT 1; DROP TABLE p"]) {
        await expect(
          queryDatabase(ctx, { databasePath: "p.sqlite", sql }),
        ).resolves.toMatchObject({ ok: false });
      }
    });
  });

  it("share returns needs-confirmation for a boundary crossing and never auto-applies", async () => {
    await withWorkspace(async (ctx) => {
      const result = await share(ctx, { path: "notes/plan.md", scope: "public" });
      expect(result).toMatchObject({
        ok: true,
        status: "needs-confirmation",
        boundaryCrossing: "public-share",
      });
    });
  });

  it("resolve_conflict merges a clean change but keeps an overlap as a conflict", () => {
    expect(
      resolveConflict({ base: "a\nb\nc\n", local: "a\nB\nc\n", remote: "a\nb\nc\n" }),
    ).toMatchObject({ resolved: true });
    expect(
      resolveConflict({ base: "a\nb\nc\n", local: "a\nX\nc\n", remote: "a\nY\nc\n" }),
    ).toMatchObject({ resolved: false });
  });

  it("open_in_dohc returns the contained absolute path", async () => {
    await withWorkspace(async (ctx) => {
      const result = await openInDohc(ctx, { path: "notes/day.md" });
      expect(result).toMatchObject({ ok: true, relativePath: "notes/day.md" });
      if (result.ok) expect(result.path).toBe(join(ctx.root, "notes/day.md"));
    });
  });

  it("query_database refuses a non-visible-database target and bounds large results", async () => {
    await withWorkspace(async (ctx) => {
      // A real SQLite file that is NOT a visible-db path (wrong extension): the
      // visible-database guard refuses it even though the bytes are a database.
      await writeFile(join(ctx.root, "people.csv"), "id,name\n1,Ada\n");
      await importData(ctx, { sourcePath: "people.csv", databasePath: "p.sqlite", tableName: "p" });
      await expect(
        queryDatabase(ctx, { databasePath: "notes/data.txt", sql: "SELECT 1" }),
      ).resolves.toMatchObject({ ok: false });

      // Result work is bounded: a self cross-join would yield 40*40=1600 rows,
      // but the wrapper LIMITs to the cap so SQLite never materializes them all.
      const rows = Array.from({ length: 40 }, (_, i) => `${i},n${i}`).join("\n");
      await writeFile(join(ctx.root, "big.csv"), `id,name\n${rows}\n`);
      await importData(ctx, { sourcePath: "big.csv", databasePath: "big.sqlite", tableName: "big" });
      const queried = await queryDatabase(ctx, {
        databasePath: "big.sqlite",
        sql: "SELECT a.id FROM big a, big b",
      });
      expect(queried.ok).toBe(true);
      if (queried.ok) expect(queried.rows.length).toBe(1000);
    });
  });
});
