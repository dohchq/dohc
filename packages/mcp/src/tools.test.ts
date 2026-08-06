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
  isWorkspaceEngineFlagged,
  type ToolContext,
} from "./tools";
import { DEFAULT_WORKSPACE_SETTINGS } from "@dohc/workspace-contracts/workspace-settings";

// The trash destination carries a uuid, so a test that needs to pre-create it
// has to know it. Pass-through until a test arms it; only the rename-failure
// test below does.
const uuidOverride = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => uuidOverride.value ?? actual.randomUUID(),
  };
});

// A delete looks at its path twice -- before the move, and after the move
// fails -- and both looks must be able to fail on demand, on a host where a
// real unreadable directory is not arrangeable. Each armed entry is consumed
// by one matching call: null passes through, an error is thrown.
// `inodes` substitutes the ino a matching call reports, likewise one entry per
// call. NTFS always supplies a real file index, so a filesystem that has none
// to give -- some network shares, FAT -- is not arrangeable on this host.
const lstatOverride = vi.hoisted(() => ({
  path: null as string | null,
  results: [] as (NodeJS.ErrnoException | null)[],
  inodes: [] as (number | null)[],
}));
// A path another process changes between the check and the rename. It happens
// inside the rename call, which is the race itself. `replaceWith` names an
// entry to move ON TOP of the path -- a real second file, so the replacement
// carries its own inode and no test depends on a deleted one not being reused.
// Without it the path is simply removed.
const renameRace = vi.hoisted(() => ({
  path: null as string | null,
  replaceWith: null as string | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      const armed = lstatOverride.path === String(path);
      if (armed && lstatOverride.results.length > 0) {
        const failure = lstatOverride.results.shift();
        if (failure) throw failure;
      }
      const stats = await actual.lstat(path);
      if (armed && lstatOverride.inodes.length > 0) {
        const ino = lstatOverride.inodes.shift();
        // Copy through the prototype so the Stats methods survive.
        if (ino !== null && ino !== undefined) {
          return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { ino });
        }
      }
      return stats;
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameRace.path === String(from)) {
        const replaceWith = renameRace.replaceWith;
        renameRace.path = null;
        renameRace.replaceWith = null;
        if (replaceWith) await actual.rename(replaceWith, from);
        else await actual.rm(from);
      }
      return actual.rename(from, to);
    },
  };
});

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: forced by test`), { code });
}

// A tool result is a union and only its refusal arm carries `reason`. Throws
// on a success rather than narrowing silently, so a tool that should have
// refused is reported as that instead of an assertion against `undefined`.
function refusalReason(result: { ok: true } | { ok: false; reason: string }): string {
  if (result.ok) throw new Error("expected a refusal, got a successful result");
  return result.reason;
}

// Keep these split so siteNoLegacyAppModel.test.ts does not flag this
// compatibility regression fixture as active legacy guidance.
const LEGACY_APPS_SEGMENT = `.${"apps"}`;
const LEGACY_SDK_PACKAGE = `@dohc/${"app"}`;
const importLegacySdk = `import "${LEGACY_SDK_PACKAGE}";\n`;

const TEST_SDK_PACKAGE_JSON_PATH =
  process.env.DOHC_TEST_SDK_PACKAGE_JSON?.trim() ||
  join(dirname(fileURLToPath(import.meta.url)), "../../sdk/package.json");

const emptyDesktopHistoryRequest: NonNullable<ToolContext["request"]> = async (request) => {
  if (request.verb === "moments") {
    return {
      changes: [],
      count: 0,
      totalAvailable: 0,
      hasMore: false,
      cursorMs: request.args.sinceMs ?? 0,
    };
  }
  if (request.verb === "moment") {
    return { ok: false, reason: `change not found: ${request.args.id}` };
  }
  throw new Error(`unexpected CLI verb in file-tools suite: ${request.verb}`);
};

async function withWorkspace<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
  const base = await mkdtemp(join(tmpdir(), "dohc-mcp-test-"));
  const root = join(base, "ws");
  const home = join(base, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  try {
    return await fn({
      root,
      home,
      sdkPackageJsonPath: TEST_SDK_PACKAGE_JSON_PATH,
      request: emptyDesktopHistoryRequest,
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
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

// The engine capture path these tests exercise relies on Linux descriptor-
// relative fs (the same platform gate the retired durable history used).
const itDurableHistory = process.platform === "linux" ? it : it.skip;

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
    ownerUserId?: string;
    credentialUserId?: string | null;
    token?: string;
    credentials?: boolean;
  } = {},
) {
  const serverUrl = options.serverUrl ?? "http://cloud.test";
  const remoteWorkspaceId = options.remoteWorkspaceId ?? "ws-1";
  const ownerUserId = options.ownerUserId ?? "user-1";
  const credentialUserId =
    options.credentialUserId === undefined ? "user-1" : options.credentialUserId;
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
          remote: {
            serverUrl,
            remoteWorkspaceId,
            ownerUserId,
          },
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
      ...(credentialUserId === null ? {} : { userId: credentialUserId }),
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

  it("shared-with-me is agent-READABLE but never agent-writable (share mounts)", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "shared-with-me", "alex"), { recursive: true });
      await writeFile(join(ctx.root, "shared-with-me", "alex", "brief.md"), "the brief");

      // Reads: list, read, search all see the mounted projection.
      const listed = await listWorkspaceFiles(ctx, { path: "shared-with-me/alex" });
      expect(listed).toMatchObject({ ok: true });
      const read = await readWorkspaceFile(ctx, { path: "shared-with-me/alex/brief.md" });
      expect(read).toMatchObject({ ok: true, content: "the brief" });
      const found = await searchWorkspaceFiles(ctx, {
        path: "shared-with-me/alex",
        query: "brief",
      });
      expect(found).toMatchObject({ ok: true });

      // The secret floor holds INSIDE mounts: a mounted .env is denied to
      // reads and searches even though the mount itself is readable.
      await writeFile(join(ctx.root, "shared-with-me", "alex", ".env"), "API_KEY=x");
      await expect(
        readWorkspaceFile(ctx, { path: "shared-with-me/alex/.env" }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("protected") });
      const secretSearch = await searchWorkspaceFiles(ctx, {
        path: "shared-with-me/alex",
        query: "API_KEY",
      });
      expect(secretSearch).toMatchObject({ ok: true });
      if (secretSearch.ok) {
        expect(JSON.stringify(secretSearch)).not.toContain("API_KEY=x");
      }

      // The floor also covers the import/query LAUNDERING paths: a secret
      // source must not become a visible database, and a secret-named
      // database must not answer SELECTs (mounted or local).
      await writeFile(join(ctx.root, "shared-with-me", "alex", ".env.csv"), "k,v\nX,1");
      await expect(
        importData(ctx, {
          sourcePath: "shared-with-me/alex/.env.csv",
          databasePath: "laundered.sqlite",
          tableName: "t",
        }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("protected") });
      const secretDb = await queryDatabase(ctx, {
        databasePath: "shared-with-me/alex/.env.sqlite",
        sql: "SELECT 1",
      });
      expect(secretDb).toMatchObject({ ok: false, reason: expect.stringContaining("protected") });

      // Read-side resolution also covers open + database query paths.
      const opened = await openInDohc(ctx, { path: "shared-with-me/alex/brief.md" });
      expect(opened).toMatchObject({ ok: true });
      // The database file doesn't exist (open throws), but the failure must
      // never be the reserved prefix — mounted databases are queryable.
      const queried = await queryDatabase(ctx, {
        databasePath: "shared-with-me/alex/data.sqlite",
        sql: "SELECT 1",
      }).catch((error: unknown) => ({
        ok: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
      expect(queried.ok).toBe(false);
      if (!queried.ok) expect(queried.reason).not.toContain("reserved");

      // Writes: every mutation refuses the reserved projection.
      await expect(
        writeWorkspaceFile(ctx, { path: "shared-with-me/alex/brief.md", content: "hijack" }),
      ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("reserved") });
      await expect(
        createWorkspaceDirectory(ctx, { path: "shared-with-me/mine" }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        deleteWorkspacePath(ctx, { path: "shared-with-me/alex/brief.md" }),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        moveWorkspacePath(ctx, {
          fromPath: "shared-with-me/alex/brief.md",
          toPath: "stolen.md",
        }),
      ).resolves.toMatchObject({ ok: false });
      expect(await readFile(join(ctx.root, "shared-with-me", "alex", "brief.md"), "utf8")).toBe(
        "the brief",
      );
    });
  });

  it("site tools refuse mounted-share roots (no running someone else's code)", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "shared-with-me", "alex", "site"), { recursive: true });
      await writeFile(
        join(ctx.root, "shared-with-me", "alex", "site", "index.html"),
        "<!doctype html><title>shared</title>",
      );
      // Case variants name the same directory on case-insensitive
      // filesystems — the guard must hold for them too, not just the
      // canonical casing.
      for (const siteRoot of ["shared-with-me/alex/site", "Shared-With-Me/alex/site"]) {
        for (const run of [
          () => testSite(ctx, { siteRoot }),
          () => buildSite(ctx, { siteRoot }),
          () => previewSite(ctx, { siteRoot }),
          () => publishSite(ctx, { siteRoot }),
          () => addSiteSdk(ctx, { siteRoot }),
        ]) {
          await expect(run()).resolves.toMatchObject({
            ok: false,
            reason: expect.stringContaining("mounted share"),
          });
        }
      }
    });
  });

  it("workspace mutations refuse a symlinked .dohc before changing visible files", async () => {
    await withWorkspace(async (ctx) => {
      const outside = await mkdtemp(join(tmpdir(), "dohc-mcp-metadata-outside-"));
      await symlink(outside, join(ctx.root, ".dohc"));

      // The refusal an agent reads is the same sentence the desktop shows a
      // user: what is at the path, what it must be, and the way out.
      const refusal =
        "dohc could not open this workspace's .dohc folder. A link is at .dohc, which must be a real folder. Remove or rename that link. Then retry.";
      await expect(
        writeWorkspaceFile(ctx, { path: "notes/new.txt", content: "nope" }),
      ).resolves.toMatchObject({ ok: false, reason: refusal });
      await expect(readFile(join(ctx.root, "notes/new.txt"), "utf8")).rejects.toThrow();

      await writeFile(join(ctx.root, "keep.txt"), "still here");
      await expect(deleteWorkspacePath(ctx, { path: "keep.txt" })).resolves.toMatchObject({
        ok: false,
        reason: refusal,
      });
      await expect(readFile(join(ctx.root, "keep.txt"), "utf8")).resolves.toBe("still here");

      await rm(outside, { recursive: true, force: true });
    });
  });

  // #613: the trash name joined a ~51-byte timestamp+uuid prefix onto an
  // untruncated basename. A 230-character name is legal on NTFS, ext4 and
  // APFS, so the file exists and the DELETE is what fails -- with "ENOENT: no
  // such file or directory, rename ...", which an agent would reasonably read
  // as a delete that did not happen.
  it("deletes a file whose legal 230-character name the prefix would overflow", async () => {
    await withWorkspace(async (ctx) => {
      const name = `${"a".repeat(226)}.txt`;
      expect(name).toHaveLength(230);
      await writeFile(join(ctx.root, name), "keep me recoverable");

      await expect(
        deleteWorkspacePath(ctx, { path: name }),
      ).resolves.toMatchObject({ ok: true, path: name, trashed: true });

      // Gone from the workspace, and recoverable from the trash under a name
      // the filesystem could actually hold.
      await expect(readFile(join(ctx.root, name), "utf8")).rejects.toThrow();
      const trashed = await readdir(join(ctx.root, ".dohc", "trash"));
      expect(trashed).toHaveLength(1);
      const entry = trashed[0]!;
      expect(entry.length).toBeLessThanOrEqual(255);
      expect(new TextEncoder().encode(entry).length).toBeLessThanOrEqual(255);
      expect(
        await readFile(join(ctx.root, ".dohc", "trash", entry), "utf8"),
      ).toBe("keep me recoverable");
    });
  });

  // The other half of #613, and the mirror of its first fix. A name the
  // filesystem WILL take must not be shortened for a limit that did not
  // apply: the trash keeps no record of the original name, so a character
  // dropped here cannot be restored. The tool asks the filesystem rather than
  // predicting, so this holds wherever the suite runs -- the same delete is a
  // single rename on a host that accepts the name whole.
  // A workspace nested deep enough that the legacy MAX_PATH budget leaves no
  // room for the ~51-character unique prefix. An earlier revision of this fix
  // refused the delete outright on that arithmetic, which took deletion away
  // from deep workspaces that had been working.
  //
  // The right answer depends on the host, so the test ASKS it rather than
  // assuming, exactly as the tool now does: where a past-MAX_PATH path can be
  // written, the delete must still happen; where it cannot, the refusal must
  // name the limit and leave the file alone.
  it("keeps deleting in a deep workspace wherever the host allows it", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-deep-"));
    try {
      const root = join(
        base,
        ...Array.from({ length: 12 }, (_, index) => `nested-folder-${index}`),
      );
      await mkdir(root, { recursive: true });
      const trashDir = join(root, ".dohc", "trash");
      // The premise: the legacy budget cannot hold the prefix.
      expect(259 - trashDir.length - 1).toBeLessThan(51);

      // Ask the host whether the legacy limit binds at all.
      const probe = join(trashDir, "p".repeat(80));
      const longPathsWork = await mkdir(trashDir, { recursive: true })
        .then(() => writeFile(probe, "probe"))
        .then(() => true)
        .catch(() => false);
      expect(probe.length).toBeGreaterThan(259);
      await rm(probe, { force: true }).catch(() => undefined);

      await writeFile(join(root, "note.md"), "still here");
      const result = await deleteWorkspacePath(
        { root, home: join(base, "home") },
        { path: "note.md" },
      );

      if (longPathsWork) {
        expect(result).toMatchObject({ ok: true, trashed: true });
        await expect(readFile(join(root, "note.md"), "utf8")).rejects.toThrow();
      } else {
        expect(refusalReason(result)).toContain("leaves no room for a trash entry name");
        expect(await readFile(join(root, "note.md"), "utf8")).toBe("still here");
      }
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });

  // The needless-truncation case, and the one that pins the ladder itself: a
  // basename that fits the per-component limit whole, inside a workspace deep
  // enough that the COMPOSED path passes the legacy MAX_PATH limit. Where the
  // host allows the long path, the name must be stored whole -- truncating it
  // would drop characters for a limit that did not apply, and the trash keeps
  // no record of the original to restore them from.
  it("does not shorten a fitting name for a composed limit the host ignores", async () => {
    const base = await mkdtemp(join(tmpdir(), "dohc-longpath-"));
    try {
      const root = join(
        base,
        ...Array.from({ length: 5 }, (_, index) => `nested-folder-${index}`),
      );
      await mkdir(root, { recursive: true });
      const trashDir = join(root, ".dohc", "trash");
      const name = `${"n".repeat(146)}.md`;
      // Fits one component with the prefix, but not the whole legacy path.
      expect(name.length + 51).toBeLessThan(255);
      expect(trashDir.length + 1 + name.length + 51).toBeGreaterThan(259);

      const probe = join(trashDir, "p".repeat(name.length + 51));
      const longPathsWork = await mkdir(trashDir, { recursive: true })
        .then(() => writeFile(probe, "probe"))
        .then(() => true)
        .catch(() => false);
      await rm(probe, { force: true }).catch(() => undefined);

      await writeFile(join(root, name), "keep me whole");
      await expect(
        deleteWorkspacePath({ root, home: join(base, "home") }, { path: name }),
      ).resolves.toMatchObject({ ok: true, trashed: true });

      const trashed = await readdir(trashDir);
      expect(trashed).toHaveLength(1);
      // Whole where the host takes it; shortened only where it will not.
      expect(trashed[0]!.endsWith(name)).toBe(longPathsWork);
      expect(
        await readFile(join(trashDir, trashed[0]!), "utf8"),
      ).toBe("keep me whole");
    } finally {
      await rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  });

  // The ladder is several renames, and nothing serializes them. A rename that
  // failed for length leaves a window in which another process can REPLACE the
  // source -- and the next rung would move the replacement into the trash and
  // report success for a file the agent never named.
  //
  // The identity check that guarded the failure path now guards each retry
  // too, against the identity captured before the FIRST attempt. A wrong
  // refusal costs a retry; a wrong success trashes the wrong file and says it
  // is done.
  it("refuses rather than trashing a file that replaced the source mid-ladder", async () => {
    await withWorkspace(async (ctx) => {
      // Long enough that the first rung cannot fit and a second is tried.
      const name = `${"a".repeat(226)}.txt`;
      await writeFile(join(ctx.root, name), "the entry the agent asked about");
      await writeFile(join(ctx.root, "replacement.md"), "a different entry entirely");
      // The race lands inside the first rename, which then fails for length.
      renameRace.path = join(ctx.root, name);
      renameRace.replaceWith = join(ctx.root, "replacement.md");
      try {
        const result = await deleteWorkspacePath(ctx, { path: name });

        expect(result).toMatchObject({ ok: false });
        expect(refusalReason(result)).toContain("something replaced it while dohc worked");
        // The point: the replacement is still where it was, NOT in the trash.
        expect(await readFile(join(ctx.root, name), "utf8")).toBe(
          "a different entry entirely",
        );
        const trashed = await readdir(join(ctx.root, ".dohc", "trash")).catch(() => []);
        expect(trashed).toEqual([]);
      } finally {
        renameRace.path = null;
        renameRace.replaceWith = null;
      }
    });
  });

  it("keeps every character of a name the filesystem accepts", async () => {
    await withWorkspace(async (ctx) => {
      // 40 CJK characters: 40 UTF-16 units, but 120 UTF-8 bytes. With the
      // ~51-character prefix that fits every platform's component limit in
      // its own unit, so nothing may be truncated anywhere.
      const name = `${"中".repeat(40)}.md`;
      await writeFile(join(ctx.root, name), "keep me whole");

      await expect(deleteWorkspacePath(ctx, { path: name })).resolves.toMatchObject({
        ok: true,
        trashed: true,
      });

      const trashed = await readdir(join(ctx.root, ".dohc", "trash"));
      expect(trashed).toHaveLength(1);
      expect(trashed[0]!.endsWith(name)).toBe(true);
      expect(
        await readFile(join(ctx.root, ".dohc", "trash", trashed[0]!), "utf8"),
      ).toBe("keep me whole");
    });
  });

  // The other raw errno this surface emitted: lstat's, naming an absolute host
  // path the agent never gave and cannot use.
  it("says nothing is there instead of handing back an lstat errno", async () => {
    await withWorkspace(async (ctx) => {
      const result = await deleteWorkspacePath(ctx, { path: "notes/gone.md" });
      expect(result).toMatchObject({
        ok: false,
        reason:
          "dohc could not delete notes/gone.md. Nothing is at that path in this workspace. List the folder to see what is there.",
      });
      expect(refusalReason(result)).not.toMatch(/ENOENT|lstat/);
      expect(refusalReason(result)).not.toContain(ctx.root);
    });
  });

  // A failing rename must say what happened AND what did not. rename is
  // atomic, so a failed one moved nothing -- and an agent that cannot tell a
  // refused delete from a silent one cannot decide what to do next. Note what
  // this does NOT say: that the file is unchanged. Two lstat readings cannot
  // establish that, so the sentence stays inside the rename contract.
  it("names the failure and says dohc moved nothing when the move fails", async () => {
    await withWorkspace(async (ctx) => {
      const uuid = "0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10";
      const now = 1785780488421;
      uuidOverride.value = uuid;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await writeFile(join(ctx.root, "note.md"), "still here");
        // A DIRECTORY sitting at the exact destination: rename refuses to
        // replace it on every platform this ships to.
        const trashDir = join(ctx.root, ".dohc", "trash");
        await mkdir(trashDir, { recursive: true });
        await mkdir(join(trashDir, `${now}-${uuid}-note.md`));

        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        // The errno code varies by platform; everything around it does not.
        expect(refusalReason(result)).toMatch(
          /^dohc could not delete note\.md\. The move to the workspace trash failed \([A-Z]+\)\. dohc did not move it\.$/,
        );
        expect(result.ok).toBe(false);
        // The claim the message makes, checked.
        expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe(
          "still here",
        );
        // And the claim it deliberately stops short of making.
        expect(refusalReason(result)).not.toContain("is unchanged");
      } finally {
        clock.mockRestore();
        uuidOverride.value = null;
      }
    });
  });

  // Only ENOENT is absence. A parent directory without search permission
  // answers EACCES about a file that is right there, and "nothing is at that
  // path" would send the agent away from a file it merely cannot reach -- the
  // same lie, pointing the other way.
  // The trash folder is prepared with mkdir + lstat, and every errno from
  // those reached the agent raw -- absolute host path and all -- while the
  // arms either side of it were being translated. A guard refusal (#585) is an
  // Error this code wrote and still passes through whole; an errno does not.
  it("translates an errno from preparing the trash folder", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "still here");
      // The trash folder specifically: .dohc itself is checked earlier, by
      // the recordability boundary, which has a refusal of its own.
      lstatOverride.path = join(ctx.root, ".dohc", "trash");
      lstatOverride.results = [errnoError("EPERM")];
      try {
        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        expect(result).toMatchObject({
          ok: false,
          reason:
            "dohc could not delete note.md. Preparing the workspace trash folder failed (EPERM). dohc did not move it.",
        });
        expect(refusalReason(result)).not.toContain(ctx.root);
      } finally {
        lstatOverride.path = null;
        lstatOverride.results = [];
      }
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("still here");
    });
  });

  it("keeps an unreachable path's own failure instead of calling it absent", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "still here");
      lstatOverride.path = join(ctx.root, "note.md");
      lstatOverride.results = [errnoError("EACCES")];
      try {
        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        expect(result).toMatchObject({
          ok: false,
          reason:
            "dohc could not delete note.md. The check on that path failed (EACCES). dohc did not move it.",
        });
        expect(refusalReason(result)).not.toContain("Nothing is at that path");
      } finally {
        lstatOverride.path = null;
        lstatOverride.results = [];
      }
      // The claim the message makes, checked.
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("still here");
    });
  });

  // "is unchanged" has to be looked at, not assumed. Nothing serializes these
  // mutations, so the desktop, another MCP call, or any local process can move
  // the path away between the check and the rename -- and then the rename
  // fails ENOENT with the source genuinely gone.
  it("does not claim the path is unchanged when the move lost a race", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "about to vanish");
      renameRace.path = join(ctx.root, "note.md");
      try {
        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        expect(result).toMatchObject({
          ok: false,
          reason:
            "dohc could not delete note.md. The move to the workspace trash failed (ENOENT). dohc did not move it. note.md is no longer in this workspace: something else moved or deleted it.",
        });
      } finally {
        renameRace.path = null;
      }
      await expect(readFile(join(ctx.root, "note.md"), "utf8")).rejects.toThrow();
    });
  });

  // A racing process can REPLACE the path rather than empty it, and then
  // something is at the name while the entry the agent asked about is gone.
  // The probe's whole remaining job is to warn about that: a retry would
  // delete the replacement.
  it("warns that a replaced path is not the entry the agent asked about", async () => {
    await withWorkspace(async (ctx) => {
      const uuid = "0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10";
      const now = 1785780488421;
      uuidOverride.value = uuid;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await writeFile(join(ctx.root, "note.md"), "the entry the agent asked about");
        await writeFile(join(ctx.root, "replacement.md"), "a different entry entirely");
        // A directory at the destination makes the rename fail; the race moves
        // a second, real file onto the source while that happens.
        const trashDir = join(ctx.root, ".dohc", "trash");
        await mkdir(trashDir, { recursive: true });
        await mkdir(join(trashDir, `${now}-${uuid}-note.md`));
        renameRace.path = join(ctx.root, "note.md");
        renameRace.replaceWith = join(ctx.root, "replacement.md");

        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        expect(refusalReason(result)).toMatch(
          /^dohc could not delete note\.md\. The move to the workspace trash failed \([A-Z]+\)\. dohc did not move it\. A different entry is at note\.md now: something replaced it while dohc worked\.$/,
        );
        // Something IS at the path -- which is exactly why presence could not
        // answer this -- and it is not what the agent asked to delete.
        expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe(
          "a different entry entirely",
        );
      } finally {
        clock.mockRestore();
        uuidOverride.value = null;
        renameRace.path = null;
        renameRace.replaceWith = null;
      }
    });
  });

  // And when the look itself fails there is no evidence to warn on, so the
  // refusal stops at the rename contract rather than guessing a claim.
  it("says it could not check, which is not the same as looking the same", async () => {
    await withWorkspace(async (ctx) => {
      const uuid = "0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10";
      const now = 1785780488421;
      uuidOverride.value = uuid;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await writeFile(join(ctx.root, "note.md"), "still here");
        const trashDir = join(ctx.root, ".dohc", "trash");
        await mkdir(trashDir, { recursive: true });
        await mkdir(join(trashDir, `${now}-${uuid}-note.md`));
        // The check passes; the look after the failed rename does not.
        lstatOverride.path = join(ctx.root, "note.md");
        lstatOverride.results = [null, errnoError("EACCES")];

        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        // "dohc could not check it" rather than silence: that dohc could not
        // look is itself provable, and it is a DIFFERENT state from "the entry
        // looks the same", which renders with no trailing sentence at all.
        expect(refusalReason(result)).toMatch(
          /^dohc could not delete note\.md\. The move to the workspace trash failed \([A-Z]+\)\. dohc did not move it\. dohc could not check note\.md afterwards\.$/,
        );
      } finally {
        clock.mockRestore();
        uuidOverride.value = null;
        lstatOverride.path = null;
        lstatOverride.results = [];
      }
    });
  });

  // A filesystem with no inode to give reports 0, and 0 is not evidence of
  // anything. Comparing it against a real inode would read as "replaced" and
  // warn about a replacement that never happened -- the warning has to rest on
  // positive evidence, in both directions.
  it("does not warn about a replacement when the filesystem reports no inode", async () => {
    await withWorkspace(async (ctx) => {
      const uuid = "0ff532fe-1e3f-4c2b-9a77-5d1e6c8b3a10";
      const now = 1785780488421;
      uuidOverride.value = uuid;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        await writeFile(join(ctx.root, "note.md"), "still here");
        const trashDir = join(ctx.root, ".dohc", "trash");
        await mkdir(trashDir, { recursive: true });
        await mkdir(join(trashDir, `${now}-${uuid}-note.md`));
        // BOTH looks, one at a time, because the guard has two sides and an
        // earlier version of this test only armed the first -- which left
        // `before.ino === 0` alone as a surviving mutant. The SECOND look is
        // the likelier zero in practice: a failed rename is often a sharing
        // violation, which is what makes libuv fall back to a directory stat
        // and report a FileId of 0.
        lstatOverride.path = join(ctx.root, "note.md");
        lstatOverride.inodes = [null, 0];

        const result = await deleteWorkspacePath(ctx, { path: "note.md" });
        expect(refusalReason(result)).toMatch(
          /^dohc could not delete note\.md\. The move to the workspace trash failed \([A-Z]+\)\. dohc did not move it\.$/,
        );
        expect(refusalReason(result)).not.toContain("replaced");
      } finally {
        clock.mockRestore();
        uuidOverride.value = null;
        lstatOverride.path = null;
        lstatOverride.inodes = [];
      }
    });
  });

  // dohc_delete_path is the tool that MOVES a user's file into .dohc/trash, so
  // a squatter there is reachable from an ordinary agent request. Every squat
  // used to reach the agent as a raw errno from mkdir (#544, #585): "EEXIST:
  // file already exists, mkdir …" names no constraint and no next step. The
  // three squat shapes below are one test because they must all answer the
  // same way -- and because a dangling link raises a DIFFERENT errno than the
  // other two, which is exactly what an errno allowlist would get wrong.
  describe("a squatted .dohc/trash", () => {
    async function deleteThrough(squat: (trash: string) => Promise<void>) {
      return await withWorkspace(async (ctx) => {
        await mkdir(join(ctx.root, ".dohc"), { recursive: true });
        await squat(join(ctx.root, ".dohc", "trash"));
        await writeFile(join(ctx.root, "keep.txt"), "still here");
        const result = await deleteWorkspacePath(ctx, { path: "keep.txt" });
        // Whatever the refusal said, the user's file never moved.
        expect(await readFile(join(ctx.root, "keep.txt"), "utf8")).toBe("still here");
        return result;
      });
    }

    it("names a FILE squatter instead of handing the agent a raw errno", async () => {
      await expect(
        deleteThrough((trash) => writeFile(trash, "squatting")),
      ).resolves.toMatchObject({
        ok: false,
        reason:
          "dohc could not move this to the workspace trash. A file is at .dohc/trash, which must be a real folder. Remove or rename that file. Then retry.",
      });
    });

    it("names a DANGLING link squatter, which an errno allowlist would miss", async () => {
      await expect(
        deleteThrough((trash) => symlink(join(trash, "..", "nowhere"), trash, "dir")),
      ).resolves.toMatchObject({
        ok: false,
        reason:
          "dohc could not move this to the workspace trash. A link is at .dohc/trash, which must be a real folder. Remove or rename that link. Then retry.",
      });
    });

    it("names a link to a real OUTSIDE folder and lands nothing there", async () => {
      const outside = await mkdtemp(join(tmpdir(), "dohc-mcp-trash-outside-"));
      try {
        await expect(
          deleteThrough((trash) => symlink(outside, trash, "dir")),
        ).resolves.toMatchObject({
          ok: false,
          reason:
            "dohc could not move this to the workspace trash. A link is at .dohc/trash, which must be a real folder. Remove or rename that link. Then retry.",
        });
        // Why the guard runs AFTER mkdir: mkdir{recursive} no-ops on an
        // existing symlink-to-dir, so a pre-check would see nothing. Drop
        // both this lstat and the containment check and keep.txt lands here.
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
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

  it("workspace_status requires the user ID in environment credentials", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx, { credentials: false });
      vi.stubEnv("DOHC_MCP_CLOUD_SERVER_URL", "http://cloud.test");
      vi.stubEnv("DOHC_MCP_CLOUD_USER_ID", "");
      try {
        expect(await workspaceStatus(ctx)).toMatchObject({
          cloudConnected: false,
          credentialStatus: "invalid",
        });

        vi.stubEnv("DOHC_MCP_CLOUD_USER_ID", "user-1");
        expect(await workspaceStatus(ctx)).toMatchObject({
          cloudConnected: true,
          credentialStatus: "available",
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("workspace_status treats a stored credential without userId as signed out", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx, { credentialUserId: null });
      expect(await workspaceStatus(ctx)).toMatchObject({
        cloudConnected: false,
        credentialStatus: "missing",
      });
    });
  });

  it("workspace_status disconnects credentials for another account on the same server", async () => {
    await withWorkspace(async (ctx) => {
      await bindCloudWorkspace(ctx, { credentialUserId: "user-2" });
      expect(await workspaceStatus(ctx)).toMatchObject({
        synced: true,
        scope: "cloud",
        cloudConnected: false,
        credentialStatus: "account-mismatch",
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

  it("reads history from engine moments only — legacy .dohc/history relics are ignored", async () => {
    await withWorkspace(async (ctx) => {
      // A pre-flip legacy change-set relic left on disk is never read: the
      // engine (moments) is the sole history source now.
      await mkdir(join(ctx.root, ".dohc", "history"), { recursive: true });
      await writeFile(
        join(ctx.root, ".dohc", "history", "relic.json"),
        JSON.stringify({ id: "relic-1", summary: "Pre-flip edit" }),
      );

      // A new MCP write records NOTHING legacy (Phase C).
      await expect(
        writeWorkspaceFile(ctx, { path: "notes/plan.txt", content: "draft\n" }),
      ).resolves.toMatchObject({ ok: true, recordedBy: "workspace-engine" });

      // Desktop main is the sole history authority. Its injected empty result
      // does not surface the relic, and an unknown id is honestly not found.
      await expect(listChanges(ctx, { includeFiles: true })).resolves.toMatchObject({
        count: 0,
        totalAvailable: 0,
      });
      await expect(readChange(ctx, { id: "relic-1" })).resolves.toMatchObject({
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
      const packageJson = JSON.parse(await readFile(join(ctx.root, "todo/package.json"), "utf8"));
      expect(packageJson.dependencies).toMatchObject({
        "@dohc/sdk": "file:vendor/dohc-sdk",
      });
      await expect(
        readFile(join(ctx.root, "todo/vendor/dohc-sdk/dist/index.js"), "utf8"),
      ).resolves.toContain("createDohcClient");
      expect(result.ok ? result.usage : "").toContain('import { dohc } from "@dohc/sdk"');
    });
  });

  it("add_sdk gives plain static sites a browser-resolvable vendored import", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "static-report"), { recursive: true });
      await writeFile(
        join(ctx.root, "static-report", "index.html"),
        "<!doctype html><h1>Report</h1>\n",
      );

      const result = await addSiteSdk(ctx, { siteRoot: "static-report" });

      expect(result).toMatchObject({
        ok: true,
        importMode: "vendored-browser-module",
      });
      expect(result.ok ? result.usage : "").toContain(
        'import { dohc } from "./vendor/dohc-sdk/dist/index.js"',
      );
      await expect(
        readFile(join(ctx.root, "static-report/vendor/dohc-sdk/dist/index.js"), "utf8"),
      ).resolves.toContain("createDohcClient");
    });
  });

  it("add_sdk treats configured sites without a bundler as browser-static", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "configured-report"), { recursive: true });
      await writeFile(
        join(ctx.root, "configured-report", "index.html"),
        "<!doctype html><h1>Configured report</h1>\n",
      );
      await writeFile(
        join(ctx.root, "configured-report", "dohc.json"),
        `${JSON.stringify({ type: "site", title: "Configured report" }, null, 2)}\n`,
      );

      const result = await addSiteSdk(ctx, { siteRoot: "configured-report" });

      expect(result).toMatchObject({
        ok: true,
        importMode: "vendored-browser-module",
      });
      expect(result.ok ? result.usage : "").toContain(
        'import { dohc } from "./vendor/dohc-sdk/dist/index.js"',
      );
    });
  });

  it("add_sdk keeps configured static-server sites on browser-resolvable imports", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "configured-server"), { recursive: true });
      await writeFile(join(ctx.root, "configured-server", "index.html"), "<h1>Report</h1>\n");
      await writeFile(
        join(ctx.root, "configured-server", "dohc.json"),
        `${JSON.stringify({
          type: "site",
          title: "Configured server",
          preview: { mode: "static", command: "python -m http.server" },
        })}\n`,
      );

      const result = await addSiteSdk(ctx, { siteRoot: "configured-server" });

      expect(result).toMatchObject({ ok: true, importMode: "vendored-browser-module" });
      expect(result.ok ? result.usage : "").toContain(
        'import { dohc } from "./vendor/dohc-sdk/dist/index.js"',
      );
    });
  });

  it("add_sdk keeps explicit dependency ranges browser-resolvable for static sites", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "static-explicit"), { recursive: true });
      await writeFile(join(ctx.root, "static-explicit", "index.html"), "<h1>Static</h1>\n");

      const result = await addSiteSdk(
        { ...ctx, sdkDependencyRange: "^9.4.0" },
        { siteRoot: "static-explicit" },
      );

      expect(result).toMatchObject({ ok: true, importMode: "vendored-browser-module" });
      expect(result.ok ? result.usage : "").toContain(
        'import { dohc } from "./vendor/dohc-sdk/dist/index.js"',
      );
      const packageJson = JSON.parse(
        await readFile(join(ctx.root, "static-explicit/package.json"), "utf8"),
      );
      expect(packageJson.dependencies).toMatchObject({ "@dohc/sdk": "^9.4.0" });
      await expect(
        readFile(join(ctx.root, "static-explicit/vendor/dohc-sdk/dist/index.js"), "utf8"),
      ).resolves.toContain("createDohcClient");
    });
  });

  it("add_sdk fails cleanly when a static site has no vendorable SDK source", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "static-no-source"), { recursive: true });
      await writeFile(join(ctx.root, "static-no-source", "index.html"), "<h1>Static</h1>\n");

      const result = await addSiteSdk(
        { ...ctx, sdkPackageJsonPath: undefined, sdkDependencyRange: "^9.4.0" },
        { siteRoot: "static-no-source" },
      );

      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("browser-resolvable import"),
      });
      await expect(stat(join(ctx.root, "static-no-source/package.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it.each(["missing", "unreadable"] as const)(
    "add_sdk reports %s bundled SDK browser files without throwing",
    async (fixture) => {
      await withWorkspace(async (ctx) => {
        const sdkDir = join(ctx.home, `sdk-${fixture}`);
        await mkdir(join(sdkDir, "dist"), { recursive: true });
        await writeFile(join(sdkDir, "package.json"), '{"version":"1.0.0"}\n');
        await writeFile(join(sdkDir, "dist/index.d.ts"), "export {};\n");
        if (fixture === "unreadable") {
          await mkdir(join(sdkDir, "dist/index.js"));
        }
        await mkdir(join(ctx.root, "static-report"), { recursive: true });
        await writeFile(join(ctx.root, "static-report/index.html"), "<h1>Report</h1>\n");

        await expect(
          addSiteSdk(
            { ...ctx, sdkPackageJsonPath: join(sdkDir, "package.json") },
            { siteRoot: "static-report" },
          ),
        ).resolves.toMatchObject({
          ok: false,
          reason: expect.stringMatching(/bundled @dohc\/sdk browser files|ENOENT|EISDIR/i),
        });
        await expect(
          stat(join(ctx.root, "static-report/vendor/dohc-sdk")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("add_sdk refreshes the SDK dependency range when package metadata changes", async () => {
    await withWorkspace(async (ctx) => {
      const sdkDir = join(ctx.home, "sdk-package");
      const sdkPackageJsonPath = join(sdkDir, "package.json");
      await mkdir(join(sdkDir, "dist"), { recursive: true });
      await writeFile(join(sdkDir, "dist/index.js"), "export const version = 'test';\n");
      await writeFile(join(sdkDir, "dist/index.d.ts"), "export declare const version: string;\n");
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
      expect(packageJson.dependencies).toMatchObject({
        "@dohc/sdk": "file:vendor/dohc-sdk",
      });
      const vendoredPackage = JSON.parse(
        await readFile(join(ctx.root, "todo/vendor/dohc-sdk/package.json"), "utf8"),
      );
      expect(vendoredPackage.version).toBe("2.0.0");
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


// AUDIT-OPTOUT: MCP resolves the settings file through the SAME schema the
// desktop uses (@dohc/workspace-contracts/workspace-settings). A file that
// exists but cannot be trusted may hold the opt-out, so it resolves OFF in
// both readers. A mutating tool that named a recorder there would tell the
// agent something false.
describe("workspace engine flag", () => {
  const settingsPath = (root: string) => join(root, ".dohc", "settings.local.json");
  const validSettings = (workspaceEngineAlpha: boolean) =>
    JSON.stringify({
      ...DEFAULT_WORKSPACE_SETTINGS,
      experimental: { workspaceEngineAlpha },
    });

  it("reads an absent file as on and an explicit opt-out as off", async () => {
    await withWorkspace(async (ctx) => {
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(true);

      await mkdir(join(ctx.root, ".dohc"), { recursive: true });
      await writeFile(settingsPath(ctx.root), validSettings(true));
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(true);

      await writeFile(settingsPath(ctx.root), validSettings(false));
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
      await expect(
        writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" }),
      ).resolves.toMatchObject({ ok: true, historyRecording: "off" });
    });
  });

  // Every one of these reads OFF in the desktop reader. A hand-mirrored rule
  // answered ON for the schema-invalid bodies, which is why both readers now
  // share one schema.
  it("reads every unparseable and schema-invalid body as opted out", async () => {
    const bodies = [
      "{not json",
      JSON.stringify({ version: 2 }),
      JSON.stringify({ experimental: { workspaceEngineAlpha: "false" } }),
      JSON.stringify({}),
      JSON.stringify([]),
      JSON.stringify(null),
    ];
    for (const body of bodies) {
      await withWorkspace(async (ctx) => {
        await mkdir(join(ctx.root, ".dohc"), { recursive: true });
        await writeFile(settingsPath(ctx.root), body);
        await expect(isWorkspaceEngineFlagged(ctx), body).resolves.toBe(false);
      });
    }
  });

  it("reads a non-regular, symlinked, or oversized settings file as opted out", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(settingsPath(ctx.root), { recursive: true });
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
      await rm(settingsPath(ctx.root), { recursive: true });

      const outside = join(ctx.home, "settings.local.json");
      await writeFile(outside, validSettings(true));
      await symlink(outside, settingsPath(ctx.root));
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
      await rm(settingsPath(ctx.root));

      await writeFile(
        settingsPath(ctx.root),
        JSON.stringify({
          ...JSON.parse(validSettings(true)),
          padding: "x".repeat(256 * 1024),
        }),
      );
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
    });
  });

  it("reads a settings file that escapes the workspace as opted out", async () => {
    await withWorkspace(async (ctx) => {
      const outside = join(ctx.home, "dohc-meta");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "settings.local.json"), validSettings(true));
      await symlink(outside, join(ctx.root, ".dohc"), "dir");

      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
    });
  });
});

// Every mutating tool checks .dohc is a real folder BEFORE it touches a
// visible file, and refuses without changing anything when it is not. One
// pre-existing test covered that, through a symlinked .dohc, for two of the
// eight tools; these cover all eight.
//
// The refusal needs no seam and no symlink privilege: a REGULAR FILE at
// <root>/.dohc makes ensureGuardedDir's post-mkdir check refuse on every
// platform, so this runs everywhere the gate does rather than only where
// symlink creation is permitted.
describe("a refused recordability boundary leaves the filesystem alone", () => {
  async function withBlockedMetadataDir<T>(
    fn: (ctx: ToolContext) => Promise<T>,
  ): Promise<T> {
    return withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, ".dohc"), "not a directory");
      return fn(ctx);
    });
  }

  // Every case below asserts THIS reason, so a tool refusing for some other
  // reason cannot pass as evidence that the boundary held.
  const BLOCKED =
    "dohc could not open this workspace's .dohc folder. A file is at .dohc, which must be a real folder. Remove or rename that file. Then retry.";

  // Delete is the one case with a second boundary behind this one:
  // safeTrashDir checks .dohc again on its way to the trash folder, so
  // removing the change-record boundary alone still leaves this passing. The
  // other seven fail without it.
  it("refuses the delete, and the file is still where it was", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "still here");

      expect(await deleteWorkspacePath(ctx, { path: "note.md" })).toMatchObject({ ok: false, reason: BLOCKED });
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("still here");
    });
  });

  it("refuses the write, and no file appears", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      expect(
        await writeWorkspaceFile(ctx, { path: "notes/new.md", content: "written" }),
      ).toMatchObject({ ok: false, reason: BLOCKED });
      await expect(stat(join(ctx.root, "notes", "new.md"))).rejects.toThrow();
    });
  });

  it("refuses an overwrite, and the existing bytes are untouched", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "original");

      expect(
        await writeWorkspaceFile(ctx, { path: "note.md", content: "replacement" }),
      ).toMatchObject({ ok: false, reason: BLOCKED });
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("original");
    });
  });

  it("refuses the site, and no site root appears", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      expect(await createSite(ctx, { path: "sites/landing" })).toMatchObject({ ok: false, reason: BLOCKED });
      await expect(stat(join(ctx.root, "sites", "landing"))).rejects.toThrow();
    });
  });

  it("refuses the move, and both paths are where they were", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "still here");

      expect(
        await moveWorkspacePath(ctx, { fromPath: "note.md", toPath: "notes/moved.md" }),
      ).toMatchObject({ ok: false, reason: BLOCKED });
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("still here");
      await expect(stat(join(ctx.root, "notes", "moved.md"))).rejects.toThrow();
    });
  });

  it("refuses the directory, and no directory appears", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      expect(await createWorkspaceDirectory(ctx, { path: "notes/2026" })).toMatchObject({ ok: false, reason: BLOCKED });
      await expect(stat(join(ctx.root, "notes", "2026"))).rejects.toThrow();
    });
  });

  it("refuses the import, and no database appears", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      await writeFile(join(ctx.root, "people.csv"), "id,name\n1,Ada\n");

      expect(
        await importData(ctx, {
          sourcePath: "people.csv",
          databasePath: "people.sqlite",
          tableName: "people",
        }),
      ).toMatchObject({ ok: false, reason: BLOCKED });
      await expect(stat(join(ctx.root, "people.sqlite"))).rejects.toThrow();
    });
  });

  it("refuses the sdk add, and package.json is untouched", async () => {
    await withBlockedMetadataDir(async (ctx) => {
      await mkdir(join(ctx.root, "sites", "landing"), { recursive: true });
      await writeFile(join(ctx.root, "sites", "landing", "index.html"), "<h1>hi</h1>");

      expect(await addSiteSdk(ctx, { siteRoot: "sites/landing" })).toMatchObject({ ok: false, reason: BLOCKED });
      await expect(
        stat(join(ctx.root, "sites", "landing", "package.json")),
      ).rejects.toThrow();
    });
  });
});

// #638. The reserved rule used to read the path as SPELLED, and containment
// was proved only INTO the root -- never OUT of .dohc. So an in-workspace
// symlink named anything but `.dohc` carried every mutating tool straight into
// the workspace's control plane: the probe on the issue wrote
// `experimental.workspaceEngineAlpha: false` through one, and a delete through
// the same alias moved the settings file to trash, silently dropping the
// workspace's engine opt-out.
//
// Every case below is decided on the RESOLVED path, which is what makes the
// spelling irrelevant. Revert safeResolve to the lexical check alone and each
// one fails.
describe("a symlink cannot alias a reserved area", () => {
  const settingsPath = (root: string) => join(root, ".dohc", "settings.local.json");
  const OPTED_OUT = JSON.stringify({
    ...DEFAULT_WORKSPACE_SETTINGS,
    experimental: { workspaceEngineAlpha: false },
  });

  // A workspace holding a real `.dohc` with an engine opt-out in it, plus
  // `meta -> .dohc`: an ordinary-looking folder whose real path is reserved.
  async function withDohcAlias<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
    return withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, ".dohc"), { recursive: true });
      await writeFile(settingsPath(ctx.root), OPTED_OUT);
      await symlink(join(ctx.root, ".dohc"), join(ctx.root, "meta"), "dir");
      return fn(ctx);
    });
  }

  // The refusal has to name the constraint an agent hit, and the resolved
  // WORKSPACE-RELATIVE path is what names it -- an absolute host path would
  // say where the workspace lives, which no agent asked for.
  function expectsReservedRefusal(reason: string) {
    expect(reason).toMatch(/reserved/i);
    expect(reason).toContain(".dohc");
    expect(reason).not.toContain(tmpdir());
  }

  it("refuses safeResolve for a path whose real target is inside .dohc", async () => {
    await withDohcAlias(async (ctx) => {
      for (const path of ["meta", "meta/settings.local.json", "meta/trash/x.md"]) {
        const resolved = await safeResolve(ctx, path);
        expect(resolved.ok, path).toBe(false);
        expectsReservedRefusal(refusalReason(resolved));
      }
    });
  });

  it("refuses the write, and the engine opt-out still reads off", async () => {
    await withDohcAlias(async (ctx) => {
      const written = await writeWorkspaceFile(ctx, {
        path: "meta/settings.local.json",
        content: JSON.stringify({
          ...DEFAULT_WORKSPACE_SETTINGS,
          experimental: { workspaceEngineAlpha: true },
        }),
      });
      expect(written.ok).toBe(false);
      expectsReservedRefusal(refusalReason(written));

      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
    });
  });

  it("refuses the delete, and the settings file is still where it was", async () => {
    await withDohcAlias(async (ctx) => {
      const deleted = await deleteWorkspacePath(ctx, { path: "meta/settings.local.json" });
      expect(deleted.ok).toBe(false);
      expectsReservedRefusal(refusalReason(deleted));

      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
      await expect(isWorkspaceEngineFlagged(ctx)).resolves.toBe(false);
    });
  });

  it("refuses a move whose source or destination resolves into .dohc", async () => {
    await withDohcAlias(async (ctx) => {
      await writeFile(join(ctx.root, "note.md"), "visible");

      const out = await moveWorkspacePath(ctx, {
        fromPath: "meta/settings.local.json",
        toPath: "stolen.json",
      });
      expect(out.ok).toBe(false);
      expectsReservedRefusal(refusalReason(out));

      const into = await moveWorkspacePath(ctx, {
        fromPath: "note.md",
        toPath: "meta/note.md",
      });
      expect(into.ok).toBe(false);
      expectsReservedRefusal(refusalReason(into));

      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
      expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("visible");
      await expect(stat(join(ctx.root, "stolen.json"))).rejects.toThrow();
    });
  });

  it("refuses the directory, and no directory appears inside .dohc", async () => {
    await withDohcAlias(async (ctx) => {
      const made = await createWorkspaceDirectory(ctx, { path: "meta/sneaky" });
      expect(made.ok).toBe(false);
      expectsReservedRefusal(refusalReason(made));
      await expect(stat(join(ctx.root, ".dohc", "sneaky"))).rejects.toThrow();
    });
  });

  it("refuses the read, so .dohc stays unreadable under any spelling", async () => {
    await withDohcAlias(async (ctx) => {
      const read = await readWorkspaceFile(ctx, { path: "meta/settings.local.json" });
      expect(read.ok).toBe(false);
      expectsReservedRefusal(refusalReason(read));
    });
  });

  // shared-with-me is a WRITE reservation: mount refresh owns it, agents read
  // it. An alias must inherit exactly that split, not more and not less.
  it("refuses a write through an alias of shared-with-me but still reads it", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "shared-with-me", "acme"), { recursive: true });
      await writeFile(join(ctx.root, "shared-with-me", "acme", "plan.md"), "theirs");
      await symlink(join(ctx.root, "shared-with-me"), join(ctx.root, "inbox"), "dir");

      const written = await writeWorkspaceFile(ctx, {
        path: "inbox/acme/plan.md",
        content: "mine",
      });
      expect(written.ok).toBe(false);
      expect(refusalReason(written)).toMatch(/reserved/i);
      expect(await readFile(join(ctx.root, "shared-with-me", "acme", "plan.md"), "utf8")).toBe(
        "theirs",
      );

      await expect(
        readWorkspaceFile(ctx, { path: "inbox/acme/plan.md" }),
      ).resolves.toMatchObject({ ok: true, content: "theirs" });
    });
  });

  // Site tools EXECUTE the site. shared-with-me is readable, so safeResolve
  // lets an alias of it through on purpose — which means the "do not run
  // someone else's shared code" gate is the one that has to read the resolved
  // path. Judged on the spelling, `mine -> shared-with-me/alex` runs it.
  it("refuses to run a site whose real root is a mounted share", async () => {
    await withWorkspace(async (ctx) => {
      const shared = join(ctx.root, "shared-with-me", "alex", "landing");
      await mkdir(shared, { recursive: true });
      await writeFile(join(shared, "index.html"), "<h1>theirs</h1>");
      await writeFile(
        join(shared, "package.json"),
        JSON.stringify({ name: "landing", scripts: { build: "echo pwned" } }),
      );
      await symlink(join(ctx.root, "shared-with-me", "alex"), join(ctx.root, "mine"), "dir");

      // These tools return wide unions, so the refusal is read positionally:
      // a result without `reason` did not refuse, which is the failure.
      for (const result of [
        await buildSite(ctx, { siteRoot: "mine/landing" }),
        await testSite(ctx, { siteRoot: "mine/landing" }),
        await addSiteSdk(ctx, { siteRoot: "mine/landing" }),
      ]) {
        expect(result.ok).toBe(false);
        expect("reason" in result ? result.reason : "no refusal").toMatch(/mounted share/i);
      }
    });
  });

  // A DANGLING alias is the ordering trap. With no `.dohc` on disk yet,
  // realpath fails for the alias itself, so a walk that treats every
  // unresolvable component as "not there yet" reports an ordinary path. Then
  // the mutator calls ensureRecordable, which CREATES `.dohc` -- the alias
  // goes live between the check and the operation, and the operation follows
  // it in. A component that exists cannot be absent, so lstat decides this,
  // not realpath.
  describe("through an alias that is still dangling", () => {
    async function withDanglingAlias<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
      return withWorkspace(async (ctx) => {
        // Deliberately NOT created: the alias points at a `.dohc` that does
        // not exist until a mutator makes it.
        await symlink(join(ctx.root, ".dohc"), join(ctx.root, "meta"), "dir");
        await expect(stat(join(ctx.root, ".dohc"))).rejects.toThrow();
        return fn(ctx);
      });
    }

    it("refuses the directory, and nothing appears inside .dohc", async () => {
      await withDanglingAlias(async (ctx) => {
        const made = await createWorkspaceDirectory(ctx, { path: "meta/sneaky" });
        expect(made.ok).toBe(false);
        await expect(stat(join(ctx.root, ".dohc", "sneaky"))).rejects.toThrow();
      });
    });

    it("refuses the move, and nothing lands inside .dohc", async () => {
      await withDanglingAlias(async (ctx) => {
        await writeFile(join(ctx.root, "note.md"), "visible");

        const moved = await moveWorkspacePath(ctx, {
          fromPath: "note.md",
          toPath: "meta/note.md",
        });
        expect(moved.ok).toBe(false);
        await expect(stat(join(ctx.root, ".dohc", "note.md"))).rejects.toThrow();
        expect(await readFile(join(ctx.root, "note.md"), "utf8")).toBe("visible");
      });
    });

    it("refuses the write, and no file appears inside .dohc", async () => {
      await withDanglingAlias(async (ctx) => {
        const written = await writeWorkspaceFile(ctx, {
          path: "meta/settings.local.json",
          content: OPTED_OUT,
        });
        expect(written.ok).toBe(false);
        await expect(stat(join(ctx.root, ".dohc", "settings.local.json"))).rejects.toThrow();
      });
    });
  });

  // The refusal must name the rule that ACTUALLY rejected the path. An alias
  // into .git is refused by the ignored-area rule, and a message claiming
  // dohc reserves ".dohc and shared-with-me" would send an agent looking for
  // a reservation that had nothing to do with it.
  it("names the ignored area it hit, not the .dohc reservation", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, ".git", "refs"), { recursive: true });
      await symlink(join(ctx.root, ".git"), join(ctx.root, "history"), "dir");

      const reason = refusalReason(await safeResolve(ctx, "history/config"));
      expect(reason).toContain(".git");
      expect(reason).not.toContain("shared-with-me");
    });
  });

  // The guard is about WHERE a path lands, not about symlinks being suspect.
  // An in-workspace symlink to an ordinary folder must keep working, or the
  // fix has traded one wrong answer for another.
  it("still writes, reads and deletes through a symlink to an ordinary folder", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "notes"), { recursive: true });
      await symlink(join(ctx.root, "notes"), join(ctx.root, "shortcut"), "dir");

      await expect(
        writeWorkspaceFile(ctx, { path: "shortcut/day.md", content: "hello\n" }),
      ).resolves.toMatchObject({ ok: true });
      expect(await readFile(join(ctx.root, "notes", "day.md"), "utf8")).toBe("hello\n");

      await expect(
        readWorkspaceFile(ctx, { path: "shortcut/day.md" }),
      ).resolves.toMatchObject({ ok: true, content: "hello\n" });

      await expect(
        deleteWorkspacePath(ctx, { path: "shortcut/day.md" }),
      ).resolves.toMatchObject({ ok: true });
      await expect(stat(join(ctx.root, "notes", "day.md"))).rejects.toThrow();
    });
  });
});
