import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceDirectory,
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
  readHistoryRecording,
  type ToolContext,
} from "./tools";
import {
  DOHC_METADATA_GUARD,
  entryCharBudget,
  nameUnitFor,
  notARealFolderRefusal,
  trashEntryPlan,
} from "@dohc/workspace-core";
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
// Without it the path is simply removed. `failWith` names an errno code the
// mock throws INSTEAD of calling the real rename -- for a failure a real
// filesystem will not reproduce on demand, such as a length rejection whose
// exact errno depends on what the host decides to say. The ladder then sees a
// rename that moved nothing, exactly as the real failure it stands in for
// would leave it. Each armed entry is a one-shot: `path` is nulled the moment
// it matches, which is also how a test proves the race actually ran.
const renameRace = vi.hoisted(() => ({
  path: null as string | null,
  replaceWith: null as string | null,
  failWith: null as string | null,
}));
// realpath can fail where the lstat just before it succeeded: a permission
// change, or another process moving the path in the gap between the two calls.
// Neither is arrangeable as a real filesystem state on this host, and both must
// report a check that did not finish rather than an escape that was never
// established. The armed path fails every call until it is disarmed.
const realpathOverride = vi.hoisted(() => ({
  path: null as string | null,
  error: null as NodeJS.ErrnoException | null,
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
    realpath: async (path: Parameters<typeof actual.realpath>[0]) => {
      if (realpathOverride.path === String(path) && realpathOverride.error) {
        throw realpathOverride.error;
      }
      return actual.realpath(path);
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (renameRace.path === String(from)) {
        const replaceWith = renameRace.replaceWith;
        const failWith = renameRace.failWith;
        renameRace.path = null;
        renameRace.replaceWith = null;
        renameRace.failWith = null;
        if (replaceWith) await actual.rename(replaceWith, from);
        else await actual.rm(from);
        if (failWith) throw errnoError(failWith);
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
      // Long enough that the plan below must yield more than one rung; the
      // errno thrown when the race fires, below, is synthetic and stands in
      // for whatever a real over-long rename would report, not a prediction
      // of what this name's length does on its own.
      const name = `${"a".repeat(226)}.txt`;
      // Precondition, not assumption: rung > 0 is what runs the retry loop,
      // and the identity guard inside it is the thing this test is for.
      const plan = trashEntryPlan(name, `${Date.now()}-${randomUUID()}-`, {
        unit: nameUnitFor(process.platform),
        maxEntryChars: entryCharBudget(join(ctx.root, ".dohc", "trash"), process.platform),
      });
      expect(plan.candidates.length).toBeGreaterThan(1);
      await writeFile(join(ctx.root, name), "the entry the agent asked about");
      await writeFile(join(ctx.root, "replacement.md"), "a different entry entirely");
      renameRace.path = join(ctx.root, name);
      renameRace.replaceWith = join(ctx.root, "replacement.md");
      renameRace.failWith = "ENAMETOOLONG";
      try {
        const result = await deleteWorkspacePath(ctx, { path: name });

        // The mock nulls renameRace.path the moment the one-shot fires; null
        // here proves the race actually ran instead of the ladder simply
        // succeeding against the untouched real file.
        expect(renameRace.path).toBeNull();
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
        renameRace.failWith = null;
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

  it("detect_sites rejects a dohc.json that parses to a non-object, mirroring workspace-core's code", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "not-an-object"), { recursive: true });
      await writeFile(join(ctx.root, "not-an-object/dohc.json"), "[]");
      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true, count: 1 });
      if (!result.ok) return;
      // A genuinely valid dohc.json ({"type":"site"}) reads kind "configured"
      // and confidence "high" here (see the "finds configured, package, and
      // static sites" test above); an array parses without throwing, so
      // without the shape check this folder would misclassify the same way.
      // kind stays "configured" (dohc.json is present, matching
      // workspace-core's own siteKind rule) but confidence must not.
      expect(result.sites[0]).toMatchObject({
        root: "not-an-object",
        kind: "configured",
        confidence: "low",
        diagnostics: [
          expect.objectContaining({
            code: "invalid-config",
            severity: "error",
            message: "dohc.json must contain a JSON object.",
          }),
        ],
      });
    });
  });

  it("detect_sites rejects a package.json that parses to a non-object, mirroring workspace-core's code", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "pkg-not-an-object"), { recursive: true });
      // An index.html gives the folder an independent site signal so a
      // rejected package.json still surfaces as a site with a diagnostic,
      // instead of vanishing from detect_sites entirely (package.json alone
      // carries no site signal of its own once it fails the shape check).
      await writeFile(join(ctx.root, "pkg-not-an-object/index.html"), "<h1>Static</h1>");
      await writeFile(join(ctx.root, "pkg-not-an-object/package.json"), "[]");
      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true, count: 1 });
      if (!result.ok) return;
      // A silently-accepted array pkg would look like an empty, valid
      // package.json (no scripts, no dependencies, no diagnostic at all) and
      // would never explain why no package signal was picked up.
      expect(result.sites[0]).toMatchObject({
        root: "pkg-not-an-object",
        kind: "static",
        scripts: {},
        diagnostics: [
          expect.objectContaining({
            code: "invalid-package-json",
            severity: "error",
            message: "package.json must contain a JSON object.",
          }),
        ],
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

  it("detect_sites ignores a non-site dohc.json whose only signal is a configured build.output PATH, not a real build", async () => {
    await withWorkspace(async (ctx) => {
      // Claims a build output at "dist", but nothing was ever actually
      // built there — matches workspace-core's hasIndependentWebsiteSignal:
      // an explicitly non-site config's own build.output claim can't be the
      // independent signal that overrides its own type declaration.
      await mkdir(join(ctx.root, "workflow-claims-build"), { recursive: true });
      await writeFile(
        join(ctx.root, "workflow-claims-build/dohc.json"),
        JSON.stringify({ type: "workflow", build: { output: "dist" } }),
      );
      // A sibling with the SAME non-site type but a REAL build artifact on
      // disk (an actual dist/index.html, not just an empty dist/) still
      // counts, proving the detected-vs-configured distinction (not a
      // blanket refusal of every build.output claim).
      await mkdir(join(ctx.root, "workflow-real-build/dist"), { recursive: true });
      await writeFile(join(ctx.root, "workflow-real-build/dist/index.html"), "<h1>Built</h1>");
      await writeFile(
        join(ctx.root, "workflow-real-build/dohc.json"),
        JSON.stringify({ type: "workflow" }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const roots = result.sites.map((site) => site.root);
      // The recursive walk also finds "workflow-real-build/dist" as its
      // own bare-index.html site — real, unrelated to this fixture's own
      // point (a claimed-but-unbuilt output vs. a real one at the SAME
      // root), so this only asserts what that point actually is.
      expect(roots).toContain("workflow-real-build");
      expect(roots).not.toContain("workflow-claims-build");
    });
  });

  it("detect_sites drops an unsafe configured build.output (traversal) with the same diagnostic workspace-core would emit", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "site-unsafe-output"), { recursive: true });
      await writeFile(join(ctx.root, "site-unsafe-output/index.html"), "<h1>Site</h1>");
      await writeFile(
        join(ctx.root, "site-unsafe-output/dohc.json"),
        JSON.stringify({ type: "site", build: { output: "../../outside" } }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const site = result.sites.find((candidate) => candidate.root === "site-unsafe-output");
      expect(site?.buildOutputs).toEqual([]);
      expect(site?.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid-build-output" }),
      );
    });
  });

  it("detect_sites does not count a bare, empty build-output directory as a detected build", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "workflow-empty-dist/dist"), { recursive: true });
      await writeFile(
        join(ctx.root, "workflow-empty-dist/dohc.json"),
        JSON.stringify({ type: "workflow" }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      // No index.html inside dist/, no other website signal, and an
      // explicit non-site type — workspace-core would refuse this
      // candidate for the same reason.
      expect(result.sites.map((site) => site.root)).not.toContain("workflow-empty-dist");
    });
  });

  it("detect_sites does not treat a directory literally named index.html as a build artifact", async () => {
    await withWorkspace(async (ctx) => {
      // A directory, not a file, named index.html inside dist/ — stat()
      // alone is truthy for both; only isFile() tells them apart.
      await mkdir(join(ctx.root, "workflow-dir-index/dist/index.html"), { recursive: true });
      await writeFile(
        join(ctx.root, "workflow-dir-index/dohc.json"),
        JSON.stringify({ type: "workflow" }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.sites.map((site) => site.root)).not.toContain("workflow-dir-index");
    });
  });

  it("detect_sites requires a real web dependency or web-tool script token, not just any script", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "non-web-package"), { recursive: true });
      await writeFile(
        join(ctx.root, "non-web-package/package.json"),
        JSON.stringify({ name: "non-web-package", scripts: { build: "tsc" } }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.sites.map((site) => site.root)).not.toContain("non-web-package");
    });
  });

  it("detect_sites keeps a malformed dohc.json type visible with a diagnostic instead of silently dropping it", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "malformed-type"), { recursive: true });
      await writeFile(
        join(ctx.root, "malformed-type/dohc.json"),
        JSON.stringify({ type: 42 }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const site = result.sites.find((candidate) => candidate.root === "malformed-type");
      expect(site).toBeDefined();
      expect(site?.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid-type" }),
      );
    });
  });

  it("detect_sites honors a configured preview.entry over the bare index.html fallback", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "docs/public"), { recursive: true });
      await writeFile(join(ctx.root, "docs/index.html"), "<h1>Fallback</h1>");
      await writeFile(join(ctx.root, "docs/public/index.html"), "<h1>Configured entry</h1>");
      await writeFile(
        join(ctx.root, "docs/dohc.json"),
        JSON.stringify({ type: "site", preview: { mode: "static", entry: "public/index.html" } }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const site = result.sites.find((candidate) => candidate.root === "docs");
      expect(site).toMatchObject({
        root: "docs",
        entry: "docs/public/index.html",
        configuredPreviewMode: "static",
      });

      await expect(testSite(ctx, { siteRoot: "docs" })).resolves.toMatchObject({
        ok: true,
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "entry-file", ok: true, path: "docs/public/index.html" }),
        ]),
      });

      await expect(previewSite(ctx, { siteRoot: "docs" })).resolves.toMatchObject({
        ok: true,
        modes: expect.arrayContaining([
          expect.objectContaining({ mode: "static", entry: "docs/public/index.html" }),
        ]),
      });
    });
  });

  it("detect_sites reports an invalid configured preview.entry and falls back to index.html", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "escape"), { recursive: true });
      await writeFile(join(ctx.root, "escape/index.html"), "<h1>Fallback</h1>");
      await writeFile(
        join(ctx.root, "escape/dohc.json"),
        JSON.stringify({ type: "site", preview: { entry: "../outside/index.html" } }),
      );

      const result = await detectSites(ctx);
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      const site = result.sites.find((candidate) => candidate.root === "escape");
      expect(site).toMatchObject({
        root: "escape",
        entry: "escape/index.html",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "invalid-preview-entry", severity: "warning" }),
        ]),
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


