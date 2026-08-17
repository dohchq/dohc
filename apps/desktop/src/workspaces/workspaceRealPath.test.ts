import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectZipEntries, createFile, createFolder, deletePath, movePath } from "./workspaceFiles";
import {
  createWorkspaceTextExclusive,
  resolveWorkspaceFile,
  restoreWorkspaceText,
} from "./workspaceAssets";
import { importToDatabase } from "./workspaceDatabase";
import { createDefaultDiskWriter } from "./workspaceEngineCapture";
import { materializeSharedViewPaths } from "./sharedView";
import { startStaticDirectoryPreview } from "../security/staticDirectoryPreview";
import { createTestScratch } from "./testTemp";

// ONE fact, tested per surface: every desktop guard used to read a path as
// SPELLED and then prove only that it stays INSIDE the workspace root. A
// symlink planted inside the workspace passes that proof, so `meta -> .dohc`
// named the workspace's own control plane under an ordinary name and every
// surface below followed it (#667).
//
// Each test here plants that alias, drives the real entry point, and asserts
// BOTH the refusal and the disk. Reverting the resolved-path decision at any
// one site turns exactly one of these red.
//
// MUTATION NOTE: pass `access: "read"` where a site passes "write", or drop the
// `assertResolvedWorkspacePath` call from a site, and that site's test fails on
// the disk assertion, not only on the message.

let root: string;

const SETTINGS = '{"engine":"on"}';

beforeEach(async () => {
  root = await createTestScratch("dohc-real-path-");
  await mkdir(join(root, ".dohc"), { recursive: true });
  await mkdir(join(root, "notes"), { recursive: true });
  await writeFile(join(root, ".dohc", "settings.json"), SETTINGS);
  // The whole attack in one line: an ordinary name for the reserved folder.
  await symlink(join(root, ".dohc"), join(root, "meta"), "dir");
});

const rejectingTrash = async () => {
  throw new Error("g_file_trash: no trash directory");
};

describe("workspaceFiles through an in-workspace alias", () => {
  it("createFile refuses a write that lands in .dohc", async () => {
    await expect(createFile(root, "meta/evil.md", "")).rejects.toThrow(
      /File path leads to a reserved area: meta\/evil\.md leads to \.dohc\/evil\.md/,
    );
    expect(existsSync(join(root, ".dohc", "evil.md"))).toBe(false);
  });

  it("createFolder refuses a mkdir that lands in .dohc", async () => {
    await expect(createFolder(root, "meta/evil")).rejects.toThrow(/reserved area/);
    expect(existsSync(join(root, ".dohc", "evil"))).toBe(false);
  });

  it("movePath refuses a move INTO .dohc", async () => {
    await writeFile(join(root, "notes", "plan.md"), "plan");
    await expect(movePath(root, "notes/plan.md", "meta/plan.md")).rejects.toThrow(
      /Move destination leads to a reserved area/,
    );
    expect(existsSync(join(root, ".dohc", "plan.md"))).toBe(false);
    expect(existsSync(join(root, "notes", "plan.md"))).toBe(true);
  });

  it("movePath refuses a move OUT of .dohc into the visible tree", async () => {
    // The leak the containment check can never see: both ends are inside the
    // root, and the destination is an ordinary, syncable, exportable path.
    await expect(movePath(root, "meta/settings.json", "leak.json")).rejects.toThrow(
      /Move source leads to a reserved area/,
    );
    expect(existsSync(join(root, "leak.json"))).toBe(false);
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
  });

  it("deletePath refuses to trash workspace state", async () => {
    await expect(deletePath(root, "meta/settings.json", rejectingTrash)).rejects.toThrow(
      /Delete path leads to a reserved area/,
    );
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
  });

  it("collectZipEntries refuses to export .dohc through the alias", async () => {
    await expect(collectZipEntries(root, "meta")).rejects.toThrow(
      /Export path leads to a reserved area/,
    );
  });

  it("collectZipEntries refuses to export a secret an ordinary name points at", async () => {
    // The floor is decided on BOTH spellings: the archive would carry the
    // secret's bytes under the link's innocent name.
    await writeFile(join(root, ".env"), "TOKEN=hunter2");
    await symlink(join(root, ".env"), join(root, "notes.md"));
    await expect(collectZipEntries(root, "notes.md")).rejects.toThrow(
      /Secret files never leave the workspace/,
    );
  });

  // Both ends of a move are entries, so both keep the name as SPELLED under a
  // resolved parent. Resolving the destination instead would answer with the
  // existing file's casing on a case-insensitive filesystem, and the rename
  // would become a no-op that silently loses the user's capitalization.
  it("renames through a benign alias without losing the destination spelling", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    await writeFile(join(root, "notes", "readme.md"), "body");
    expect(await movePath(root, "inbox/readme.md", "inbox/plan.md")).toBe("inbox/plan.md");
    expect(await readFile(join(root, "notes", "plan.md"), "utf8")).toBe("body");
    expect(existsSync(join(root, "notes", "readme.md"))).toBe(false);
  });

  it("keeps a benign alias to an ordinary folder working", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    expect(await createFile(root, "inbox/today.md", "")).toBe("inbox/today.md");
    expect(existsSync(join(root, "notes", "today.md"))).toBe(true);
  });

  it("refuses a write that lands in the shared-with-me projection", async () => {
    await mkdir(join(root, "shared-with-me", "alex"), { recursive: true });
    await symlink(join(root, "shared-with-me"), join(root, "mine"), "dir");
    await expect(createFile(root, "mine/alex/note.md", "")).rejects.toThrow(
      /File path leads to a reserved area/,
    );
    expect(existsSync(join(root, "shared-with-me", "alex", "note.md"))).toBe(false);
  });
});

