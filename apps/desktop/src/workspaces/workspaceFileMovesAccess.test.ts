import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { folderMarkerText } from "@dohc/security-contract/access-rules";
import { expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import { AccessChangeError, moveAccessWarning } from "./moveAccessWarning";
import { moveWorkspacePathByHand } from "./workspaceFileMoves";
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";

const person = { kind: "human" as const, humanId: "local:installation" };
const MARKER = folderMarkerText(`fr_${"1".repeat(32)}`, 1);

const INTO_TEAM =
  "Moving Plan.md into Team may change who can see it. People who could read it may keep a copy.";

async function workspace() {
  const rootPath = await createTestScratch("move-access");
  for (const file of [
    "Plan.md",
    "Team/.dohc-access",
    "Team/Notes/Old.md",
    "Team/Plan2.md",
    "Projects/Team2/.dohc-access",
    "Projects/Team2/Brief.md",
  ]) {
    await mkdir(dirname(join(rootPath, file)), { recursive: true });
    await writeFile(join(rootPath, file), file.endsWith(".dohc-access") ? MARKER : file);
  }
  // The capture runs each change without History, as the move does with no capture.
  let captured = 0;
  const changePathsAs: WorkspaceEngineCapture["changePathsAs"] = async (_paths, _meta, work) => {
    captured += 1;
    return work(null as never);
  };
  const beginFileRename: WorkspaceEngineCapture["beginFileRename"] = async () => {
    captured += 1;
    return async () => undefined;
  };
  const capture = { changePathsAs, beginFileRename };
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
  const reachedCapture = () => captured > 0;
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

  await moveWorkspacePathByHand(
    f.operation,
    { fromPath: "Plan.md", toPath: "Team/Plan.md", confirmAccessChange: true },
    person,
    f.options,
  );
  expect(existsSync(join(f.rootPath, "Plan.md"))).toBe(false);
  await expect(readFile(join(f.rootPath, "Team/Plan.md"), "utf8")).resolves.toBe("Plan.md");
});

it("asks about a move spelled with backslashes, as the move reads it", async () => {
  const f = await workspace();
  await expect(
    moveWorkspacePathByHand(
      f.operation,
      { fromPath: "Team\\Plan2.md", toPath: "Plan2.md" },
      person,
      f.options,
    ),
  ).rejects.toThrow(
    "Moving Plan2.md out of Team may change who can see it. People who could read it may keep a copy.",
  );
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Team/Plan2.md"))).toBe(true);
});

it("asks about a rule written while the move waits for the workspace", async () => {
  const f = await workspace();
  await mkdir(join(f.rootPath, "Later"));
  const moving = moveWorkspacePathByHand(
    f.operation,
    { fromPath: "Plan.md", toPath: "Later/Plan.md" },
    person,
    {
      ...f.options,
      // admit runs under the workspace lock, after the change queued before this move.
      admit: () => writeFile(join(f.rootPath, "Later/.dohc-access"), MARKER),
    },
  );
  await expect(moving).rejects.toThrow(
    "Moving Plan.md into Later may change who can see it. People who could read it may keep a copy.",
  );
  expect(f.reachedCapture()).toBe(false);
  expect(existsSync(join(f.rootPath, "Plan.md"))).toBe(true);
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
  ).resolves.toMatchObject({ path: "Team/Old.md" });
  expect(existsSync(join(f.rootPath, "Team/Notes/Old.md"))).toBe(false);
  await expect(readFile(join(f.rootPath, "Team/Old.md"), "utf8")).resolves.toBe(
    "Team/Notes/Old.md",
  );
});
