import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  deleteWorkspacePathByHand,
  moveWorkspacePathByHand,
  NotVersionedError,
  prepareDeleteWorkspacePathAs,
  prepareMoveWorkspacePathAs,
} from "./workspaceFileMoves";

// In a version, a file the version does not track has one copy for every
// version, so a rename, move or delete of it also changes Main. Each route
// refuses until the caller confirms; on Main nothing asks.

const person = { kind: "human" as const, humanId: "local:installation" };
const agent = { kind: "agent" as const, agentId: "test-agent", onBehalfOf: "local:installation" };

// `untracked`: the files the active version does not track, or null on Main.
async function workspace(untracked: string[] | null) {
  const rootPath = await createTestScratch("not-versioned");
  for (const file of ["Notes/Page.md", "Media/clip.mp4", "Media/cover.png"]) {
    await mkdir(dirname(join(rootPath, file)), { recursive: true });
    await writeFile(join(rootPath, file), "body\n");
  }
  const asked: string[][] = [];
  // The capture stops each change as it starts: these tests check only
  // whether the change got that far.
  const stopped = () => new Error("stopped at capture");
  const capture = {
    changePathsAs: vi.fn(async () => { throw stopped(); }),
    beginFileRename: vi.fn(async () => { throw stopped(); }),
    notVersioned: vi.fn(async (files: () => Promise<readonly string[]>) => {
      if (untracked === null) return null;
      const listed = await files();
      asked.push([...listed]);
      return listed.filter(file => untracked.includes(file));
    }),
  };
  const operation = { workspace: { workspaceId: "workspace", rootPath, attachmentId: Symbol("attachment") }, state: undefined,
    signal: new AbortController().signal, assertCurrent() {} };
  const options = { capture, requestId: "request", trashItem: async () => undefined, markDeleted: () => undefined };
  const reachedCapture = () => capture.changePathsAs.mock.calls.length + capture.beginFileRename.mock.calls.length > 0;
  return { rootPath, capture, operation, options, asked, reachedCapture };
}

it("refuses the app's rename of a file the version does not track, naming it", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  const moving = moveWorkspacePathByHand(f.operation, { fromPath: "Media/clip.mp4", toPath: "Media/renamed.mp4" }, person, f.options);
  await expect(moving).rejects.toBeInstanceOf(NotVersionedError);
  await expect(moving).rejects.toMatchObject({ paths: ["Media/clip.mp4"] });
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Media/clip.mp4"))).toBe(true);
});

it("names only the untracked files under a folder the app moves", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  const moving = moveWorkspacePathByHand(f.operation, { fromPath: "Media", toPath: "Archive" }, person, f.options);
  await expect(moving).rejects.toMatchObject({ paths: ["Media/clip.mp4"] });
  expect(f.asked).toEqual([["Media/clip.mp4", "Media/cover.png"]]);
});

it("the app's confirmed rename goes ahead without asking", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  await expect(moveWorkspacePathByHand(f.operation, { fromPath: "Media/clip.mp4", toPath: "Media/renamed.mp4", confirmNotVersioned: true },
    person, f.options)).rejects.toThrow("stopped at capture");
  expect(f.capture.notVersioned).not.toHaveBeenCalled();
  expect(f.reachedCapture()).toBe(true);
});

it("on Main, or for a tracked file, the app's change goes ahead", async () => {
  const main = await workspace(null);
  await expect(moveWorkspacePathByHand(main.operation, { fromPath: "Media/clip.mp4", toPath: "Media/renamed.mp4" }, person, main.options))
    .rejects.toThrow("stopped at capture");
  expect(main.reachedCapture()).toBe(true);
  const version = await workspace(["Media/clip.mp4"]);
  await expect(moveWorkspacePathByHand(version.operation, { fromPath: "Notes/Page.md", toPath: "Notes/Renamed.md" }, person, version.options))
    .rejects.toThrow("stopped at capture");
  expect(version.reachedCapture()).toBe(true);
});

it("refuses the app's delete until it is confirmed", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  await expect(deleteWorkspacePathByHand(f.operation, "Media/clip.mp4", person, f.options))
    .rejects.toMatchObject({ name: "NotVersionedError", paths: ["Media/clip.mp4"] });
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Media/clip.mp4"))).toBe(true);
  await expect(deleteWorkspacePathByHand(f.operation, "Media/clip.mp4", person, { ...f.options, confirmNotVersioned: true }))
    .rejects.toThrow("stopped at capture");
  expect(f.reachedCapture()).toBe(true);
});

it("answers an agent's move and delete with the refusal and how to confirm", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  const moved = await (await prepareMoveWorkspacePathAs(f.operation, { fromPath: "Media/clip.mp4", toPath: "Media/renamed.mp4" }, agent, f.options))();
  expect(moved).toEqual({ ok: false, path: "Media/clip.mp4", reason: expect.stringContaining("confirmNotVersioned set to true") });
  const deleted = await (await prepareDeleteWorkspacePathAs(f.operation, "Media", agent, f.options))();
  expect(deleted).toEqual({ ok: false, deleted: [], path: "Media", reason: expect.stringContaining("Media/clip.mp4 isn't versioned") });
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Media/clip.mp4"))).toBe(true);
});

it("an agent's confirmed delete goes ahead", async () => {
  const f = await workspace(["Media/clip.mp4"]);
  await (await prepareDeleteWorkspacePathAs(f.operation, "Media/clip.mp4", agent, f.options, true))().catch(() => undefined);
  expect(f.capture.notVersioned).not.toHaveBeenCalled();
  expect(f.reachedCapture()).toBe(true);
});

it("an agent is not told to confirm a file History's rules leave out, which its change refuses anyway", async () => {
  const f = await workspace(["Media/clip.mp4", "Media/cover.png"]);
  await mkdir(join(f.rootPath, ".dohc"), { recursive: true });
  await writeFile(join(f.rootPath, ".dohc/files.toml"), '[[rule]]\npath = "Media/cover.png"\ntracked = false\n');
  const deleted = await (await prepareDeleteWorkspacePathAs(f.operation, "Media", agent, f.options))();
  expect(deleted).toEqual({ ok: false, deleted: [], path: "Media", reason: expect.stringContaining("Media/clip.mp4 isn't versioned") });
  expect(f.asked).toEqual([["Media/clip.mp4"]]);
  // The app moves a left-out file along, so it still asks about it.
  await expect(deleteWorkspacePathByHand(f.operation, "Media", person, f.options))
    .rejects.toMatchObject({ paths: ["Media/clip.mp4", "Media/cover.png"] });
});

it("counts a .git folder the app's change carries along, without reading inside it", async () => {
  const f = await workspace([]);
  await mkdir(join(f.rootPath, "Media/.git/objects"), { recursive: true });
  await writeFile(join(f.rootPath, "Media/.git/config"), "[core]\n");
  await expect(deleteWorkspacePathByHand(f.operation, "Media", person, f.options))
    .rejects.toMatchObject({ name: "NotVersionedError", paths: ["Media/.git"] });
  // The engine is never asked about it.
  expect(f.asked).toEqual([["Media/clip.mp4", "Media/cover.png"]]);
});