// The agent named a workspace, not a host. A message carrying an absolute
// host path states a fact the agent never supplied and cannot act on, so
// every translated report below is checked for one.
function expectWorkspaceRelative(text: string, ctx: ToolContext): void {
  expect(text, "the workspace root reached the agent").not.toContain(ctx.root);
  expect(text, "the host home reached the agent").not.toContain(ctx.home);
  expect(text, "a Windows drive path reached the agent").not.toMatch(/[A-Za-z]:[\\/]/);
  expect(text, "a POSIX absolute path reached the agent").not.toMatch(/(^|\s)\/\w/);
}

// AUDIT-OPTOUT: MCP resolves the settings file through the SAME schema the
// desktop uses (@dohc/workspace-contracts/workspace-settings).
//
// #641: a file that exists but cannot be trusted resolves UNKNOWN, not OFF.
// Both fail closed, so neither names a recorder — but OFF says the user chose
// this, and a read that failed established no such thing. The desktop split
// these in #483 and #505; this suite holds MCP to the same split.
describe("workspace engine flag", () => {
  const settingsPath = (root: string) => join(root, ".dohc", "settings.local.json");
  const validSettings = (workspaceEngineAlpha: boolean) =>
    JSON.stringify({
      ...DEFAULT_WORKSPACE_SETTINGS,
      experimental: { workspaceEngineAlpha },
    });

  it("reads an absent file as on and an explicit opt-out as off", async () => {
    await withWorkspace(async (ctx) => {
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "on" });

      await mkdir(join(ctx.root, ".dohc"), { recursive: true });
      await writeFile(settingsPath(ctx.root), validSettings(true));
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "on" });

      await writeFile(settingsPath(ctx.root), validSettings(false));
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "off" });
      await expect(
        writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" }),
      ).resolves.toMatchObject({ ok: true, historyRecording: "off" });
    });
  });

  // A hand-mirrored rule once answered ON for the schema-invalid bodies, which
  // is why both readers share one schema. The schema's verdict is three-valued
  // now: a body it rejects may hold an opt-out dohc cannot read, and saying so
  // is not the same as saying the opt-out is there.
  it("reads every unparseable and schema-invalid body as could-not-determine", async () => {
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
        const read = await readHistoryRecording(ctx);
        expect(read.state, body).toBe("unknown");
        if (read.state !== "unknown") throw new Error("unreachable");
        expect(read.cause, body).toContain(".dohc/settings.local.json");
        expectWorkspaceRelative(read.cause, ctx);
      });
    }
  });

  it("reads a non-regular, symlinked, or oversized settings file as could-not-determine", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(settingsPath(ctx.root), { recursive: true });
      await expect(readHistoryRecording(ctx)).resolves.toMatchObject({
        state: "unknown",
        cause: expect.stringContaining("A folder is at that path"),
      });
      await rm(settingsPath(ctx.root), { recursive: true });

      const outside = join(ctx.home, "settings.local.json");
      await writeFile(outside, validSettings(true));
      await symlink(outside, settingsPath(ctx.root));
      await expect(readHistoryRecording(ctx)).resolves.toMatchObject({
        state: "unknown",
        cause: expect.stringContaining("A link is at that path"),
      });
      await rm(settingsPath(ctx.root));

      await writeFile(
        settingsPath(ctx.root),
        JSON.stringify({
          ...JSON.parse(validSettings(true)),
          padding: "x".repeat(256 * 1024),
        }),
      );
      // The limit that rejected the read, with its unit and the observed size.
      await expect(readHistoryRecording(ctx)).resolves.toMatchObject({
        state: "unknown",
        cause: expect.stringContaining("the limit is 262144 bytes"),
      });
    });
  });

  it("reads a settings file that escapes the workspace as could-not-determine", async () => {
    await withWorkspace(async (ctx) => {
      const outside = join(ctx.home, "dohc-meta");
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "settings.local.json"), validSettings(true));
      await symlink(outside, join(ctx.root, ".dohc"), "dir");

      await expect(readHistoryRecording(ctx)).resolves.toMatchObject({
        state: "unknown",
        cause: expect.stringContaining("leads outside this workspace"),
      });
    });
  });

  // Only ONE resolver failure is an escape. The others are checks that did not
  // finish, and calling them an escape tells an agent to remove a settings file
  // over a fact dohc never established -- this PR's own defect, one layer down.
  // Consume the resolver's boolean instead of its reason and both cases here
  // report the escape wording, so both fail.
  describe("a resolver failure that is not an escape", () => {
    const armRealpathErrno = (path: string, code: string) => {
      realpathOverride.path = path;
      realpathOverride.error = errnoError(code);
    };
    const disarm = () => {
      realpathOverride.path = null;
      realpathOverride.error = null;
    };

    it("reports an unreadable path as a check that failed, not as an escape", async () => {
      await withWorkspace(async (ctx) => {
        await mkdir(join(ctx.root, ".dohc"), { recursive: true });
        await writeFile(settingsPath(ctx.root), validSettings(true));
        armRealpathErrno(settingsPath(ctx.root), "EACCES");
        try {
          const read = await readHistoryRecording(ctx);
          expect(read.state).toBe("unknown");
          if (read.state !== "unknown") throw new Error("unreachable");
          expect(read.cause).toContain("could not check where that path leads (EACCES)");
          // The claim never established.
          expect(read.cause).not.toContain("leads outside this workspace");
          expectWorkspaceRelative(read.cause, ctx);
        } finally {
          disarm();
        }
      });
    });

    it("reports an unreadable workspace folder as the folder's failure, not this file's", async () => {
      await withWorkspace(async (ctx) => {
        await mkdir(join(ctx.root, ".dohc"), { recursive: true });
        await writeFile(settingsPath(ctx.root), validSettings(true));
        armRealpathErrno(ctx.root, "EACCES");
        try {
          const read = await readHistoryRecording(ctx);
          expect(read.state).toBe("unknown");
          if (read.state !== "unknown") throw new Error("unreachable");
          expect(read.cause).toContain("could not resolve the workspace folder (EACCES)");
          expect(read.cause).not.toContain("leads outside this workspace");
          expectWorkspaceRelative(read.cause, ctx);
        } finally {
          disarm();
        }
      });
    });
  });

  // #641, the whole point: what the AGENT reads. A settings file dohc cannot
  // trust used to report `historyRecording: "off"` -- the opt-out's copy, on
  // no evidence. Revert the fix and this fails: the report becomes "off".
  it("reports an unreadable settings file as unknown, never as the opt-out", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(settingsPath(ctx.root), { recursive: true });

      const written = await writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" });
      expect(written).toMatchObject({ ok: true, historyRecording: "unknown" });
      if (!written.ok || !("historyRecordingUnavailable" in written)) {
        throw new Error("expected the unknown arm to carry its cause");
      }
      // The state, the file, and the way out -- not a claim about a choice.
      expect(written.historyRecordingUnavailable).toContain(
        "dohc could not tell whether this workspace records history",
      );
      expect(written.historyRecordingUnavailable).toContain(".dohc/settings.local.json");
      expect(written.historyRecordingUnavailable).toContain("Then retry.");
      expectWorkspaceRelative(written.historyRecordingUnavailable, ctx);

      // The write itself still happened, and the opt-out's word is nowhere.
      expect(await readFile(join(ctx.root, "notes.md"), "utf8")).toBe("draft\n");
      expect(JSON.stringify(written)).not.toContain('"off"');
    });
  });
});

