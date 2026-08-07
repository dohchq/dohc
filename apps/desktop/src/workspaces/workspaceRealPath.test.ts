import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectZipEntries, createFile, createFolder, deletePath, movePath } from "./workspaceFiles";
import { resolveWorkspaceFile, restoreWorkspaceText } from "./workspaceAssets";
import { importToDatabase } from "./workspaceDatabase";
import { createDefaultDiskWriter } from "./workspaceEngineCapture";
import { materializeSharedViewPaths } from "./sharedView";
import { startStaticSitePreview } from "./siteRunner";
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
    await expect(createFile(root, "meta/evil.md")).rejects.toThrow(
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

  it("keeps a benign alias to an ordinary folder working", async () => {
    await symlink(join(root, "notes"), join(root, "inbox"), "dir");
    expect(await createFile(root, "inbox/today.md")).toBe("inbox/today.md");
    expect(existsSync(join(root, "notes", "today.md"))).toBe(true);
  });

  it("refuses a write that lands in the shared-with-me projection", async () => {
    await mkdir(join(root, "shared-with-me", "alex"), { recursive: true });
    await symlink(join(root, "shared-with-me"), join(root, "mine"), "dir");
    await expect(createFile(root, "mine/alex/note.md")).rejects.toThrow(
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

describe("siteRunner through an in-workspace alias", () => {
  it("refuses a site root that resolves into .dohc", async () => {
    // The entry exists, so before the resolved-path decision this preview
    // started and served the workspace's control plane over HTTP.
    await writeFile(join(root, ".dohc", "index.html"), "<h1>state</h1>");
    await expect(startStaticSitePreview(root, "meta")).rejects.toThrow(
      /Site path leads to a reserved area/,
    );
  });

  it("never serves .dohc bytes through an alias directory inside the site", async () => {
    // Site root IS the workspace root, so the alias target stays inside the
    // served tree and containment answers "yes".
    await writeFile(join(root, "index.html"), "<h1>site</h1>");
    const preview = await startStaticSitePreview(root, ".");
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
});

describe("shared view materialization through an in-mount alias", () => {
  it("refuses relay-controlled bytes that land in the mount's own .dohc", async () => {
    const store = {
      ensureMainVersion: async () => ({ id: "main" }),
      readTextFile: async () => ({ text: "relay bytes" }),
      readBinaryFile: async () => {
        throw new Error("not part of this test");
      },
      close: async () => undefined,
    } as unknown as Parameters<typeof materializeSharedViewPaths>[3];
    await expect(
      materializeSharedViewPaths(root, "ws", [
        { path: "meta/owned.md", operation: "write", contentKind: "text" },
      ], store),
    ).rejects.toThrow(/Shared view path leads to a reserved area/);
    expect(existsSync(join(root, ".dohc", "owned.md"))).toBe(false);
  });
});
