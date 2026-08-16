import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import {
  routeWorkspaceFileCreate,
  routeWorkspaceFileImport,
  routeWorkspaceFolderCreate,
  routeWorkspacePathDelete,
  routeWorkspacePathMove,
} from "./workspaceFileOps";

// WHERE create, rename, delete and import land, and the refusal that comes
// before any of them decides (#802).
//
// The engine-backed half of these seams needs a real daemon and lives in
// `shareViewFileOps.e2e.test.ts`. What is here is the part that must be
// answered BEFORE a store is opened at all: a share view that takes no local
// writes is refused at every one of the four seams, and refused early enough
// that nothing is resolved, opened, or written on the way to saying so.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-file-ops-"));
  roots.push(root);
  return root;
}

// A store nobody may resolve. Reaching it is the failure this proves absent:
// a refusal that opened the store first would have already paid for the
// decision it then refuses.
function forbiddenStore(): () => CaptureVersionedTextStore {
  return () => {
    throw new Error("the share-view store must not be resolved for a refused operation");
  };
}

const GRANTER = "granter@dohc.test";
const READ_ONLY = `This shared view is read-only for you. Ask ${GRANTER} for changes.`;

const refusedLevels = [
  ["view", { access: "view" as ShareAccess, ended: false, granterEmail: GRANTER }],
  ["comment", { access: "comment" as ShareAccess, ended: false, granterEmail: GRANTER }],
  [
    "a grant this process cannot read",
    { access: null, ended: false, granterEmail: GRANTER },
  ],
  [
    "an ended edit share",
    { access: "edit" as ShareAccess, ended: true, granterEmail: GRANTER },
  ],
] as const;

