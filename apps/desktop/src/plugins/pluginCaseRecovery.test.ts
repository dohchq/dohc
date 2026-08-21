import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recoverOnDiskSegments } from "./pluginCaseRecovery";

describe("recoverOnDiskSegments", () => {
  it("marks a missing segment and its descendants as caller-spelled passthrough", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-miss-"));

    try {
      await mkdir(join(root, "Existing"));

      await expect(
        recoverOnDiskSegments(root, join("existing", "Missing", "Child.ts"), undefined),
      ).resolves.toEqual({
        segments: ["Existing", "Missing", "Child.ts"],
        fullyRecovered: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers a literal match over a normalization-equivalent sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-unicode-"));
    const composedDirectory = "caf\u00e9".normalize("NFC");
    const decomposedDirectory = "caf\u00e9".normalize("NFD");

    try {
      await mkdir(join(root, decomposedDirectory));
      await writeFile(join(root, decomposedDirectory, "marker.txt"), "decomposed\n");
      await mkdir(join(root, composedDirectory));
      await writeFile(join(root, composedDirectory, "marker.txt"), "composed\n");

      const result = await recoverOnDiskSegments(root, composedDirectory, undefined);

      expect(result).toEqual({
        segments: [composedDirectory],
        fullyRecovered: true,
      });
      expect(Buffer.from(result.segments[0] ?? "")).toEqual(
        Buffer.from(composedDirectory),
      );
      expect(result.segments[0]).not.toBe(decomposedDirectory);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the case-insensitive fallback when no exact match exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-case-"));

    try {
      await mkdir(join(root, "ActualCase"));

      await expect(
        recoverOnDiskSegments(root, "actualcase", undefined),
      ).resolves.toEqual({
        segments: ["ActualCase"],
        fullyRecovered: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
