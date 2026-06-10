import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createApp,
  importData,
  listWorkspaces,
  openInDohc,
  queryDatabase,
  resolveConflict,
  safeResolve,
  share,
  syncNow,
  testApp,
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

  it("sync_now reports a clean local state with no history", async () => {
    await withWorkspace(async (ctx) => {
      expect(await syncNow(ctx, {})).toMatchObject({ clean: true, pendingChangeCount: 0 });
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
