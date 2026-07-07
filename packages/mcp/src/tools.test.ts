import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { addFileChanges, createChangeSet, createLocalChangeAuthor } from "@dohc/workspace-core";
import {
  createChangeSetStore,
  isDurableChangeSetRecordingSupported,
} from "@dohc/workspace-history";
import {
  createWorkspaceDirectory,
  addSiteSdk,
  buildSite,
  createSite,
  deleteWorkspacePath,
  detectSites,
  importData,
  listWorkspaceFiles,
  listChanges,
  listWorkspaces,
  moveWorkspacePath,
  openInDohc,
  previewSite,
  publishSite,
  queryDatabase,
  readChange,
  readWorkspaceFile,
  resolveConflict,
  safeResolve,
  searchWorkspaceFiles,
  share,
  testSite,
  writeWorkspaceFile,
  workspaceStatus,
  type ToolContext,
} from "./tools";

// Keep these split so siteNoLegacyAppModel.test.ts does not flag this
// compatibility regression fixture as active legacy guidance.
const LEGACY_APPS_SEGMENT = `.${"apps"}`;
const LEGACY_SDK_PACKAGE = `@dohc/${"app"}`;
const importLegacySdk = `import "${LEGACY_SDK_PACKAGE}";\n`;

const TEST_SDK_PACKAGE_JSON_PATH =
  process.env.DOHC_TEST_SDK_PACKAGE_JSON?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), "../../sdk/package.json");

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-test-"));
  const root = join(base, "ws");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({ root, home, sdkPackageJsonPath: TEST_SDK_PACKAGE_JSON_PATH });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}


// WS-H1 flag flip: the engine is the default; an explicit opt-out disables
// recording entirely (retirement Phase C removed the legacy recorder). Tests
// seed this to pin the opted-out shapes: mutating tools report
// historyRecording: "off" and the chat tools refuse.
async function seedLegacyOptOut(ctx: ToolContext): Promise<void> {
  await mkdir(join(ctx.root, ".dohc"), { recursive: true });
  await writeFile(
    join(ctx.root, ".dohc", "settings.local.json"),
    `${JSON.stringify({
      version: 1,
      agents: { mcpAutoStart: false, defaultDriverId: null, defaultModel: null },
      sites: { defaultPreviewMode: "auto" },
      privacy: { confirmExternalLinks: true },
      experimental: { workspaceEngineAlpha: false },
    }, null, 2)}\n`,
  );
}

async function withProcessPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  }
}

