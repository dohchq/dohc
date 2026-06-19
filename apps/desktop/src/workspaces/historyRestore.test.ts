import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChangeSetFileRecord } from "../ipc/bridgeContract";
import {
  expectedHistoryRestoreEvent,
  restoreHistoryFileSnapshot,
  undoHistoryFileRestoreSnapshot,
} from "./historyRestore";

async function makeWorkspace() {
  const root = join(await mkdtemp(join(tmpdir(), "dohc-history-restore-")), "ws");
  await mkdir(join(root, "notes"), { recursive: true });
  return root;
}

const trashItem = async (absolutePath: string) => {
  await rm(absolutePath, { force: true, recursive: true });
};

function changedFile(path: string): ChangeSetFileRecord {
  return {
    path,
    operation: "write",
    mediaType: "text/markdown",
    before: { text: "before\n", truncated: false, sizeBytes: 7 },
    after: { text: "after\n", truncated: false, sizeBytes: 6 },
  };
}

describe("history restore", () => {
  it("restores a changed text snapshot and undoes that restore", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "today.md");
    await writeFile(path, "after\n");
    const file = changedFile("notes/today.md");

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "text" });
    expect(await readFile(path, "utf8")).toBe("before\n");

    await expect(
      undoHistoryFileRestoreSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "text" });
    expect(await readFile(path, "utf8")).toBe("after\n");
  });

  it("predicts the filesystem event produced by restore and undo", () => {
    const file = changedFile("notes/today.md");

    expect(expectedHistoryRestoreEvent(file, "restore")).toMatchObject({
      path: "notes/today.md",
      operation: "update",
    });
    expect(expectedHistoryRestoreEvent(file, "restore").sha256).toHaveLength(64);
    expect(expectedHistoryRestoreEvent(file, "undo")).toMatchObject({
      path: "notes/today.md",
      operation: "update",
    });
    expect(expectedHistoryRestoreEvent(file, "undo").sha256).toHaveLength(64);
    expect(expectedHistoryRestoreEvent(file, "restore").sha256).not.toBe(
      expectedHistoryRestoreEvent(file, "undo").sha256,
    );
  });

  it("refuses to restore when the live file changed after the history item", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "today.md");
    await writeFile(path, "later\n");

    await expect(
      restoreHistoryFileSnapshot({
        rootPath: root,
        file: changedFile("notes/today.md"),
        trashItem,
      }),
    ).rejects.toThrow(/live file changed/);
    expect(await readFile(path, "utf8")).toBe("later\n");
  });

  it("moves an unchanged created file to trash and can undo by recreating it", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "new.md");
    await writeFile(path, "created\n");
    const file: ChangeSetFileRecord = {
      path: "notes/new.md",
      operation: "write",
      mediaType: "text/markdown",
      before: null,
      after: { text: "created\n", truncated: false, sizeBytes: 8 },
    };

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "deleted" });
    await expect(readFile(path, "utf8")).rejects.toThrow();

    await expect(
      undoHistoryFileRestoreSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "text" });
    expect(await readFile(path, "utf8")).toBe("created\n");
  });

  it("refuses to delete a created file that has changed since creation", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "new.md");
    await writeFile(path, "edited\n");
    const file: ChangeSetFileRecord = {
      path: "notes/new.md",
      operation: "write",
      before: null,
      after: { text: "created\n", truncated: false },
    };

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).rejects.toThrow(/live file changed/);
    expect(await readFile(path, "utf8")).toBe("edited\n");
  });

  it("refuses to trash a directory that replaced a created file path", async () => {
    const root = await makeWorkspace();
    await mkdir(join(root, "notes", "new.md"));
    const file: ChangeSetFileRecord = {
      path: "notes/new.md",
      operation: "write",
      before: null,
      after: { text: "created\n", truncated: false },
    };

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).rejects.toThrow(/not a small text file/);
    await expect(readFile(join(root, "notes", "new.md"), "utf8")).rejects.toThrow();
  });

  it("restores a deleted text file only while the path is still missing", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "deleted.md");
    const file: ChangeSetFileRecord = {
      path: "notes/deleted.md",
      operation: "delete",
      mediaType: "text/markdown",
      before: { text: "deleted body\n", truncated: false, sizeBytes: 13 },
      after: null,
    };

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "text" });
    expect(await readFile(path, "utf8")).toBe("deleted body\n");

    await expect(
      undoHistoryFileRestoreSnapshot({ rootPath: root, file, trashItem }),
    ).resolves.toEqual({ restored: "deleted" });
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses to restore a deleted file over a recreated live file", async () => {
    const root = await makeWorkspace();
    const path = join(root, "notes", "deleted.md");
    await writeFile(path, "new file\n");
    const file: ChangeSetFileRecord = {
      path: "notes/deleted.md",
      operation: "delete",
      before: { text: "old file\n", truncated: false },
      after: null,
    };

    await expect(
      restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
    ).rejects.toThrow(/already exists/);
    expect(await readFile(path, "utf8")).toBe("new file\n");
  });

  it("refuses rename, binary, and too-large snapshots", async () => {
    const root = await makeWorkspace();

    for (const file of [
      {
        path: "notes/renamed.md",
        operation: "rename",
        before: { text: "before\n" },
        after: { text: "after\n" },
      },
      {
        path: "notes/binary.png",
        operation: "write",
        before: null,
        after: { unavailableReason: "binary" },
      },
      {
        path: "notes/large.md",
        operation: "write",
        before: { text: "before\n" },
        after: { unavailableReason: "too-large", truncated: true },
      },
    ] satisfies ChangeSetFileRecord[]) {
      await expect(
        restoreHistoryFileSnapshot({ rootPath: root, file, trashItem }),
      ).rejects.toThrow(/no safely restorable/);
    }
  });
});
