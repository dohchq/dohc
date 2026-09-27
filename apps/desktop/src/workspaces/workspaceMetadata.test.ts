import { readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { resolveWorkspaceMetadataDir } from "./workspaceMetadata";

// The belt-and-braces arm compares realpath(dir) against the resolved root.
// On-disk case skew cannot be staged deterministically, so these tests feed
// the guard the input class the arm exists for by steering realpath itself.
const realpathOverride = vi.hoisted(() => ({
  current: null as ((path: string) => Promise<string> | string | null) | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (path: string) => {
      const steered = await realpathOverride.current?.(path);
      return steered ?? actual.realpath(path);
    },
  };
});

describe("resolveWorkspaceMetadataDir", () => {
  it("resolves and creates <root>/.dohc for an ordinary workspace", async () => {
    realpathOverride.current = null;
    const root = await createTestScratch("dohc-metadata-plain-");
    await expect(resolveWorkspaceMetadataDir(root)).resolves.toBeTruthy();
  });

  it("with create false, answers null and makes nothing when .dohc or the root is missing", async () => {
    realpathOverride.current = null;
    const root = await createTestScratch("dohc-metadata-read-");
    await expect(resolveWorkspaceMetadataDir(root, { create: false })).resolves.toBeNull();
    await expect(readdir(root)).resolves.toEqual([]);
    await expect(resolveWorkspaceMetadataDir(join(root, "gone"), { create: false })).resolves.toBeNull();
    const dir = await resolveWorkspaceMetadataDir(root);
    await expect(resolveWorkspaceMetadataDir(root, { create: false })).resolves.toBe(dir);
  });

  it("with create false, still refuses a .dohc that is not a real folder", async () => {
    realpathOverride.current = null;
    const root = await createTestScratch("dohc-metadata-file-");
    await writeFile(join(root, ".dohc"), "not a folder");
    await expect(resolveWorkspaceMetadataDir(root, { create: false })).rejects.toThrow();
  });

  if (process.platform === "win32") {
    it("refuses a metadata dir that resolves under a case-distinct sibling", async () => {
      // Exact canonical comparison puts a case-distinct sibling outside the
      // workspace. The old pin asserted folding, which was wrong: two
      // realpath calls for the same on-disk entry cannot return different case.
      const root = await createTestScratch("dohc-metadata-case-");
      const sibling = join(dirname(root), basename(root).toUpperCase());
      realpathOverride.current = (path) =>
        path.endsWith(".dohc") ? Promise.resolve(join(sibling, ".dohc")) : null;
      try {
        await expect(resolveWorkspaceMetadataDir(root)).rejects.toThrow(/outside/i);
      } finally {
        realpathOverride.current = null;
      }
    });
  }

  it("still refuses a metadata dir that resolves to the workspace root itself", async () => {
    // Proper-descendant on purpose: isInside counts the root as inside, and a
    // .dohc that resolves TO the root must stay refused.
    const root = await createTestScratch("dohc-metadata-self-");
    realpathOverride.current = (path) =>
      path.endsWith(".dohc") ? Promise.resolve(path.slice(0, -".dohc".length - 1)) : null;
    try {
      await expect(resolveWorkspaceMetadataDir(root)).rejects.toThrow(/outside/i);
    } finally {
      realpathOverride.current = null;
    }
  });
});