const itDurableHistory = isDurableChangeSetRecordingSupported() ? it : it.skip;

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

  it("create_site refuses traversal, .dohc, and legacy app folders", async () => {
    await withWorkspace(async (ctx) => {
      await expect(createSite(ctx, { path: "../x" })).resolves.toMatchObject({ ok: false });
      await expect(createSite(ctx, { path: ".dohc/x" })).resolves.toMatchObject({ ok: false });
      await expect(createSite(ctx, { path: `finance/${LEGACY_APPS_SEGMENT}/x` })).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining(`legacy ${LEGACY_APPS_SEGMENT}`),
      });
    });
  });

  it("query_database, import_data, site tools, open_in_dohc, share all refuse traversal", async () => {
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
        await expect(detectSites(ctx, { path: evil })).resolves.toMatchObject({ ok: false });
        await expect(testSite(ctx, { siteRoot: evil })).resolves.toMatchObject({ ok: false });
        await expect(buildSite(ctx, { siteRoot: evil })).resolves.toMatchObject({ ok: false });
        await expect(previewSite(ctx, { siteRoot: evil })).resolves.toMatchObject({ ok: false });
        await expect(publishSite(ctx, { siteRoot: evil })).resolves.toMatchObject({ ok: false });
        await expect(addSiteSdk(ctx, { siteRoot: evil })).resolves.toMatchObject({ ok: false });
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

  it("writes, reads, and lists arbitrary visible files (no legacy change sets after Phase C)", async () => {
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

      // Retirement Phase C: the write carried no legacy change set (the engine
      // is the recorder).
      expect(written).toMatchObject({ recordedBy: "workspace-engine" });
    });
  });

  it("mutating tools work on platforms without durable legacy history (Phase C: engine capture needs none)", async () => {
    await withWorkspace(async (ctx) => {
      await withProcessPlatform("darwin", async () => {
        // The retired legacy recorder used to fail closed here; the engine
        // capture path has no such platform gate, so mutations proceed.
        await expect(
          writeWorkspaceFile(ctx, { path: "notes/nested/plan.txt", content: "draft\n" }),
        ).resolves.toMatchObject({ ok: true, recordedBy: "workspace-engine" });
        await expect(readFile(join(ctx.root, "notes/nested/plan.txt"), "utf8")).resolves.toBe(
          "draft\n",
        );
        await expect(createWorkspaceDirectory(ctx, { path: "new-folder" })).resolves.toMatchObject({
          ok: true,
          recordedBy: "workspace-engine",
        });
        await expect(readdir(join(ctx.root, "new-folder"))).resolves.toEqual([]);
      });
    });
  });

  it("reads ephemeral watcher history when durable history is unsupported", async () => {
    await withWorkspace(async (ctx) => {
      await seedLegacyOptOut(ctx);
      await withProcessPlatform("darwin", async () => {
        const store = createChangeSetStore(ctx.root, { ephemeralIfUnsupported: true });
        const set = addFileChanges(
          createChangeSet({
            kind: "user-edit",
            author: createLocalChangeAuthor("Local file edit"),
            summary: "Edited note from watcher",
            provenance: { source: "user-edit" },
          }),
          [{ path: "notes/watched.md", operation: "write" }],
        );
        await store.record(set, { id: "watcher-record-1", recordedAtMs: 1234 });

        await expect(listChanges(ctx, { includeFiles: true })).resolves.toMatchObject({
          count: 1,
          changes: [
            expect.objectContaining({
              id: "watcher-record-1",
              files: [{ path: "notes/watched.md", operation: "write" }],
            }),
          ],
        });
        await expect(readChange(ctx, { id: "watcher-record-1" })).resolves.toMatchObject({
          ok: true,
          change: expect.objectContaining({ id: "watcher-record-1" }),
        });

        // Phase C: writes are no longer blocked by the durable-history
        // platform gate (and they add no legacy records either). This
        // workspace explicitly opted out of the engine, so the write reports
        // recording honestly OFF — never a recorder that isn't running.
        await expect(
          writeWorkspaceFile(ctx, { path: "notes/unblocked.md", content: "fine\n" }),
        ).resolves.toMatchObject({ ok: true, historyRecording: "off" });
        await expect(listChanges(ctx, {})).resolves.toMatchObject({ count: 1 });
      });
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

  it("denies reading secret-backed file contents with a clear reason (PR 08 default deny)", async () => {
    await withWorkspace(async (ctx) => {
      const marker = "MCP_SECRET_MARKER_42";
      await writeFile(join(ctx.root, ".env"), `API_KEY=${marker}\n`);
      await mkdir(join(ctx.root, "config"), { recursive: true });
      await writeFile(join(ctx.root, "config", "prod.env"), `PROD=${marker}\n`);

      for (const path of [".env", "config/prod.env", "secrets%2eenv"]) {
        const denied = await readWorkspaceFile(ctx, { path });
        expect(denied).toMatchObject({
          ok: false,
          reason: expect.stringContaining("protected"),
        });
        expect(JSON.stringify(denied)).not.toContain(marker);
      }

      // Ordinary files still read fine (the denial is floor-scoped).
      await writeFile(join(ctx.root, "environment.md"), "notes about env\n");
      await expect(readWorkspaceFile(ctx, { path: "environment.md" })).resolves.toMatchObject({
        ok: true,
      });
    });
  });

  it("denies reading secrets through an in-workspace symlink alias (CodeRabbit major)", async () => {
    await withWorkspace(async (ctx) => {
      const marker = "MCP_ALIAS_SECRET_7";
      await writeFile(join(ctx.root, ".env"), `API_KEY=${marker}\n`);
      await writeFile(join(ctx.root, ".env.local"), `LOCAL=${marker}\n`);
      // A symlink INSIDE the workspace passes lexical validation and realpath
      // containment, but the read follows it to the secret: the resolved
      // real target must be classified too.
      await symlink(join(ctx.root, ".env"), join(ctx.root, "notes.md"));
      for (const path of ["notes.md", ".env.local"]) {
        const denied = await readWorkspaceFile(ctx, { path });
        expect(denied).toMatchObject({
          ok: false,
          reason: expect.stringContaining("protected"),
        });
        expect(JSON.stringify(denied)).not.toContain(marker);
      }
    });
  });

  it("never searches secret-backed files and reports the skip honestly", async () => {
    await withWorkspace(async (ctx) => {
      const marker = "MCP_SEARCH_SECRET_99";
      await writeFile(join(ctx.root, ".env"), `TOKEN=${marker}\n`);
      await writeFile(join(ctx.root, "readme.md"), `The word ${marker} in a normal file\n`);

      const result = await searchWorkspaceFiles(ctx, { query: marker });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      // Only the ordinary file matches; the secret path never surfaces a
      // match or preview.
      expect(result.matches.map((match) => match.path)).toEqual(["readme.md"]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ".env", reason: expect.stringContaining("protected") }),
        ]),
      );
      // Even a path-mode search for the file name itself stays silent.
      const byName = await searchWorkspaceFiles(ctx, { query: ".env", mode: "path" });
      expect(byName).toMatchObject({ ok: true });
      if (byName.ok) {
        expect(byName.matches.map((match) => match.path)).not.toContain(".env");
      }
    });
  });

  it("lists and reads pre-flip legacy change sets as a read-only relic (writes add none)", async () => {
    await withWorkspace(async (ctx) => {
      // A record left behind by a pre-flip version of the app.
      const store = createChangeSetStore(ctx.root);
      await store.record(
        addFileChanges(
          createChangeSet({
            kind: "user-edit",
            author: createLocalChangeAuthor("Local file edit"),
            summary: "Pre-flip edit",
            provenance: { source: "user-edit" },
          }),
          [{ path: "notes/old.md", operation: "write" }],
        ),
        { id: "relic-1", recordedAtMs: 1000 },
      );

      // A new MCP write records NOTHING legacy (Phase C)...
      await expect(
        writeWorkspaceFile(ctx, { path: "notes/plan.txt", content: "draft\n" }),
      ).resolves.toMatchObject({ ok: true, recordedBy: "workspace-engine" });

      // ...while the read tools still serve the relic.
      const listed = await listChanges(ctx, { includeFiles: true });
      expect(listed).toMatchObject({ count: 1, totalAvailable: 1, hasMore: false });
      expect(listed.changes[0]).toMatchObject({
        id: "relic-1",
        summary: "Pre-flip edit",
        files: [{ path: "notes/old.md", operation: "write" }],
      });
      await expect(readChange(ctx, { id: "relic-1" })).resolves.toMatchObject({
        ok: true,
        change: { id: "relic-1" },
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

  itDurableHistory("preserves file modes and refuses symlink targets on workspace writes", async () => {
    await withWorkspace(async (ctx) => {
      const modePath = join(ctx.root, "scripts/run.sh");
      await mkdir(dirname(modePath), { recursive: true });
      await writeFile(modePath, "old\n");
      await chmod(modePath, 0o744);
      // Windows has no POSIX modes (chmod only toggles the read-only bit), so
      // pin what the platform can express: whatever stat reported before the
      // write must survive the engine overwrite. On POSIX that value is the
      // full 0o744 asserted below.
      const modeBefore = (await stat(modePath)).mode & 0o777;
      if (process.platform !== "win32") {
        expect(modeBefore).toBe(0o744);
      }

      const overwritten = await writeWorkspaceFile(ctx, {
        path: "scripts/run.sh",
        content: "new\n",
      });

      expect(overwritten).toMatchObject({ ok: true });
      expect((await stat(modePath)).mode & 0o777).toBe(modeBefore);

      const outside = await mkdtemp(join(tmpdir(), "dohc-mcp-symlink-target-"));
      try {
        await writeFile(join(outside, "target.txt"), "outside\n");
        await symlink(join(outside, "target.txt"), join(ctx.root, "linked.txt"));

        const linked = await writeWorkspaceFile(ctx, {
          path: "linked.txt",
          content: "nope\n",
        });

        expect(linked).toMatchObject({ ok: false });
        if (!linked.ok) expect(linked.reason).toContain("symlink");
        await expect(readFile(join(outside, "target.txt"), "utf8")).resolves.toBe("outside\n");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("moves paths and deletes recoverably (engine-recorded, trash-backed)", async () => {
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
      await expect(readFile(join(ctx.root, "drafts/todo.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(ctx.root, "archive/todo.txt"), "utf8")).resolves.toBe("ship\n");

      const deleted = await deleteWorkspacePath(ctx, { path: "archive/todo.txt" });
      expect(deleted).toMatchObject({ ok: true, path: "archive/todo.txt", trashed: true });
      await expect(readFile(join(ctx.root, "archive/todo.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      const trash = await readdir(join(ctx.root, ".dohc", "trash"));
      expect(trash.some((name) => name.endsWith("-todo.txt"))).toBe(true);

      // Phase C: none of the mutations wrote a legacy change set.
      expect(moved).toMatchObject({ recordedBy: "workspace-engine" });
      expect(deleted).toMatchObject({ recordedBy: "workspace-engine" });
    });
  });

  itDurableHistory("does not record unchanged directory creates", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "docs"), { recursive: true });

      const created = await createWorkspaceDirectory(ctx, { path: "docs" });

      expect(created).toMatchObject({ ok: true, path: "docs", unchanged: true });
      expect("changeSetId" in created).toBe(false);
      await expect(listChanges(ctx)).resolves.toMatchObject({
        count: 0,
        totalAvailable: 0,
      });
    });
  });

  it("create_site scaffolds a normal website (engine-recorded)", async () => {
    await withWorkspace(async (ctx) => {
      const result = await createSite(ctx, { path: "finance/ledger", title: "Ledger" });
      expect(result).toMatchObject({ ok: true, siteRoot: "finance/ledger" });
      if (!result.ok) return;
      expect(result.files).toEqual(
        expect.arrayContaining([
          "finance/ledger/index.html",
          "finance/ledger/styles.css",
          "finance/ledger/script.js",
          "finance/ledger/scripts/build-static.mjs",
          "finance/ledger/package.json",
          "finance/ledger/dohc.json",
        ]),
      );
      const html = await readFile(join(ctx.root, "finance/ledger/index.html"), "utf8");
      const packageJson = JSON.parse(await readFile(join(ctx.root, "finance/ledger/package.json"), "utf8"));
      const config = JSON.parse(await readFile(join(ctx.root, "finance/ledger/dohc.json"), "utf8"));
      expect(html).toContain("<title>Ledger</title>");
      expect(html).not.toContain(LEGACY_SDK_PACKAGE);
      expect(packageJson).toMatchObject({
        private: true,
        type: "module",
        engines: {
          node: ">=14.8.0",
        },
        scripts: {
          dev: "serve . --listen 127.0.0.1:4173",
          build: "node scripts/build-static.mjs",
          preview: "serve dist --listen 127.0.0.1:4173",
        },
        devDependencies: {
          serve: "14.2.6",
        },
      });
      expect(config).toMatchObject({ type: "site", title: "Ledger", build: { output: "dist" } });
      // Phase C: the scaffold reports the engine as recorder; no change set.
      await expect(listChanges(ctx, { includeFiles: true })).resolves.toMatchObject({
        count: 0,
      });
    });
  });

  it("create_site rejects existing non-empty folders and can omit dohc.json", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "existing"), { recursive: true });
      await writeFile(join(ctx.root, "existing/file.txt"), "no overwrite");
      await expect(createSite(ctx, { path: "existing" })).resolves.toMatchObject({ ok: false });

      const result = await createSite(ctx, {
        path: "plain-site",
        title: "Plain Site",
        withDohcJson: false,
      });
      expect(result).toMatchObject({ ok: true, siteRoot: "plain-site" });
      await expect(readFile(join(ctx.root, "plain-site/dohc.json"), "utf8")).rejects.toThrow();
    });
  });

  it("detect_sites finds configured, package, and static sites", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "configured", title: "Configured" });
      await mkdir(join(ctx.root, "static"), { recursive: true });
      await writeFile(join(ctx.root, "static/index.html"), "<h1>Static</h1>");
      await mkdir(join(ctx.root, "vitey"), { recursive: true });
      await writeFile(
        join(ctx.root, "vitey/package.json"),
        JSON.stringify({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^7.0.0" } }),
      );
      await writeFile(join(ctx.root, "vitey/vite.config.ts"), "export default {};");

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true, detector: "mcp-local", count: 3 });
      if (!result.ok) return;
      expect(result.sites.map((site) => [site.root, site.kind, site.confidence])).toEqual([
        ["configured", "configured", "high"],
        ["static", "static", "medium"],
        ["vitey", "package", "medium"],
      ]);
      expect(result.sites.find((site) => site.root === "vitey")).toMatchObject({
        scripts: { dev: "vite", build: "vite build" },
      });
    });
  });

  it("detect_sites returns repairable diagnostics for invalid dohc.json", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "broken"), { recursive: true });
      await writeFile(join(ctx.root, "broken/dohc.json"), "{");
      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true, count: 1 });
      if (!result.ok) return;
      expect(result.sites[0]).toMatchObject({
        root: "broken",
        kind: "configured",
        diagnostics: [expect.objectContaining({ code: "invalid_dohc_json", severity: "error" })],
      });
    });
  });

  it("detect_sites ignores non-site dohc.json unless website signals conflict", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "workflow"), { recursive: true });
      await writeFile(join(ctx.root, "workflow/dohc.json"), JSON.stringify({ type: "workflow" }));
      await mkdir(join(ctx.root, "conflict"), { recursive: true });
      await writeFile(join(ctx.root, "conflict/dohc.json"), JSON.stringify({ type: "workflow" }));
      await writeFile(join(ctx.root, "conflict/index.html"), "<h1>Conflict</h1>");

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true, count: 1 });
      if (!result.ok) return;
      expect(result.sites[0]).toMatchObject({
        root: "conflict",
        diagnostics: [expect.objectContaining({ code: "unexpected_dohc_type" })],
      });
    });
  });

  it("test_site validates entries and refuses legacy app SDK imports", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "todo" });
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({ ok: true });

      await writeFile(join(ctx.root, "todo/script.js"), `// ${importLegacySdk}`);
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({ ok: true });

      await writeFile(join(ctx.root, "todo/script.js"), `const marker = "/* ${LEGACY_SDK_PACKAGE} */";\n`);
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({ ok: true });

      await writeFile(
        join(ctx.root, "todo/script.js"),
        `const slashOrStar = /[/*]/;\n${importLegacySdk}`,
      );
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "no-legacy-sdk-import", ok: false }),
        ]),
      });

      await writeFile(join(ctx.root, "todo/script.js"), importLegacySdk);
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "no-legacy-sdk-import", ok: false }),
        ]),
      });

      await writeFile(join(ctx.root, "todo/script.js"), "x".repeat(2 * 1024 * 1024 + 1));
      await expect(testSite(ctx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: false,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "no-legacy-sdk-import",
            ok: false,
            message: "Site source is too large for MCP static validation.",
          }),
        ]),
      });
    });
  });

  it("build_site returns the detected build plan without executing it", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "todo", title: "Todo" });
      const result = await buildSite(ctx, { siteRoot: "todo" });
      expect(result).toMatchObject({
        ok: true,
        status: "planned",
        siteRoot: "todo",
        command: "npm run build",
        output: "dist",
      });
    });
  });

  it("preview_site returns available dohc preview modes", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "todo", title: "Todo" });
      const result = await previewSite(ctx, { siteRoot: "todo" });
      expect(result).toMatchObject({
        ok: true,
        siteRoot: "todo",
        modes: expect.arrayContaining([
          expect.objectContaining({ mode: "static", entry: "todo/index.html" }),
          expect.objectContaining({ mode: "dev", command: "dev" }),
          expect.objectContaining({ mode: "build", output: "dist" }),
        ]),
      });
    });
  });

  it("add_sdk wires @dohc/sdk into a normal website package", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "todo", title: "Todo" });
      const result = await addSiteSdk(ctx, { siteRoot: "todo" });
      expect(result).toMatchObject({
        ok: true,
        siteRoot: "todo",
        packagePath: "todo/package.json",
        dependency: "@dohc/sdk",
      });
      const sdkPackageJson = JSON.parse(
        await readFile(TEST_SDK_PACKAGE_JSON_PATH, "utf8"),
      ) as { version: string };
      const packageJson = JSON.parse(await readFile(join(ctx.root, "todo/package.json"), "utf8"));
      expect(packageJson.dependencies).toMatchObject({
        "@dohc/sdk": `^${sdkPackageJson.version}`,
      });
      expect(result.ok ? result.usage : "").toContain('import { dohc } from "@dohc/sdk"');
    });
  });

  it("add_sdk refreshes the SDK dependency range when package metadata changes", async () => {
    await withWorkspace(async (ctx) => {
      const sdkPackageJsonPath = join(ctx.home, "sdk-package.json");
      await writeFile(sdkPackageJsonPath, `${JSON.stringify({ version: "1.0.0" })}\n`);
      const customCtx = { ...ctx, sdkPackageJsonPath };
      await createSite(customCtx, { path: "todo", title: "Todo" });

      await expect(addSiteSdk(customCtx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: true,
      });
      await writeFile(sdkPackageJsonPath, `${JSON.stringify({ version: "2.0.0" })}\n`);
      const bumped = new Date(Date.now() + 5000);
      await utimes(sdkPackageJsonPath, bumped, bumped);

      await expect(addSiteSdk(customCtx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: true,
      });
      const packageJson = JSON.parse(await readFile(join(ctx.root, "todo/package.json"), "utf8"));
      expect(packageJson.dependencies).toMatchObject({ "@dohc/sdk": "^2.0.0" });
    });
  });

  it("add_sdk refuses to overwrite malformed package metadata", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "todo"), { recursive: true });
      await writeFile(join(ctx.root, "todo", "index.html"), "<h1>Todo</h1>");
      await writeFile(join(ctx.root, "todo", "package.json"), "{ bad");

      await expect(addSiteSdk(ctx, { siteRoot: "todo" })).resolves.toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid package.json"),
      });
      await expect(readFile(join(ctx.root, "todo", "package.json"), "utf8")).resolves.toBe(
        "{ bad",
      );
    });
  });

  it("publish_site stops at the explicit dohc Cloud review boundary", async () => {
    await withWorkspace(async (ctx) => {
      await createSite(ctx, { path: "todo", title: "Todo" });
      const result = await publishSite(ctx, { siteRoot: "todo" });
      expect(result).toMatchObject({
        ok: false,
        status: "review-required",
        siteRoot: "todo",
        reason: expect.stringMatching(/cloud boundary/i),
        review: {
          siteRoot: "todo",
          includesSharedWithMe: false,
        },
      });
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

  itDurableHistory("import_data returns a structured failure without replacing an existing database", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "people.csv"), "id,name\n1,Ada\n");
      await writeFile(join(ctx.root, "people.sqlite"), "already here\n");

      const imported = await importData(ctx, {
        sourcePath: "people.csv",
        databasePath: "people.sqlite",
        tableName: "people",
      });

      expect(imported).toMatchObject({
        ok: false,
        reason: expect.stringContaining("EEXIST"),
      });
      await expect(readFile(join(ctx.root, "people.sqlite"), "utf8")).resolves.toBe("already here\n");
      await expect(listChanges(ctx, { limit: 10 })).resolves.toMatchObject({
        changes: [],
      });
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