describe("workspaceAssets through an in-workspace alias", () => {
  it("resolveWorkspaceFile refuses a read that lands in .dohc", async () => {
    await expect(resolveWorkspaceFile(root, "meta/settings.json", "read")).rejects.toThrow(
      /Asset path leads to a reserved area/,
    );
  });

  it("restoreWorkspaceText refuses a write that lands in .dohc", async () => {
    await expect(restoreWorkspaceText(root, "meta/settings.json", "clobbered")).rejects.toThrow(
      /Restore path leads to a reserved area/,
    );
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
  });

  // A restore commits with rename over the entry, so it never writes THROUGH
  // the leaf. Following it would refuse the very file the restore repairs.
  //
  // MUTATION NOTE: give writeContainedFile "write" access and these two fail.
  it("heals a file someone replaced with a link into .dohc", async () => {
    await symlink(join(root, ".dohc", "settings.json"), join(root, "note.md"));
    await restoreWorkspaceText(root, "note.md", "# Restored\n");
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
    expect((await lstat(join(root, "note.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("# Restored\n");
  });

  it("heals a file someone replaced with a link out of the workspace", async () => {
    const outside = await createTestScratch("dohc-real-path-assets-outside-");
    await writeFile(join(outside, "victim.md"), "untouched");
    await symlink(join(outside, "victim.md"), join(root, "note.md"));
    await restoreWorkspaceText(root, "note.md", "# Restored\n");
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("untouched");
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("# Restored\n");
  });

  // `wx` does NOT refuse every existing entry: on a DANGLING link it follows
  // the link and creates its target. So the exclusive path judges the leaf
  // while the rename path does not — the commit mode decides.
  //
  // MUTATION NOTE: give the exclusive path "entry" access and this writes
  // into .dohc.
  it("refuses an exclusive create through a dangling link into .dohc", async () => {
    await symlink(join(root, ".dohc", "planted.json"), join(root, "note.md"));
    await expect(createWorkspaceTextExclusive(root, "note.md", "# New\n")).rejects.toThrow(
      /Restore path has a symlink with no target/,
    );
    expect(existsSync(join(root, ".dohc", "planted.json"))).toBe(false);
  });
});

describe("workspaceDatabase through an in-workspace alias", () => {
  it("refuses to materialize an imported database inside .dohc", async () => {
    await writeFile(join(root, "notes", "rows.csv"), "id,name\n1,a\n");
    await expect(
      importToDatabase(root, "notes/rows.csv", "meta/rows.sqlite", "rows"),
    ).rejects.toThrow(/Database path leads to a reserved area/);
    expect(existsSync(join(root, ".dohc", "rows.sqlite"))).toBe(false);
  });
});

describe("the static directory preview through an in-workspace alias", () => {
  it("refuses a served root that resolves into .dohc", async () => {
    // The entry exists, so before the resolved-path decision this preview
    // started and served the workspace's control plane over HTTP. The alias
    // spells an ordinary folder; only the RESOLVED root gives it away.
    await writeFile(join(root, ".dohc", "index.html"), "<h1>state</h1>");
    await expect(
      startStaticDirectoryPreview(join(root, "meta"), {
        containmentRoot: root,
        entry: "index.html",
      }),
    ).rejects.toThrow(/reserved metadata path/);
  });

  it("never serves .dohc bytes through an alias directory inside the site", async () => {
    // Site root IS the workspace root, so the alias target stays inside the
    // served tree and containment answers "yes".
    await writeFile(join(root, "index.html"), "<h1>site</h1>");
    const preview = await startStaticDirectoryPreview(root, {
      containmentRoot: root,
      entry: "index.html",
    });
    try {
      const denied = await fetch(new URL("/meta/settings.json", preview.url));
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain("engine");
      // The ordinary page still serves.
      await expect(fetch(preview.url).then((res) => res.text())).resolves.toContain("site");
    } finally {
      await preview.stop();
    }
  });

  it("still serves a benign alias directory from the guard's own resolution", async () => {
    // The serve path now uses the resolution the guard produced instead of
    // realpathing the request spelling a second time. That closes a window a
    // test cannot open without a concurrent swap, so this does NOT pin the
    // window — it pins the part that IS observable: the guard's resolution is
    // a usable canonical path, and alias directories still serve through it.
    await writeFile(join(root, "index.html"), "<h1>site</h1>");
    await mkdir(join(root, "pages"), { recursive: true });
    await writeFile(join(root, "pages", "real.html"), "<h1>real page</h1>");
    await symlink(join(root, "pages"), join(root, "alias"), "dir");
    const preview = await startStaticDirectoryPreview(root, {
      containmentRoot: root,
      entry: "index.html",
    });
    try {
      const served = await fetch(new URL("/alias/real.html", preview.url));
      expect(served.status).toBe(200);
      expect(await served.text()).toContain("real page");
    } finally {
      await preview.stop();
    }
  });
});

describe("engine disk writer through an in-workspace alias", () => {
  it("refuses engine text and deletes that land in .dohc", async () => {
    const writer = createDefaultDiskWriter(root);
    await expect(writer.writeTextFile(join(root, "meta", "owned.md"), "engine")).rejects.toThrow(
      /Engine write path leads to a reserved area/,
    );
    expect(existsSync(join(root, ".dohc", "owned.md"))).toBe(false);
    await expect(writer.deletePath(join(root, "meta", "settings.json"))).rejects.toThrow(
      /Engine delete path leads to a reserved area/,
    );
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
  });

  // The writer now mkdirs, checks, and writes on the resolution the guard
  // judged rather than re-walking the spelling. That narrowing is NOT what
  // these pin — a benign alias lands in the same place either way, and opening
  // the window needs a concurrent swap.
  //
  // What they DO pin is `resolvedAbsolute` itself, which six call sites now
  // act on: the resolved parent is where the bytes land, and a still-absent
  // parent chain under it is created correctly. MUTATION NOTE: drop the
  // absent-tail join in realRelativeInRoot and all three fail.
  it("writes through a benign alias directory at its canonical location", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "inbox", "owned.md"), "engine text");
    expect(await readFile(join(root, "notes", "owned.md"), "utf8")).toBe("engine text");
  });

  it("creates a still-absent parent chain under the resolved parent", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    const writer = createDefaultDiskWriter(root);
    await writer.writeTextFile(join(root, "inbox", "a", "b", "deep.md"), "nested");
    expect(await readFile(join(root, "notes", "a", "b", "deep.md"), "utf8")).toBe("nested");
  });

  it("deletes at the resolved location, leaving the alias itself alone", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    await writeFile(join(root, "notes", "doomed.md"), "bye");
    const writer = createDefaultDiskWriter(root);
    await writer.deletePath(join(root, "inbox", "doomed.md"));
    expect(existsSync(join(root, "notes", "doomed.md"))).toBe(false);
    expect((await lstat(join(root, "inbox"))).isSymbolicLink()).toBe(true);
  });
});

