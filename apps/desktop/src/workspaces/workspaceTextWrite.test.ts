import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SharedFileReadOnlyError } from "@dohc/workspace-contracts/relay";
import type { ShareAccess } from "@dohc/security-contract/share-selector";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";
import { readWorkspaceText } from "./workspaceAssets";
import { routeWorkspaceTextWrite } from "./workspaceTextWrite";

// WHERE a save lands, and the refusal that comes before it decides.
//
// The engine-backed half of this seam needs a real daemon and lives in
// `shareViewTextWrite.e2e.test.ts`. What is here is the part that must be
// answered BEFORE a store is opened at all: a share view that takes no local
// writes is refused, and refused early enough that nothing is resolved,
// opened, or written on the way to saying so.

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dohc-text-write-"));
  roots.push(root);
  return root;
}

// A store nobody may resolve. Reaching it is the failure this proves absent:
// a refusal that opened the store first would have already paid for the
// decision it then refuses.
function forbiddenStore(): () => CaptureVersionedTextStore {
  return () => {
    throw new Error("the share-view store must not be resolved for a refused write");
  };
}

describe("routeWorkspaceTextWrite", () => {
  for (const [label, shareView] of [
    ["view", { access: "view" as ShareAccess, ended: false }],
    ["comment", { access: "comment" as ShareAccess, ended: false }],
    ["a grant this process cannot read", { access: null, ended: false }],
    ["an ended edit share", { access: "edit" as ShareAccess, ended: true }],
  ] as const) {
    it(`refuses a save in a share view at ${label}, before it opens anything`, async () => {
      const rootPath = await scratch();
      await writeFile(join(rootPath, "note.md"), "granter\n", "utf8");

      await expect(
        routeWorkspaceTextWrite({
          workspaceId: "ws-1",
          rootPath,
          relativePath: "note.md",
          text: "recipient\n",
          // Any hash: the refusal comes before the compare.
          expectedContentHash: "unused",
          shareView,
          shareViewStore: forbiddenStore(),
        }),
        `MUTATION: dropping the level branch lets ${label} write a share view`,
      ).rejects.toBeInstanceOf(SharedFileReadOnlyError);

      // And the file on disk is untouched: a share view's folder is a
      // projection, and a refused save must not have written it on the way.
      await expect(readFile(join(rootPath, "note.md"), "utf8")).resolves.toBe("granter\n");
    });
  }

  it("writes an ordinary workspace's file to disk, and never opens a share store", async () => {
    const rootPath = await scratch();
    await writeFile(join(rootPath, "note.md"), "before\n", "utf8");
    const before = await readWorkspaceText(rootPath, "note.md");
    const read = await routeWorkspaceTextWrite({
      workspaceId: "ws-1",
      rootPath,
      relativePath: "note.md",
      text: "after\n",
      expectedContentHash: before.contentHash ?? "",
      // Not a share view at all.
      shareView: null,
      shareViewStore: forbiddenStore(),
    });

    expect(read.status).toBe("written");
    await expect(readFile(join(rootPath, "note.md"), "utf8")).resolves.toBe("after\n");
  });
});
