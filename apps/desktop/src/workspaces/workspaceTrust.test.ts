import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestScratch } from "./testTemp";
import { deferred } from "../testing/deferred";
import {
  confirmWorkspaceTrust,
  createWorkspaceTrust,
  folderIdentity,
  visiblePath,
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

describe("trust against races and failed files", () => {
  it("answers no when the workspace is restricted during the folder lookup", async () => {
    const { file, workspace } = await setup();
    const reached = deferred<void>();
    const release = deferred<void>();
    let hold = false;
    const trust = createWorkspaceTrust({
      file,
      identify: async (rootPath) => {
        if (hold) { reached.resolve(); await release.promise; }
        return folderIdentity(rootPath);
      },
    });
    await trust.trust(workspace);
    hold = true;
    const checking = trust.isTrusted(workspace);
    await reached.promise;
    trust.revoke("trip");
    release.resolve();
    expect(await checking).toBe(false);
  });

  it("gives a check taken before a revoke no way to pass at the spawn", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    const stillTrusted = await trust.assertTrusted(workspace);
    expect(() => stillTrusted()).not.toThrow();
    trust.revoke("trip");
    expect(() => stillTrusted()).toThrow(WorkspaceRestrictedError);
  });

  it("binds New workspace's grant to the folder creation made", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace, { folder: "1:2" });
    expect(await trust.isTrusted(workspace)).toBe(false);
    await trust.trust(workspace, { folder: await folderIdentity(workspace.rootPath) });
    expect(await trust.isTrusted(workspace)).toBe(true);
  });

  it("tells one listener of every change, whatever made it, and not of a grant a revoke beat", async () => {
    const { file, workspace } = await setup();
    const changes: Array<[string, boolean]> = [];
    const trust = createWorkspaceTrust({ file, onChange: (workspaceId, trusted) => changes.push([workspaceId, trusted]) });
    // The dialog's grant, and New workspace's, which names its folder.
    await trust.trust(workspace);
    await trust.trust(workspace, { folder: null });
    // Settings' restrict, and Forget's.
    trust.revoke("trip");
    await trust.restrict("trip");
    const granting = trust.trust(workspace);
    trust.revoke("trip");
    expect(await granting).toBe(false);
    expect(changes).toEqual([["trip", true], ["trip", true], ["trip", false], ["trip", false], ["trip", false]]);
  });

  it("keeps Restricted Mode when the person restricts while a grant waits to be written", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    const granting = trust.trust(workspace);
    trust.revoke("trip");
    expect(await granting).toBe(false);
    await trust.persistRevocation("trip");
    expect(await trust.isTrusted(workspace)).toBe(false);
  });

  it("keeps a revoke that lands while the grant is being written, in memory and then in the file", async () => {
    const { file, workspace } = await setup();
    const writing = deferred<void>();
    const release = deferred<void>();
    let hold = true;
    const trust = createWorkspaceTrust({
      file,
      writeText: async (path, text) => {
        if (hold) {
          hold = false;
          writing.resolve();
          await release.promise;
        }
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text);
      },
    });
    const granting = trust.trust(workspace);
    await writing.promise;
    const restricting = trust.restrict("trip");
    release.resolve();
    expect(await granting).toBe(false);
    // Between the grant's write and the revoke's, nothing may run.
    expect(await trust.isTrusted(workspace)).toBe(false);
    await restricting;
    expect(await trust.isTrusted(workspace)).toBe(false);
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(false);
  });

  it("stays restricted in memory when a revoke during the grant's write cannot be saved", async () => {
    const { file, workspace } = await setup();
    const writing = deferred<void>();
    const release = deferred<void>();
    let writes = 0;
    const trust = createWorkspaceTrust({
      file,
      writeText: async (path, text) => {
        writes += 1;
        if (writes === 1) {
          writing.resolve();
          await release.promise;
        } else {
          throw new Error("disk full");
        }
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, text);
      },
    });
    const granting = trust.trust(workspace);
    await writing.promise;
    const restricting = trust.restrict("trip");
    release.resolve();
    expect(await granting).toBe(false);
    await expect(restricting).rejects.toThrow("disk full");
    expect(await trust.isTrusted(workspace)).toBe(false);
  });

  it("keeps a Trust the person gives while a restrict waits to be saved", async () => {
    const { file, workspace } = await setup();
    const trust = createWorkspaceTrust({ file });
    await trust.trust(workspace);
    trust.revoke("trip");
    // The restrict's stop is still running when the person trusts again.
    expect(await trust.trust(workspace)).toBe(true);
    await trust.persistRevocation("trip");
    expect(trust.isRevoked("trip")).toBe(false);
    expect(await trust.isTrusted(workspace)).toBe(true);
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(true);
  });

  it("reads the file again after a failed read, and writes no grant over the others", async () => {
    const { scratch, file, workspace } = await setup();
    const otherRoot = join(scratch, "other");
    await mkdir(otherRoot);
    const other = { workspaceId: "other", rootPath: otherRoot };
    await createWorkspaceTrust({ file }).trust(other);
    let failures = 1;
    const trust = createWorkspaceTrust({
      file,
      readText: async (path) => {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        }
        return readFile(path, "utf8");
      },
    });
    await expect(trust.isTrusted(other)).rejects.toThrow("busy");
    failures = 1;
    await expect(trust.trust(workspace)).rejects.toThrow("busy");
    expect(await trust.isTrusted(other)).toBe(true);
    await trust.trust(workspace);
    const fresh = createWorkspaceTrust({ file });
    expect(await fresh.isTrusted(other)).toBe(true);
    expect(await fresh.isTrusted(workspace)).toBe(true);
  });

  it("trusts nothing in a corrupt file and leaves it until the person trusts or restricts", async () => {
    const { file, workspace } = await setup();
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "{ not json");
    const trust = createWorkspaceTrust({ file });
    expect(await trust.isTrusted(workspace)).toBe(false);
    await trust.persistRevocation("someone-else");
    expect(await readFile(file, "utf8")).toBe("{ not json");
    await trust.trust(workspace);
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(true);
  });

  it("stays restricted when the revoke cannot be written, and writes it on retry", async () => {
    const { file, workspace } = await setup();
    await createWorkspaceTrust({ file }).trust(workspace);
    let failWrite = true;
    const trust = createWorkspaceTrust({
      file,
      writeText: async (path, text) => {
        if (failWrite) throw new Error("disk full");
        await writeFile(path, text);
      },
    });
    expect(await trust.isTrusted(workspace)).toBe(true);
    await expect(trust.restrict("trip")).rejects.toThrow("disk full");
    expect(await trust.isTrusted(workspace)).toBe(false);
    // The file still holds the grant, so a restart would trust it again.
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(true);
    failWrite = false;
    await trust.restrict("trip");
    expect(await createWorkspaceTrust({ file }).isTrusted(workspace)).toBe(false);
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

  it("shows a folder name's line breaks and control characters as escapes", async () => {
    const dialog = answering(1);
    const code = (value: number) => String.fromCodePoint(value);
    const escape = (hex: string) => `${String.fromCharCode(92)}u{${hex}}`;
    const lines = `C:/trip${code(0x0a)}${code(0x0a)}Trust this folder${code(0x202e)}${code(0x07)}`;
    await confirmWorkspaceTrust(dialog.deps, { rootPath: lines });
    const detail = dialog.asked[0]!.detail;
    expect(detail.endsWith(`C:/trip${escape("000a")}${escape("000a")}Trust this folder${escape("202e")}${escape("0007")}`)).toBe(true);
    expect(detail.split(code(0x0a)).filter(Boolean)).toHaveLength(3);
    expect(visiblePath("C:/Users/ice/trip")).toBe("C:/Users/ice/trip");
  });

  it("trusts only on Trust workspace", async () => {
    expect(await confirmWorkspaceTrust(answering(0).deps, { rootPath: "/trip" })).toBe(true);
    expect(await confirmWorkspaceTrust(answering(7).deps, { rootPath: "/trip" })).toBe(false);
  });
});