describe("shared view materialization through an in-mount alias", () => {
  const store = {
    ensureMainVersion: async () => ({ id: "main" }),
    readTextFile: async () => ({ text: "relay bytes" }),
    readBinaryFile: async () => {
      throw new Error("not part of this test");
    },
    close: async () => undefined,
  } as unknown as Parameters<typeof materializeSharedViewPaths>[3];

  const write = (path: string) =>
    materializeSharedViewPaths(root, "ws", [
      { path, operation: "write", contentKind: "text" },
    ], store);

  it("refuses relay-controlled bytes that land in the mount's own .dohc", async () => {
    await expect(write("meta/owned.md")).rejects.toThrow(
      /Shared view path leads to a reserved area/,
    );
    expect(existsSync(join(root, ".dohc", "owned.md"))).toBe(false);
  });

  // The LEAF is a different question from its parent chain. A materialize
  // removes the target and recreates it (`rm` then `wx`), so it never writes
  // THROUGH a leaf link -- a tampered one is the thing being repaired. A guard
  // that followed it would refuse, the refresh would throw before it commits
  // its cursor, and every later replay would wedge on the same path.
  //
  // MUTATION NOTE: give write deltas "write" access and these three fail.
  it("heals a projected file someone replaced with a dangling link", async () => {
    await symlink(join(root, "gone.md"), join(root, "note.md"));
    await write("note.md");
    expect((await lstat(join(root, "note.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("relay bytes");
  });

  it("heals a leaf link into .dohc without writing through it", async () => {
    await symlink(join(root, ".dohc", "settings.json"), join(root, "note.md"));
    await write("note.md");
    expect(await readFile(join(root, ".dohc", "settings.json"), "utf8")).toBe(SETTINGS);
    expect((await lstat(join(root, "note.md"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("relay bytes");
  });

  it("heals a leaf link that escapes the mount without writing outside it", async () => {
    const outside = await createTestScratch("dohc-real-path-outside-");
    await writeFile(join(outside, "victim.md"), "untouched");
    await symlink(join(outside, "victim.md"), join(root, "note.md"));
    await write("note.md");
    expect(await readFile(join(outside, "victim.md"), "utf8")).toBe("untouched");
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("relay bytes");
  });
});
