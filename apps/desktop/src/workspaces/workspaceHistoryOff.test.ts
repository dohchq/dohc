import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HISTORY_OFF_FOLDER_BODY, HISTORY_OFF_PAGE_BODY, historyOffTitle } from "../ipc/errorWords";
import { createTestScratch } from "./testTemp";
import { HistoryOffError, deleteWorkspacePathByHand, moveWorkspacePathByHand } from "./workspaceFileMoves";

const person = { kind: "human", humanId: "local:test" } as const;

async function workspace() {
  const rootPath = await createTestScratch("history-off-");
  // A page's owner binding sits in the engine store. With History off the
  // app has no capture to read it through.
  await mkdir(join(rootPath, "notes", "box"), { recursive: true });
  await mkdir(join(rootPath, "images"), { recursive: true });
  await writeFile(join(rootPath, "notes", "box", "page.md"), "owned page");
  await writeFile(join(rootPath, "notes", "page.md"), "page");
  await writeFile(join(rootPath, "notes", "plain.txt"), "plain file");
  await writeFile(join(rootPath, "images", "a.png"), "png");
  const operation = { workspace: { workspaceId: "history-off", rootPath }, assertCurrent: vi.fn() };
  const options = { capture: null, requestId: "history-off", markDeleted: vi.fn(), trashItem: vi.fn(async (_path: string) => undefined) };
  const move = (fromPath: string, toPath: string) => moveWorkspacePathByHand(operation, { fromPath, toPath }, person, options);
  const remove = (path: string) => deleteWorkspacePathByHand(operation, path, person, options);
  const notes = async () => (await readdir(join(rootPath, "notes"))).sort();
  return { rootPath, move, remove, notes, trashItem: options.trashItem };
}

describe("an app move while History is off", () => {
  it("refuses a folder before anything on disk changes", async () => {
    const { rootPath, move, notes } = await workspace();
    const moving = move("notes/box", "notes/moved");
    await expect(moving).rejects.toBeInstanceOf(HistoryOffError);
    await expect(moving).rejects.toThrow(`${historyOffTitle("notes/box", "move")}\n${HISTORY_OFF_FOLDER_BODY}`);
    expect(await readFile(join(rootPath, "notes", "box", "page.md"), "utf8")).toBe("owned page");
    expect(await notes()).toEqual(["box", "page.md", "plain.txt"]);
  });

  it("refuses a page, saying rename for a rename and move for a move", async () => {
    const { move, notes } = await workspace();
    const renaming = move("notes/page.md", "notes/renamed.md");
    await expect(renaming).rejects.toBeInstanceOf(HistoryOffError);
    await expect(renaming).rejects.toThrow(`dohc can't rename "notes/page.md" while History is off\n${HISTORY_OFF_PAGE_BODY}`);
    await expect(move("notes/page.md", "page.md")).rejects.toThrow(`dohc can't move "notes/page.md" while History is off\n${HISTORY_OFF_PAGE_BODY}`);
    expect(await notes()).toEqual(["box", "page.md", "plain.txt"]);
  });

  it("still moves an ordinary file", async () => {
    const { rootPath, move, notes } = await workspace();
    await expect(move("notes/plain.txt", "notes/renamed.txt")).resolves.toMatchObject({ path: "notes/renamed.txt" });
    expect(await readFile(join(rootPath, "notes", "renamed.txt"), "utf8")).toBe("plain file");
    expect(await notes()).toEqual(["box", "page.md", "renamed.txt"]);
  });
});

describe("an app delete while History is off", () => {
  it("refuses a page, and a folder with a page in it, before anything on disk changes", async () => {
    const { remove, notes, trashItem } = await workspace();
    const page = remove("notes/page.md");
    await expect(page).rejects.toBeInstanceOf(HistoryOffError);
    await expect(page).rejects.toThrow(`dohc can't delete "notes/page.md" while History is off\n${HISTORY_OFF_PAGE_BODY}`);
    await expect(remove("notes")).rejects.toThrow(`dohc can't delete "notes" while History is off\n${HISTORY_OFF_FOLDER_BODY}`);
    expect(trashItem).not.toHaveBeenCalled();
    expect(await notes()).toEqual(["box", "page.md", "plain.txt"]);
  });

  it("still deletes an ordinary file, and a folder without pages", async () => {
    const { remove, trashItem } = await workspace();
    await remove("notes/plain.txt");
    await remove("images");
    expect(trashItem.mock.calls.map(([path]) => basename(path))).toEqual(["plain.txt", "images"]);
  });
});
