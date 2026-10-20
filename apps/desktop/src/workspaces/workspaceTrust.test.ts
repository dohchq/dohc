import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import {
  confirmWorkspaceTrust,
  createWorkspaceTrust,
  isEmptyOrMissingFolder,
  WorkspaceRestrictedError,
} from "./workspaceTrust";

async function setup() {
  const scratch = await createTestScratch("workspace-trust-");
  const profile = join(scratch, "profile");
  const file = join(profile, "workspace-trust.json");
  const rootPath = join(scratch, "trip");
  await mkdir(rootPath);
  return { scratch, file, rootPath, workspace: { workspaceId: "trip", rootPath } };
}

describe("workspace trust", () => {
  it("restricts a workspace it has no record of", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    expect(await trust.isTrusted(workspace)).toBe(false);
    await expect(trust.assertTrusted(workspace)).rejects.toThrow(WorkspaceRestrictedError);
  });

  it("keeps trust in the profile file across a restart, and nothing in the workspace", async () => {
    const { file, workspace } = await setup();
    await createWorkspaceTrust({ file }).trust(workspace);
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(true);
    const saved = JSON.parse(await readFile(file, "utf8")) as { trusted: Array<{ workspaceId: string; rootPath: string; folder: string | null }> };
    expect(saved.trusted).toEqual([expect.objectContaining({ workspaceId: "trip", rootPath: workspace.rootPath.replaceAll("\\", "/"), folder: expect.any(String) })]);
  });

  it.runIf(process.platform === "win32")("matches one folder spelled with forward slashes or backslashes", async () => {
    const { file, workspace } = await setup();
    const forward = { ...workspace, rootPath: workspace.rootPath.replaceAll("\\", "/") };
    const back = { ...workspace, rootPath: workspace.rootPath.replaceAll("/", "\\") };
    const trust = createWorkspaceTrust({ file });
    await trust.trust(forward);
    expect(await trust.isTrusted(back)).toBe(true);
    await trust.trust(back);
    expect(await createWorkspaceTrust({ file }).isTrusted(forward)).toBe(true);
  });

  it("gives another workspace in the same folder, or the same workspace elsewhere, no trust", async () => {
    const { scratch, file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    expect(await trust.isTrusted({ ...workspace, workspaceId: "other" })).toBe(false);
    const copy = join(scratch, "copy");
    await mkdir(copy);
    expect(await trust.isTrusted({ ...workspace, rootPath: copy })).toBe(false);
  });

  it("restricts a folder moved away, and a different folder put at its path", async () => {
    const { scratch, file, rootPath, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    const moved = join(scratch, "moved");
    await rename(rootPath, moved);
    expect(await trust.isTrusted(workspace)).toBe(false);
    expect(await trust.isTrusted({ ...workspace, rootPath: moved })).toBe(false);
    // A replacement at the old path, with the same workspace id, is another folder.
    await mkdir(rootPath);
    expect(await trust.isTrusted(workspace)).toBe(false);
  });

  it("matches on id and path alone where the file system numbers no folders", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file, identify: async () => null });
    await trust.trust(workspace);
    expect(await trust.isTrusted(workspace)).toBe(true);
  });

  it("restricts the workspace again, and only that workspace", async () => {
    const { scratch, file, workspace } = await setup();
    const otherRoot = join(scratch, "other");
    await mkdir(otherRoot);
    const other = { workspaceId: "other", rootPath: otherRoot };
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    await trust.trust(other);
    await trust.restrict("trip");
    expect(await trust.isTrusted(workspace)).toBe(false);
    expect(await trust.isTrusted(other)).toBe(true);
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(false);
  });

  it("keeps a revoke when the first reads race with it", async () => {
    const { file, workspace } = await setup();
    await createWorkspaceTrust({ file }).trust(workspace);
    const trust = createWorkspaceTrust({ file });
    const reading = trust.isTrusted(workspace);
    await trust.restrict("trip");
    await reading;
    expect(await trust.isTrusted(workspace)).toBe(false);
  });

  it("trusts nothing from an unreadable file", async () => {
    const { file, workspace } = await setup();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{ not json");
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(false);
    // A record someone wrote by hand without the folder's identity does not match.
    await writeFile(file, JSON.stringify({ version: 1, trusted: [{ ...workspace, folder: null, trustedAtMs: 1 }] }));
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(false);
  });

  it("restricts a workspace whose folder is gone", async () => {
    const { file, rootPath, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    await rm(rootPath, { recursive: true });
    expect(await trust.isTrusted(workspace)).toBe(false);
  });
});

describe("New workspace's default", () => {
  it("counts a missing or empty folder as new, and a folder with files as existing", async () => {
    const { scratch, rootPath } = await setup();
    expect(await isEmptyOrMissingFolder(join(scratch, "missing"))).toBe(true);
    expect(await isEmptyOrMissingFolder(rootPath)).toBe(true);
    await writeFile(join(rootPath, "package.json"), "{}");
    expect(await isEmptyOrMissingFolder(rootPath)).toBe(false);
  });
});

describe("main's trust dialog", () => {
  function answering(response: number) {
    const asked: Array<Parameters<Parameters<typeof confirmWorkspaceTrust>[0]["showMessageBox"]>[0]> = [];
    return {
      asked,
      deps: {
        showMessageBox: async (options: (typeof asked)[number]) => {
          asked.push(options);
          return { response };
        },
      },
    };
  }

  it("asks the person, names the folder, and defaults to Stay in Restricted Mode", async () => {
    const dialog = answering(1);
    expect(await confirmWorkspaceTrust(dialog.deps, { rootPath: "C:/Users/ice/trip" })).toBe(false);
    expect(dialog.asked).toEqual([expect.objectContaining({
      message: "Do you trust the authors of the files in this workspace?",
      buttons: ["Trust workspace", "Stay in Restricted Mode"],
      defaultId: 1,
      cancelId: 1,
    })]);
    expect(dialog.asked[0]!.detail).toContain("That code can do anything you can");
    expect(dialog.asked[0]!.detail).toContain("C:/Users/ice/trip");
  });

  it("trusts only on Trust workspace", async () => {
    expect(await confirmWorkspaceTrust(answering(0).deps, { rootPath: "/trip" })).toBe(true);
    expect(await confirmWorkspaceTrust(answering(7).deps, { rootPath: "/trip" })).toBe(false);
  });
});
