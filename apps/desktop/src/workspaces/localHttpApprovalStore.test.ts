import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_WORKSPACE_HTTP_APPROVALS } from "@dohc/workspace-contracts/http-step-approvals";
import {
  createLocalHttpApprovalStore,
  LocalHttpApprovalLimitError,
  LocalHttpApprovalStoreCorruptError,
} from "./localHttpApprovalStore";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dohc-http-approvals-"));
  dirs.push(dir);
  return dir;
}

const digest = (index: number) => index.toString(16).padStart(64, "0");

describe("localHttpApprovalStore", () => {
  it("persists approvals outside the workspace, checks approval state, and clears on workspace removal", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, nowMs: () => 5000 });
    const d1 = digest(1);

    expect(await store.isApproved("ws-1", d1)).toBe("unapproved");
    await store.approve("ws-1", {
      approvalDigest: d1,
      collectionId: "col-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
    });
    expect(await store.isApproved("ws-1", d1)).toBe("approved");
    expect(await store.isApproved("ws-2", d1)).toBe("unapproved");
    expect(await store.list("ws-1")).toEqual([d1]);

    await store.clearWorkspace("ws-1");
    expect(await store.isApproved("ws-1", d1)).toBe("unapproved");
  });

  it("fails closed on corrupt JSON and own __proto__ keys without overwriting the file", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, nowMs: () => 1000 });
    const d1 = digest(1);
    await store.approve("ws-1", {
      approvalDigest: d1,
      collectionId: "col-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
    });

    const approvalsDir = join(dir, "http-approvals");
    const [fileName] = await readdir(approvalsDir);
    const filePath = join(approvalsDir, fileName!);

    const protoPoison = JSON.stringify({
      version: 1,
      workspaceId: "ws-1",
      approvals: JSON.parse(
        '{"__proto__":{"collectionPath":"Tasks","automationId":"evil","stepOrdinal":0,"approvedAtMs":1}}',
      ),
    });
    await writeFile(filePath, protoPoison, "utf8");

    expect(await store.isApproved("ws-1", d1)).toBe("unavailable");
    await expect(store.list("ws-1")).rejects.toBeInstanceOf(LocalHttpApprovalStoreCorruptError);
    await expect(
      store.approve("ws-1", {
        approvalDigest: digest(2),
        collectionId: "col-1",
        collectionPath: "Tasks",
        automationId: "notify",
        stepOrdinal: 0,
      }),
    ).rejects.toBeInstanceOf(LocalHttpApprovalStoreCorruptError);
    expect(await readFile(filePath, "utf8")).toBe(protoPoison);
  });

  it("retires superseded revisions for the same step and enforces the per-workspace cap across distinct steps", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, nowMs: () => 1000 });
    for (let i = 0; i < MAX_WORKSPACE_HTTP_APPROVALS + 5; i += 1) {
      await store.approve("ws-1", {
        approvalDigest: digest(i + 1),
        collectionId: "col-1",
        collectionPath: "Tasks",
        automationId: "edited-many-times",
        stepOrdinal: 0,
      });
    }
    expect(await store.list("ws-1")).toEqual([digest(MAX_WORKSPACE_HTTP_APPROVALS + 5)]);
    expect(await store.isApproved("ws-1", digest(1))).toBe("unapproved");
    expect(await store.isApproved("ws-1", digest(MAX_WORKSPACE_HTTP_APPROVALS + 5))).toBe(
      "approved",
    );

    const store2 = createLocalHttpApprovalStore({ dir: await tempDir(), nowMs: () => 1000 });
    for (let i = 0; i < MAX_WORKSPACE_HTTP_APPROVALS; i += 1) {
      await store2.approve("ws-1", {
        approvalDigest: digest(i + 1),
        collectionId: "col-1",
        collectionPath: "Tasks",
        automationId: `notify-${i}`,
        stepOrdinal: 0,
      });
    }
    await store2.approve("ws-1", {
      approvalDigest: digest(1),
      collectionId: "col-1",
      collectionPath: "Tasks",
      automationId: "notify-0",
      stepOrdinal: 0,
    });
    await expect(
      store2.approve("ws-1", {
        approvalDigest: digest(MAX_WORKSPACE_HTTP_APPROVALS + 1),
        collectionId: "col-1",
        collectionPath: "Tasks",
        automationId: "notify-overflow",
        stepOrdinal: 0,
      }),
    ).rejects.toBeInstanceOf(LocalHttpApprovalLimitError);
  });
});
