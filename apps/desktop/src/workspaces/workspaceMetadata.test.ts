import { join } from "node:path";
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

  if (process.platform === "win32") {
    it("accepts a metadata dir whose resolution differs from the spelling only by case", async () => {
      // A resolution that names the same on-disk directory in different case
      // is the same directory. The pre-consolidation guard compared it with a
      // case-sensitive prefix and refused it; the canonical isInside folds
      // case the way the filesystem does.
      const root = await createTestScratch("dohc-metadata-case-");
      realpathOverride.current = (path) =>
        path.endsWith(".dohc") ? Promise.resolve(path.toLowerCase()) : null;
      try {
        await expect(resolveWorkspaceMetadataDir(root)).resolves.toBe(
          join(root, ".dohc"),
        );
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
