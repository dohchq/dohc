import { lstat, mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  existingLocalStateDir,
  localStateDir,
  LocalStateUnavailableError,
  recordLocalStateOpen,
} from "./workspaceLocalState";
import { createTestScratch } from "./testTemp";

let workspaces = 0;
async function workspace() {
  workspaces += 1;
  return { workspaceId: `local-state-${workspaces}`, rootPath: await createTestScratch("dohc-local-state-") };
}

// What the engine's open does before it reports the folder ready.
async function engineCreates(rootPath: string) {
  await mkdir(join(rootPath, ".dohc", "local"), { recursive: true });
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(LocalStateUnavailableError);
  return (error as LocalStateUnavailableError).refusal;
}

describe("this computer's .dohc/local", () => {
  it("refuses a writer until this workspace's engine open prepared it, and creates nothing", async () => {
    const opened = await workspace();
    expect(await refusal(localStateDir(opened))).toBe("not-opened");
    expect(await lstat(join(opened.rootPath, ".dohc")).catch(() => null)).toBeNull();

    // A folder an earlier run of dohc left is not this open's.
    await engineCreates(opened.rootPath);
    expect(await refusal(localStateDir(opened))).toBe("not-opened");
    // Nor is an open of the same workspace id at another root.
    recordLocalStateOpen({ ...opened, rootPath: join(opened.rootPath, "elsewhere") }, true);
    expect(await refusal(localStateDir(opened))).toBe("not-opened");

    recordLocalStateOpen(opened, true);
    const dir = await localStateDir(opened);
    expect(await lstat(dir).then(stats => stats.isDirectory())).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("refuses a writer after an open that could not keep the folder out of iCloud Drive", async () => {
    const opened = await workspace();
    await engineCreates(opened.rootPath);
    recordLocalStateOpen(opened, false);
    const error = await localStateDir(opened).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LocalStateUnavailableError);
    expect((error as Error).message).toBe(
      "dohc could not keep this workspace's .dohc/local out of iCloud Drive, so it saves nothing there. Restart dohc to try again.",
    );

    // A later open that marks it makes it ready again.
    recordLocalStateOpen(opened, true);
    await expect(localStateDir(opened)).resolves.toMatch(/local$/);
  });

  it("refuses a writer, and makes nothing, when the prepared folder is gone", async () => {
    const opened = await workspace();
    recordLocalStateOpen(opened, true);
    expect(await refusal(localStateDir(opened))).toBe("not-opened");
    expect(await lstat(join(opened.rootPath, ".dohc")).catch(() => null)).toBeNull();
  });

  it("refuses a link at .dohc/local to writers and readers, and leaves its target alone", async () => {
    const opened = await workspace();
    const outside = await createTestScratch("dohc-local-state-outside-");
    await mkdir(join(opened.rootPath, ".dohc"));
    await symlink(outside, join(opened.rootPath, ".dohc", "local"), "dir");
    recordLocalStateOpen(opened, true);
    expect(await refusal(localStateDir(opened))).toBe("not-opened");
    expect(await existingLocalStateDir(opened.rootPath)).toBeNull();
    expect(await readdir(outside)).toEqual([]);
  });

  it("gives a reader the folder whatever the engine reported, and null when it is missing", async () => {
    const opened = await workspace();
    expect(await existingLocalStateDir(opened.rootPath)).toBeNull();
    await engineCreates(opened.rootPath);
    expect(await existingLocalStateDir(opened.rootPath)).toMatch(/local$/);
  });
});