// #642: safeMetadataDir prepares .dohc with mkdir + lstat, and every errno
// from those used to reach the agent whole -- `EPERM: operation not
// permitted, lstat 'C:\Users\...\ws\.dohc'`. Seven mutating tools refuse
// through this one catch, so all seven said it.
//
// A guard refusal is an Error this code wrote and carries no errno, so it
// still passes through whole; only a platform failure is translated. The two
// are told apart by the code, not by the message.
describe("a metadata-folder failure reaches the agent translated", () => {
  const armMetadataErrno = (ctx: ToolContext, code: string) => {
    lstatOverride.path = join(ctx.root, ".dohc");
    lstatOverride.results = [errnoError(code)];
  };
  const disarm = () => {
    lstatOverride.path = null;
    lstatOverride.results = [];
  };

  it("names the folder and the way out instead of passing the errno through", async () => {
    await withWorkspace(async (ctx) => {
      armMetadataErrno(ctx, "EPERM");
      try {
        const result = await writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" });
        expect(result).toMatchObject({
          ok: false,
          reason:
            "dohc could not open this workspace's .dohc folder. Preparing that folder failed (EPERM). dohc changed no files." +
            " Check that dohc can read and write .dohc in this workspace. Then retry.",
        });
        expectWorkspaceRelative(refusalReason(result), ctx);
      } finally {
        disarm();
      }
      // The claim the message makes, checked.
      await expect(readFile(join(ctx.root, "notes.md"), "utf8")).rejects.toThrow();
    });
  });

  // AGENTS.md: a backpressure error must name the saturated resource and how to
  // retry or degrade. A full disk is not a permission problem, and the
  // permission instruction sends an agent to widen access that was never the
  // obstacle. Drop the capacity branch and every code below borrows that
  // instruction again, so each case here fails.
  it("names the resource that ran out instead of the permission instruction", async () => {
    const instructions = new Map([
      ["ENOSPC", "The disk holding this workspace is full. Free disk space."],
      ["EDQUOT", "The disk quota for this workspace is used up. Free space, or raise the quota."],
      ["EMFILE", "dohc holds too many open files. Restart dohc."],
      ["ENFILE", "This computer holds too many open files. Close other apps."],
    ]);
    for (const [code, instruction] of instructions) {
      await withWorkspace(async (ctx) => {
        armMetadataErrno(ctx, code);
        try {
          const result = await writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" });
          const reason = refusalReason(result);
          expect(reason, code).toContain(`(${code})`);
          expect(reason, code).toContain(instruction);
          // The permission instruction belongs to a permission failure.
          expect(reason, code).not.toContain("Check that dohc can read and write");
          expectWorkspaceRelative(reason, ctx);
        } finally {
          disarm();
        }
        // The claim the message makes, checked.
        await expect(readFile(join(ctx.root, "notes.md"), "utf8")).rejects.toThrow();
      });
    }
  });

  it("passes a guard refusal through whole", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, ".dohc"), "not a directory");
      const result = await writeWorkspaceFile(ctx, { path: "notes.md", content: "draft\n" });
      expect(result).toMatchObject({
        ok: false,
        reason: notARealFolderRefusal(DOHC_METADATA_GUARD, {
          isSymbolicLink: () => false,
          isFile: () => true,
        }),
      });
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
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "off" });
    });
  });

  it("refuses the delete, and the settings file is still where it was", async () => {
    await withDohcAlias(async (ctx) => {
      const deleted = await deleteWorkspacePath(ctx, { path: "meta/settings.local.json" });
      expect(deleted.ok).toBe(false);
      expectsReservedRefusal(refusalReason(deleted));

      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "off" });
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

  // Reading or writing THROUGH the alias is the attack; removing the alias is
  // the cleanup, and refusing that left an agent unable to undo the very thing
  // the guard is warning about. A rename moves the link and never opens it.
  it("deletes the alias itself, and .dohc keeps every byte", async () => {
    await withDohcAlias(async (ctx) => {
      await expect(deleteWorkspacePath(ctx, { path: "meta" })).resolves.toMatchObject({
        ok: true,
        trashed: true,
      });
      await expect(lstat(join(ctx.root, "meta"))).rejects.toThrow();
      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
      await expect(readHistoryRecording(ctx)).resolves.toEqual({ state: "off" });
    });
  });

  it("renames the alias, and it is still only an alias", async () => {
    await withDohcAlias(async (ctx) => {
      await expect(
        moveWorkspacePath(ctx, { fromPath: "meta", toPath: "old-meta" }),
      ).resolves.toMatchObject({ ok: true });
      await expect(lstat(join(ctx.root, "meta"))).rejects.toThrow();
      expect((await lstat(join(ctx.root, "old-meta"))).isSymbolicLink()).toBe(true);
      // Moving it does not launder it: the new spelling reads .dohc too.
      expectsReservedRefusal(
        refusalReason(await readWorkspaceFile(ctx, { path: "old-meta/settings.local.json" })),
      );
      expect(await readFile(settingsPath(ctx.root), "utf8")).toBe(OPTED_OUT);
    });
  });

  // The entry is the object for an ordinary link too -- deleting a shortcut
  // must not delete what it points at.
  it("deletes a live link to an ordinary folder without touching the folder", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, "notes"), { recursive: true });
      await writeFile(join(ctx.root, "notes", "day.md"), "kept\n");
      await symlink(join(ctx.root, "notes"), join(ctx.root, "shortcut"), "dir");

      await expect(deleteWorkspacePath(ctx, { path: "shortcut" })).resolves.toMatchObject({
        ok: true,
      });
      await expect(lstat(join(ctx.root, "shortcut"))).rejects.toThrow();
      expect(await readFile(join(ctx.root, "notes", "day.md"), "utf8")).toBe("kept\n");
    });
  });

  // Holding back the final name does not skip the reserved rule: the parent
  // still resolves, and the rule reads that real path plus this name.
  it("still refuses deleting a live link that sits inside an aliased .dohc", async () => {
    await withDohcAlias(async (ctx) => {
      await mkdir(join(ctx.root, "notes"), { recursive: true });
      await symlink(join(ctx.root, "notes"), join(ctx.root, ".dohc", "inner"), "dir");

      const deleted = await deleteWorkspacePath(ctx, { path: "meta/inner" });
      expectsReservedRefusal(refusalReason(deleted));
      expect((await lstat(join(ctx.root, ".dohc", "inner"))).isSymbolicLink()).toBe(true);
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
        expect(refusalReason(made)).toMatch(/no target|reserved/i);
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
        expect(refusalReason(moved)).toMatch(/no target|reserved/i);
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
        expect(refusalReason(written)).toMatch(/no target|reserved/i);
        await expect(stat(join(ctx.root, ".dohc", "settings.local.json"))).rejects.toThrow();
      });
    });

    // Refusing every path with a broken link on it takes away the one
    // operation that FIXES a broken link. Delete and a move's source rename
    // the entry, so the alias is the object here, not a route into `.dohc`.
    it("deletes the broken link itself, and .dohc survives it", async () => {
      await withDanglingAlias(async (ctx) => {
        await expect(deleteWorkspacePath(ctx, { path: "meta" })).resolves.toMatchObject({
          ok: true,
          trashed: true,
        });
        // The link entry is gone. `.dohc` exists only because the delete's own
        // ensureRecordable made it -- which is the check-then-create window the
        // refusal guards, and renaming the entry closes it without following.
        await expect(lstat(join(ctx.root, "meta"))).rejects.toThrow();
        expect((await stat(join(ctx.root, ".dohc"))).isDirectory()).toBe(true);
      });
    });

    it("renames the broken link, and it is still a broken link", async () => {
      await withDanglingAlias(async (ctx) => {
        await expect(
          moveWorkspacePath(ctx, { fromPath: "meta", toPath: "broken" }),
        ).resolves.toMatchObject({ ok: true });
        await expect(lstat(join(ctx.root, "meta"))).rejects.toThrow();
        expect((await lstat(join(ctx.root, "broken"))).isSymbolicLink()).toBe(true);
        expect((await stat(join(ctx.root, ".dohc"))).isDirectory()).toBe(true);
      });
    });

    // The relaxation is the LAST component only. A broken link partway along a
    // path is still a route, and where it leads is still unknown.
    it("still refuses a delete THROUGH the broken link", async () => {
      await withDanglingAlias(async (ctx) => {
        const deleted = await deleteWorkspacePath(ctx, { path: "meta/settings.local.json" });
        expect(refusalReason(deleted)).toMatch(/no target/i);
      });
    });

    // Climbing past the link does not skip the reserved re-decision: the
    // parent's REAL path plus this name is what the rule reads.
    it("still refuses deleting a broken link that really sits inside .dohc", async () => {
      await withWorkspace(async (ctx) => {
        await mkdir(join(ctx.root, ".dohc"), { recursive: true });
        await symlink(join(ctx.root, ".dohc", "absent"), join(ctx.root, ".dohc", "broken"), "dir");
        await symlink(join(ctx.root, ".dohc"), join(ctx.root, "alias"), "dir");

        const deleted = await deleteWorkspacePath(ctx, { path: "alias/broken" });
        expect(refusalReason(deleted)).toMatch(/reserved/i);
        expect((await lstat(join(ctx.root, ".dohc", "broken"))).isSymbolicLink()).toBe(true);
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

// #638 on the surfaces next door. safeResolve hands every tool BOTH spellings
// of a path; a guard that decides authority has to read the resolved one. Each
// case here passes its guard on the name the agent asked for, and the guard is
// the last thing standing between the alias and the bytes behind it.
describe("a guard that decides authority reads the resolved path", () => {
  const marker = "MCP_ALIAS_LEAK_31";

  async function importedDatabase(ctx: ToolContext, path: string): Promise<Buffer> {
    await writeFile(join(ctx.root, "people.csv"), `id,name\n1,${marker}\n`);
    const imported = await importData(ctx, {
      sourcePath: "people.csv",
      databasePath: path,
      tableName: "people",
    });
    expect(imported).toMatchObject({ ok: true });
    return readFile(join(ctx.root, path));
  }

  it("refuses an import whose source really is a secret file", async () => {
    await withWorkspace(async (ctx) => {
      await writeFile(join(ctx.root, ".env.csv"), `k,v\nAPI_KEY,${marker}\n`);
      await symlink(join(ctx.root, ".env.csv"), join(ctx.root, "data.csv"));

      const imported = await importData(ctx, {
        sourcePath: "data.csv",
        databasePath: "people.sqlite",
        tableName: "people",
      });
      expect(imported).toMatchObject({ ok: false, reason: expect.stringContaining("protected") });
      expect(JSON.stringify(imported)).not.toContain(marker);
      // An import republishes what it reads, so the denial has to leave no
      // database behind either.
      await expect(stat(join(ctx.root, "people.sqlite"))).rejects.toThrow();
    });
  });

  it("refuses a query whose database really is a secret file", async () => {
    await withWorkspace(async (ctx) => {
      const bytes = await importedDatabase(ctx, "people.sqlite");
      await writeFile(join(ctx.root, ".env.sqlite"), bytes);
      await symlink(join(ctx.root, ".env.sqlite"), join(ctx.root, "records.sqlite"));

      const queried = await queryDatabase(ctx, {
        databasePath: "records.sqlite",
        sql: "SELECT name FROM people",
      });
      expect(queried).toMatchObject({ ok: false, reason: expect.stringContaining("protected") });
      expect(JSON.stringify(queried)).not.toContain(marker);
    });
  });

  // The visible-database rule is read off the NAME, so an alias carries its
  // own: a sidecar is transient and never a standalone file, and an alias that
  // spells `.sqlite` must not turn one into a queryable database.
  it("refuses a query whose database really is a sidecar", async () => {
    await withWorkspace(async (ctx) => {
      const bytes = await importedDatabase(ctx, "people.sqlite");
      await writeFile(join(ctx.root, "people.sqlite-wal"), bytes);
      await symlink(join(ctx.root, "people.sqlite-wal"), join(ctx.root, "records.sqlite"));

      const queried = await queryDatabase(ctx, {
        databasePath: "records.sqlite",
        sql: "SELECT name FROM people",
      });
      expect(queried).toMatchObject({
        ok: false,
        reason: expect.stringContaining("not a visible database"),
      });
      expect(JSON.stringify(queried)).not.toContain(marker);
    });
  });

  it("refuses a site scan whose folder really is the legacy one", async () => {
    await withWorkspace(async (ctx) => {
      const legacy = join(ctx.root, LEGACY_APPS_SEGMENT, "portal");
      await mkdir(legacy, { recursive: true });
      await writeFile(join(legacy, "index.html"), "<h1>legacy</h1>");
      await symlink(join(ctx.root, LEGACY_APPS_SEGMENT), join(ctx.root, "shortcut"), "dir");

      const scanned = await detectSites(ctx, { path: "shortcut/portal" });
      expect(scanned).toMatchObject({
        ok: false,
        reason: expect.stringContaining(LEGACY_APPS_SEGMENT),
      });
    });
  });

  it("refuses to create a site whose folder really is the legacy one", async () => {
    await withWorkspace(async (ctx) => {
      await mkdir(join(ctx.root, LEGACY_APPS_SEGMENT), { recursive: true });
      await symlink(join(ctx.root, LEGACY_APPS_SEGMENT), join(ctx.root, "shortcut"), "dir");

      const created = await createSite(ctx, { path: "shortcut/fresh" });
      expect(created).toMatchObject({
        ok: false,
        reason: expect.stringContaining(LEGACY_APPS_SEGMENT),
      });
      await expect(stat(join(ctx.root, LEGACY_APPS_SEGMENT, "fresh"))).rejects.toThrow();
    });
  });

  // Climbing past a component realpath cannot resolve is safe only when
  // NOTHING is there. A permission error answers neither question, and reading
  // it as absence appends the component as spelling -- which is the exact
  // input the reserved rule must never decide on.
  it("refuses a path whose presence the filesystem would not report", async () => {
    await withWorkspace(async (ctx) => {
      // Dangling on purpose: realpath stops at `meta`, so lstat is what says
      // whether anything is there, and here lstat cannot say.
      await symlink(join(ctx.root, ".dohc"), join(ctx.root, "meta"), "dir");
      lstatOverride.path = join(ctx.root, "meta");
      lstatOverride.results = [errnoError("EACCES")];
      try {
        const resolved = await safeResolve(ctx, "meta/sneaky");
        expect(resolved.ok).toBe(false);
        const reason = refusalReason(resolved);
        expect(reason).toContain("EACCES");
        expect(reason).toMatch(/could not check/i);
      } finally {
        lstatOverride.path = null;
        lstatOverride.results = [];
      }
    });
  });

  // The workspace folder can go missing or unmount under a running server.
  // Every path in it then fails on the ROOT, and reporting that as a symlink
  // escaping the workspace sends an agent to audit a path that is fine.
  it("names the workspace root, not the path, when the root will not resolve", async () => {
    await withWorkspace(async (ctx) => {
      const gone = { ...ctx, root: join(ctx.root, "gone") };
      const reason = refusalReason(await safeResolve(gone, "note.md"));
      expect(reason).toContain("ENOENT");
      expect(reason).toMatch(/workspace root/i);
      expect(reason).not.toMatch(/escapes workspace/i);
    });
  });

  // A filesystem root is the one path realpath returns WITH its separator, so
  // a workspace opened at one would compare against `C:\\` or `//` and refuse
  // every path inside itself as an escape.
  it("resolves inside a workspace whose root is the filesystem root", async () => {
    await withWorkspace(async (ctx) => {
      const fsRoot = parse(ctx.root).root;
      const resolved = await safeResolve(
        { ...ctx, root: fsRoot },
        relative(fsRoot, ctx.root).split(sep).join("/"),
      );
      expect(resolved).toMatchObject({
        ok: true,
        realRelative: relative(fsRoot, ctx.root).split(sep).join("/"),
      });
    });
  });

  // A cycle and a missing target both stop realpath, and they owe different
  // next steps: the missing target can be created, the cycle cannot.
  it("tells a symlink cycle apart from a symlink with no target", async () => {
    await withWorkspace(async (ctx) => {
      await symlink(join(ctx.root, "pong"), join(ctx.root, "ping"), "dir");
      await symlink(join(ctx.root, "ping"), join(ctx.root, "pong"), "dir");
      await symlink(join(ctx.root, "absent"), join(ctx.root, "alias"), "dir");

      const cycle = refusalReason(await safeResolve(ctx, "ping"));
      expect(cycle).toContain("ELOOP");
      expect(cycle).not.toMatch(/create the target/i);

      expect(refusalReason(await safeResolve(ctx, "alias"))).toMatch(/create the target/i);
    });
  });

  // Same cleanup gap as the dangling link, one errno over: a link that leads
  // in a circle can only be removed, and refusing every path that touches one
  // refuses the removal too. A rename moves the entry without asking where it
  // points, so a cycle at the END of the path is the thing being deleted.
  describe("through a link that leads in a circle", () => {
    async function withCycle<T>(fn: (ctx: ToolContext) => Promise<T>): Promise<T> {
      return withWorkspace(async (ctx) => {
        await symlink(join(ctx.root, "pong"), join(ctx.root, "ping"), "dir");
        await symlink(join(ctx.root, "ping"), join(ctx.root, "pong"), "dir");
        return fn(ctx);
      });
    }

    it("deletes the looping link, and the other half stays behind", async () => {
      await withCycle(async (ctx) => {
        await expect(deleteWorkspacePath(ctx, { path: "ping" })).resolves.toMatchObject({
          ok: true,
          trashed: true,
        });
        await expect(lstat(join(ctx.root, "ping"))).rejects.toThrow();
        // Broken, not chased: pong is still a link, and now leads nowhere.
        expect((await lstat(join(ctx.root, "pong"))).isSymbolicLink()).toBe(true);
        await expect(stat(join(ctx.root, "pong"))).rejects.toThrow();
      });
    });

    it("renames the looping link, and it is still a link", async () => {
      await withCycle(async (ctx) => {
        await expect(
          moveWorkspacePath(ctx, { fromPath: "ping", toPath: "loop" }),
        ).resolves.toMatchObject({ ok: true });
        await expect(lstat(join(ctx.root, "ping"))).rejects.toThrow();
        expect((await lstat(join(ctx.root, "loop"))).isSymbolicLink()).toBe(true);
      });
    });

    // Only the FINAL name is held back. The cycle is a parent here, so it is
    // still a route to somewhere unknown and still has to be resolved.
    it("still refuses a delete THROUGH the looping link", async () => {
      await withCycle(async (ctx) => {
        const deleted = await deleteWorkspacePath(ctx, { path: "ping/note.md" });
        const reason = refusalReason(deleted);
        expect(reason).toContain("ELOOP");
        expect(reason).toMatch(/cannot be resolved/i);
      });
    });
  });
});
