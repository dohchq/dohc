import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestScratch } from "./testTemp";
import { AccessChangeError, moveAccessWarning } from "./moveAccessWarning";
import { moveWorkspacePathByHand } from "./workspaceFileMoves";

const person = { kind: "human" as const, humanId: "local:installation" };

const INTO_TEAM =
  "Moving Plan.md into Team may change who can see it. People who could read it may keep a copy.";

async function workspace() {
  const rootPath = await createTestScratch("move-access");
  for (const file of [
    "Plan.md",
    "Team/access.yaml",
    "Team/Notes/Old.md",
    "Team/Plan2.md",
    "Projects/Team2/access.yaml",
    "Projects/Team2/Brief.md",
  ]) {
    await mkdir(dirname(join(rootPath, file)), { recursive: true });
    await writeFile(join(rootPath, file), "members: view\n");
  }
  // The capture stops each change as it starts: these tests check only
  // whether the change got that far.
  const capture = {
    changePathsAs: vi.fn(async () => {
      throw new Error("stopped at capture");
    }),
    beginFileRename: vi.fn(async () => {
      throw new Error("stopped at capture");
    }),
  };
  const operation = {
    workspace: { workspaceId: "workspace", rootPath, attachmentId: Symbol("attachment") },
    state: undefined,
    signal: new AbortController().signal,
    assertCurrent() {},
  };
  const options = {
    capture,
    requestId: "request",
    trashItem: async () => undefined,
    markDeleted: () => undefined,
  };
  const reachedCapture = () =>
    capture.changePathsAs.mock.calls.length + capture.beginFileRename.mock.calls.length > 0;
  return { rootPath, operation, options, reachedCapture };
}

it("warns of a move between different sets of rule folders, and not one under the same set", async () => {
  const { rootPath } = await workspace();
  await expect(moveAccessWarning(rootPath, "Plan.md", "Team/Plan.md")).resolves.toBe(INTO_TEAM);
  await expect(moveAccessWarning(rootPath, "Team/Plan2.md", "Plan2.md")).resolves.toBe(
    "Moving Plan2.md out of Team may change who can see it. People who could read it may keep a copy.",
  );
  await expect(
    moveAccessWarning(rootPath, "Team/Notes/Old.md", "Projects/Team2/Old.md"),
  ).resolves.toBe(
    "Moving Old.md into Team2 may change who can see it. People who could read it may keep a copy.",
  );
  // Same set: {Team} above both places, or none above either.
  await expect(moveAccessWarning(rootPath, "Team/Notes/Old.md", "Team/Old.md")).resolves.toBeNull();
  await expect(moveAccessWarning(rootPath, "Plan.md", "Projects/Plan.md")).resolves.toBeNull();
  await expect(moveAccessWarning(rootPath, "Plan.md", "Renamed.md")).resolves.toBeNull();
  // A folder's own rule moves with it.
  await expect(moveAccessWarning(rootPath, "Team", "Projects/Team")).resolves.toBeNull();
});

it("asks before the app's move changes the rule folders above it, and moves once confirmed", async () => {
  const f = await workspace();
  const moving = moveWorkspacePathByHand(
    f.operation,
    { fromPath: "Plan.md", toPath: "Team/Plan.md" },
    person,
    f.options,
  );
  await expect(moving).rejects.toBeInstanceOf(AccessChangeError);
  await expect(moving).rejects.toThrow(INTO_TEAM);
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Plan.md"))).toBe(true);

  await expect(
    moveWorkspacePathByHand(
      f.operation,
      { fromPath: "Plan.md", toPath: "Team/Plan.md", confirmAccessChange: true },
      person,
      f.options,
    ),
  ).rejects.toThrow("stopped at capture");
  expect(f.reachedCapture()).toBe(true);
});

it("lets the app's move under the same rule folders go without asking", async () => {
  const f = await workspace();
  await expect(
    moveWorkspacePathByHand(
      f.operation,
      { fromPath: "Team/Notes/Old.md", toPath: "Team/Old.md" },
      person,
      f.options,
    ),
  ).rejects.toThrow("stopped at capture");
  expect(f.reachedCapture()).toBe(true);
});
