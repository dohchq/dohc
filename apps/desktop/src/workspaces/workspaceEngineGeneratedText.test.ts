import { closeTrackedEngineDbHandlesForTest } from "@dohc/workspace-engine/testing";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nativeTmpdir } from "./testTemp";
import {
  createDefaultDiskWriter,
  createWorkspaceEngineCapture,
} from "./workspaceEngineCapture";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await mkdtemp(join(nativeTmpdir(), "dohc-generated-text-"));
  roots.push(value);
  return value;
}

async function write(rootPath: string, path: string, text: string): Promise<void> {
  const absolute = join(rootPath, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, text, "utf8");
}

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("WorkspaceEngineCapture generated Markdown", () => {
  it("materializes idempotently and preserves object identity across live refreshes", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-text-test",
      rootPath,
    });

    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/pricing.md",
      text: "# Pricing\n\nFirst projection.\n",
    });
    const repeated = await capture.writeGeneratedTextFile({
      path: created.path,
      text: "# Pricing\n\nFirst projection.\n",
    });
    const refreshed = await capture.writeGeneratedTextFile({
      path: created.path,
      expectedObjectId: created.objectId,
      text: "# Pricing\n\nUpdated projection.\n",
    });

    expect(created.changed).toBe(true);
    expect(repeated).toEqual({ ...created, changed: false });
    expect(refreshed.objectId).toBe(created.objectId);
    expect(await readFile(join(rootPath, refreshed.path), "utf8")).toBe(
      "# Pricing\n\nUpdated projection.\n",
    );
    const moments = await capture.listMoments();
    expect(moments.moments.filter((moment) => moment.path === created.path)).toHaveLength(2);
    expect(new Set(moments.moments.map((moment) => moment.objectId))).toEqual(
      new Set([created.objectId]),
    );
    await capture.stop();
  });

  it("refuses unsafe, non-Markdown, and colliding first-create destinations", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-path-test",
      rootPath,
    });

    await expect(
      capture.writeGeneratedTextFile({ path: ".dohc/bookmark.md", text: "nope" }),
    ).rejects.toThrow(/safe visible Markdown path/u);
    await expect(
      capture.writeGeneratedTextFile({ path: "Bookmarks/Chats/bookmark.txt", text: "nope" }),
    ).rejects.toThrow(/safe visible Markdown path/u);

    await write(rootPath, "Bookmarks/Chats/existing.md", "user content\n");
    await expect(
      capture.writeGeneratedTextFile({
        path: "Bookmarks/Chats/existing.md",
        text: "generated content\n",
      }),
    ).rejects.toThrow(/already exists on disk/u);
    expect(await readFile(join(rootPath, "Bookmarks/Chats/existing.md"), "utf8")).toBe(
      "user content\n",
    );
    await capture.stop();
  });

  it("archives idempotently while preserving the stable object id", async () => {
    const rootPath = await root();
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-archive-test",
      rootPath,
    });
    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/launch.md",
      text: "# Launch\n\nArchived conversation.\n",
    });

    const archived = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath: "Bookmarks/Chats/Archived/launch.md",
      expectedObjectId: created.objectId,
    });
    const repeated = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath: archived.path,
      expectedObjectId: created.objectId,
    });

    expect(archived).toMatchObject({ objectId: created.objectId, changed: true });
    expect(repeated).toMatchObject({ objectId: created.objectId, changed: false });
    await expect(readFile(join(rootPath, created.path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(rootPath, archived.path), "utf8")).toBe(
      "# Launch\n\nArchived conversation.\n",
    );
    expect(await capture.fileObjectIdForPath(archived.path)).toBe(created.objectId);
    expect(await capture.fileObjectIdForPath(created.path)).toBeNull();
    await capture.stop();
  });

  it("repairs a partially materialized archive on retry", async () => {
    const rootPath = await root();
    const disk = createDefaultDiskWriter(rootPath);
    let failDelete = true;
    const capture = createWorkspaceEngineCapture({
      workspaceId: "generated-archive-retry-test",
      rootPath,
      diskWriter: {
        writeTextFile: disk.writeTextFile,
        writeBinaryFile: disk.writeBinaryFile,
        async deletePath(path) {
          if (failDelete) {
            failDelete = false;
            throw new Error("injected delete failure");
          }
          await disk.deletePath(path);
        },
      },
    });
    const created = await capture.writeGeneratedTextFile({
      path: "Bookmarks/Chats/retry.md",
      text: "# Retry\n",
    });
    const toPath = "Bookmarks/Chats/Archived/retry.md";

    await expect(
      capture.archiveGeneratedTextFile({
        fromPath: created.path,
        toPath,
        expectedObjectId: created.objectId,
      }),
    ).rejects.toThrow(/injected delete failure/u);
    expect(await capture.fileObjectIdForPath(toPath)).toBe(created.objectId);

    const repaired = await capture.archiveGeneratedTextFile({
      fromPath: created.path,
      toPath,
      expectedObjectId: created.objectId,
    });
    expect(repaired.changed).toBe(false);
    await expect(readFile(join(rootPath, created.path), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(rootPath, toPath), "utf8")).toBe("# Retry\n");
    await capture.stop();
  });

  it("fails closed when an archive retry finds edited or binary source content", async () => {
    const scenarios: Array<{ name: string; replacement: string | Buffer }> = [
      { name: "edited", replacement: "# User edit after the failed archive\n" },
      { name: "binary", replacement: Buffer.from([0xff, 0x00, 0x01]) },
    ];

    for (const scenario of scenarios) {
      const rootPath = await root();
      const disk = createDefaultDiskWriter(rootPath);
      let failDelete = true;
      const capture = createWorkspaceEngineCapture({
        workspaceId: `generated-archive-${scenario.name}-source-test`,
        rootPath,
        diskWriter: {
          writeTextFile: disk.writeTextFile,
          writeBinaryFile: disk.writeBinaryFile,
          async deletePath(path) {
            if (failDelete) {
              failDelete = false;
              throw new Error("injected delete failure");
            }
            await disk.deletePath(path);
          },
        },
      });
      const created = await capture.writeGeneratedTextFile({
        path: `Bookmarks/Chats/${scenario.name}.md`,
        text: "# Canonical archive\n",
      });
      const toPath = `Bookmarks/Chats/Archived/${scenario.name}.md`;

      await expect(
        capture.archiveGeneratedTextFile({
          fromPath: created.path,
          toPath,
          expectedObjectId: created.objectId,
        }),
      ).rejects.toThrow(/injected delete failure/u);
      await writeFile(join(rootPath, created.path), scenario.replacement);

      await expect(
        capture.archiveGeneratedTextFile({
          fromPath: created.path,
          toPath,
          expectedObjectId: created.objectId,
        }),
      ).rejects.toThrow(/archive source changed before recovery/u);
      expect(await readFile(join(rootPath, created.path))).toEqual(
        Buffer.from(scenario.replacement),
      );
      expect(await readFile(join(rootPath, toPath), "utf8")).toBe(
        "# Canonical archive\n",
      );
      await capture.stop();
    }
  });
});