describe("share-view file operations, at every level that takes no local writes", () => {
  for (const [label, shareView] of refusedLevels) {
    it(`refuses create, rename, delete and import at ${label}, before it opens anything`, async () => {
      const rootPath = await scratch();
      await mkdir(join(rootPath, "docs"), { recursive: true });
      await writeFile(join(rootPath, "docs", "note.md"), "granter\n", "utf8");
      const source = join(await scratch(), "outside.md");
      await writeFile(source, "outside\n", "utf8");
      const scope = {
        workspaceId: "ws-1",
        rootPath,
        shareView,
        shareViewStore: forbiddenStore(),
      };

      await expect(
        routeWorkspaceFileCreate({ ...scope, relativePath: "docs/new.md", initialText: "" }),
        `MUTATION: dropping the level branch lets ${label} create a file in a share view`,
      ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
      await expect(
        routeWorkspacePathMove({
          ...scope,
          fromPath: "docs/note.md",
          toPath: "docs/renamed.md",
        }),
        `MUTATION: dropping the level branch lets ${label} rename a file in a share view`,
      ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
      await expect(
        routeWorkspacePathDelete({
          ...scope,
          relativePath: "docs/note.md",
          trashItem: async () => {
            throw new Error("a refused delete must not reach the trash");
          },
        }),
        `MUTATION: dropping the level branch lets ${label} delete a file in a share view`,
      ).rejects.toBeInstanceOf(SharedFileReadOnlyError);
      await expect(
        routeWorkspaceFileImport({
          ...scope,
          absolutePaths: [source],
          screenAgainstRoots: null,
          targetDir: "docs",
        }),
        `MUTATION: dropping the level branch lets ${label} import into a share view`,
      ).rejects.toBeInstanceOf(SharedFileReadOnlyError);

      // And the folder is untouched: a share view's folder is a projection,
      // and a refused operation must not have written it on the way.
      expect(await readdir(join(rootPath, "docs"))).toEqual(["note.md"]);
      await expect(readFile(join(rootPath, "docs", "note.md"), "utf8")).resolves.toBe(
        "granter\n",
      );
    });
  }

  // The same string at every refused level, so a refusal never tells the
  // recipient which level they hold — and that string states what to do next,
  // which naming the granter is: a person who cannot change a file needs to
  // know who can.
  it("refuses view and comment with the same message, and it names the next step", async () => {
    const rootPath = await scratch();
    const messages = await Promise.all(
      (["view", "comment"] as const).map(async (access) =>
        routeWorkspaceFileCreate({
          workspaceId: "ws-1",
          rootPath,
          relativePath: "new.md",
          initialText: "",
          shareView: { access, ended: false, granterEmail: GRANTER },
          shareViewStore: forbiddenStore(),
        }).then(
          () => "no refusal",
          (error: unknown) => (error as Error).message,
        ),
      ),
    );
    // The EXACT string on both, not merely the same string: two refusals that
    // both said "no refusal", or both said nothing useful, would satisfy an
    // equality check and state nothing.
    expect(
      messages[0],
      "MUTATION: a refusal with no next step leaves the reader nowhere to go",
    ).toBe(READ_ONLY);
    expect(
      messages[1],
      "MUTATION: a level-specific refusal fingerprints the level",
    ).toBe(READ_ONLY);
  });

  // A folder is refused at EVERY level, including edit, because the engine has
  // no folder object for a moment to describe. Only the sentence changes.
  it("refuses a folder in a share view at every level", async () => {
    const rootPath = await scratch();
    const folderScope = (shareView: {
      access: ShareAccess | null;
      ended: boolean;
      granterEmail: string | null;
    }) => ({ rootPath, relativePath: "plans", shareView });

    for (const [label, shareView] of refusedLevels) {
      await expect(
        routeWorkspaceFolderCreate(folderScope(shareView)),
        `MUTATION: a share view at ${label} makes a folder no moment can describe`,
      ).rejects.toThrow(READ_ONLY);
    }
    await expect(
      routeWorkspaceFolderCreate(
        folderScope({ access: "edit", ended: false, granterEmail: GRANTER }),
      ),
      "MUTATION: routing create-folder at edit level makes a folder nothing can send",
    ).rejects.toThrow(
      "A shared view can't hold an empty folder. Make a file in the folder you want.",
    );
    expect(await readdir(rootPath)).toEqual([]);
  });

  it("makes a folder in an ordinary workspace", async () => {
    const rootPath = await scratch();
    await expect(
      routeWorkspaceFolderCreate({ rootPath, relativePath: "plans", shareView: null }),
    ).resolves.toBe("plans");
    expect(await readdir(rootPath)).toEqual(["plans"]);
  });
});

describe("ordinary workspace file operations, unchanged", () => {
  it("creates, renames, deletes and imports on disk, and never opens a share store", async () => {
    const rootPath = await scratch();
    const sourceDir = await scratch();
    const source = join(sourceDir, "imported.md");
    await writeFile(source, "outside\n", "utf8");
    const scope = {
      workspaceId: "ws-1",
      rootPath,
      shareView: null,
      shareViewStore: forbiddenStore(),
    };

    await expect(
      routeWorkspaceFileCreate({ ...scope, relativePath: "note.md", initialText: "hello\n" }),
    ).resolves.toBe("note.md");
    await expect(readFile(join(rootPath, "note.md"), "utf8")).resolves.toBe("hello\n");

    await expect(
      routeWorkspacePathMove({ ...scope, fromPath: "note.md", toPath: "renamed.md" }),
    ).resolves.toBe("renamed.md");
    await expect(readFile(join(rootPath, "renamed.md"), "utf8")).resolves.toBe("hello\n");

    await expect(
      routeWorkspaceFileImport({
        ...scope,
        absolutePaths: [source],
        screenAgainstRoots: null,
        targetDir: undefined,
      }),
    ).resolves.toEqual({ imported: ["imported.md"], skipped: 0 });

    let trashed: string | null = null;
    await expect(
      routeWorkspacePathDelete({
        ...scope,
        relativePath: "renamed.md",
        trashItem: async (absolutePath) => {
          trashed = absolutePath;
          await rm(absolutePath);
        },
      }),
      "MUTATION: routing an ordinary workspace's delete to the engine skips the trash it is recoverable from",
    ).resolves.toEqual({ trashed: true });
    expect(trashed).toBe(join(rootPath, "renamed.md"));
  });

  it("screens an OS drag-in before it copies, and counts what it refused", async () => {
    const rootPath = await scratch();
    const sourceDir = await scratch();
    const file = join(sourceDir, "dropped.md");
    await writeFile(file, "dropped\n", "utf8");
    const directory = join(sourceDir, "folder");
    await mkdir(directory);

    await expect(
      routeWorkspaceFileImport({
        workspaceId: "ws-1",
        rootPath,
        absolutePaths: [file, directory],
        screenAgainstRoots: [rootPath],
        targetDir: undefined,
        shareView: null,
        shareViewStore: forbiddenStore(),
      }),
      "MUTATION: an unscreened drag-in copies a directory the screen refuses",
    ).resolves.toEqual({ imported: ["dropped.md"], skipped: 1 });
  });
});
