import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recoverOnDiskSegments } from "./pluginCaseRecovery";

describe("recoverOnDiskSegments", () => {
  it("rejects immediately when the signal is already aborted", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-aborted-"));
    const controller = new AbortController();
    controller.abort();

    try {
      await expect(
        recoverOnDiskSegments(root, "any/path.ts", controller.signal),
      ).rejects.toThrow("Plugin panel is no longer active.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when the signal aborts between segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-abort-mid-"));
    const controller = new AbortController();

    try {
      await mkdir(join(root, "First"), { recursive: true });
      const actualFs = await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
      let readCount = 0;
      const readdirMock = vi.fn(
        async (...args: Parameters<typeof actualFs.readdir>) => {
          readCount += 1;
          if (readCount === 1) controller.abort();
          return actualFs.readdir(...args);
        },
      );
      vi.resetModules();
      vi.doMock("node:fs/promises", async () => ({
        ...actualFs,
        readdir: readdirMock,
      }));
      const { recoverOnDiskSegments: recoverWithAbortMock } = await import(
        "./pluginCaseRecovery"
      );

      await expect(
        recoverWithAbortMock(root, "First/Second.ts", controller.signal),
      ).rejects.toThrow("Plugin panel is no longer active.");
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it.skipIf(process.platform === "darwin")(
    "prefers a literal match over a normalization-equivalent sibling",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dohc-case-recovery-unicode-"));
      const composedDirectory = "caf\u00e9".normalize("NFC");
      const decomposedDirectory = "caf\u00e9".normalize("NFD");

      try {
        // APFS normalizes on write, so the second mkdir below would collide
        // with the first on darwin — this test models a filesystem that keeps
        // both byte-distinct forms, which only Linux/NTFS actually do.
        await mkdir(join(root, decomposedDirectory));
        await writeFile(
          join(root, decomposedDirectory, "marker.txt"),
          "decomposed\n",
        );
        await mkdir(join(root, composedDirectory));
        await writeFile(join(root, composedDirectory, "marker.txt"), "composed\n");

        const result = await recoverOnDiskSegments(
          root,
          composedDirectory,
          undefined,
        );

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
    },
  );

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
