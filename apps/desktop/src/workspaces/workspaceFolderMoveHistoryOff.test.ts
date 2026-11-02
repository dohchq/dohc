import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { FOLDER_MOVE_HISTORY_OFF_BODY, FolderMoveHistoryOffError, folderMoveHistoryOffTitle, moveWorkspacePathByHand } from "./workspaceFileMoves";

const person = { kind: "human", humanId: "local:test" } as const;

async function workspace() {
  const rootPath = await createTestScratch("folder-move-history-off-");
  // The page's owner binding sits in the engine store. With History off the
  // app has no capture to read it through.
  await mkdir(join(rootPath, "notes", "box"), { recursive: true });
  await writeFile(join(rootPath, "notes", "box", "page.md"), "owned page");
  await writeFile(join(rootPath, "notes", "plain.md"), "plain file");
  const operation = { workspace: { workspaceId: "history-off", rootPath }, assertCurrent: vi.fn() };
  const move = (fromPath: string, toPath: string) => moveWorkspacePathByHand(operation, { fromPath, toPath }, person,
    { capture: null, requestId: "history-off", markDeleted: vi.fn(), trashItem: vi.fn() });
  return { rootPath, move };
}

describe("an app move while History is off", () => {
  it("refuses a folder before anything on disk changes", async () => {
    const { rootPath, move } = await workspace();
    const moving = move("notes/box", "notes/moved");
    await expect(moving).rejects.toBeInstanceOf(FolderMoveHistoryOffError);
    await expect(moving).rejects.toThrow(`${folderMoveHistoryOffTitle("notes/box")}\n${FOLDER_MOVE_HISTORY_OFF_BODY}`);
    expect(await readFile(join(rootPath, "notes", "box", "page.md"), "utf8")).toBe("owned page");
    expect((await readdir(join(rootPath, "notes"))).sort()).toEqual(["box", "plain.md"]);
  });

  it("still moves a single file", async () => {
    const { rootPath, move } = await workspace();
    await expect(move("notes/plain.md", "notes/renamed.md")).resolves.toMatchObject({ path: "notes/renamed.md" });
    expect(await readFile(join(rootPath, "notes", "renamed.md"), "utf8")).toBe("plain file");
    expect((await readdir(join(rootPath, "notes"))).sort()).toEqual(["box", "renamed.md"]);
  });
});
