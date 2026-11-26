import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_WORKSPACE_HTTP_APPROVALS } from "@dohc/workspace-contracts/http-step-approvals";
import type { TokenCipher } from "./cloudCredentialStore";
import {
  createLocalHttpApprovalStore,
  LocalHttpApprovalLimitError,
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

function fakeCipher(): TokenCipher {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`sealed:${plain}`, "utf8").toString("base64"),
    decrypt: (cipher) => {
      const decoded = Buffer.from(cipher, "base64").toString("utf8");
      if (!decoded.startsWith("sealed:")) throw new Error("corrupt");
      return decoded.slice("sealed:".length);
    },
  };
}

const digest = (index: number) => index.toString(16).padStart(64, "0");
const approval = (approvalDigest: string, automationId = "notify") => ({
  approvalDigest,
  collectionId: "col-1",
  collectionPath: "Tasks",
  automationId,
  stepOrdinal: 0,
});

describe("localHttpApprovalStore", () => {
  it("persists approvals outside the workspace and clears on workspace removal", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, cipher: fakeCipher(), nowMs: () => 5000 });
    const d1 = digest(1);

    expect(await store.approved("ws-1")).toEqual(new Set());
    await store.approve("ws-1", approval(d1));
    expect(await store.approved("ws-1")).toEqual(new Set([d1]));
    expect(await store.approved("ws-2")).toEqual(new Set());
    const [fileName] = await readdir(join(dir, "http-approvals"));
    expect(await readFile(join(dir, "http-approvals", fileName!), "utf8")).not.toContain(d1);

    await store.clearWorkspace("ws-1");
    expect(await store.approved("ws-1")).toEqual(new Set());
  });

  it("treats an edited, swapped, or plain file as no approvals and replaces it on the next approval", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, cipher: fakeCipher(), nowMs: () => 1000 });
    await store.approve("ws-1", approval(digest(1)));
    await store.approve("ws-2", approval(digest(9)));
    const approvalsDir = join(dir, "http-approvals");
    const files = await readdir(approvalsDir);
    const contents = await Promise.all(
      files.map((file) => readFile(join(approvalsDir, file), "utf8")),
    );
    const ws1Path = join(
      approvalsDir,
      files[contents.findIndex((text) => text.includes('"ws-1"'))]!,
    );
    const ws2Text = contents.find((text) => text.includes('"ws-2"'))!;

    const injected = digest(2);
    await writeFile(
      ws1Path,
      JSON.stringify({
        version: 1,
        workspaceId: "ws-1",
        approvals: {
          [injected]: {
            collectionPath: "Tasks",
            automationId: "evil",
            stepOrdinal: 0,
            approvedAtMs: 1,
          },
        },
      }),
    );
    expect(await store.approved("ws-1")).toEqual(new Set());

    await writeFile(ws1Path, ws2Text.replace('"workspaceId": "ws-2"', '"workspaceId": "ws-1"'));
    expect(await store.approved("ws-1")).toEqual(new Set());

    await writeFile(ws1Path, "{not json");
    expect(await store.approved("ws-1")).toEqual(new Set());

    await store.approve("ws-1", approval(digest(3)));
    expect(await store.approved("ws-1")).toEqual(new Set([digest(3)]));
  });

  it("keeps plain approvals when this computer has no system keychain", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, nowMs: () => 1000 });
    await store.approve("ws-1", approval(digest(1)));
    expect(await store.approved("ws-1")).toEqual(new Set([digest(1)]));
    const sealedStore = createLocalHttpApprovalStore({ dir, cipher: fakeCipher() });
    expect(await sealedStore.approved("ws-1")).toEqual(new Set());
  });

  it("retires superseded revisions for the same step and enforces the per-workspace cap across distinct steps", async () => {
    const dir = await tempDir();
    const store = createLocalHttpApprovalStore({ dir, cipher: fakeCipher(), nowMs: () => 1000 });
    for (let i = 0; i < 3; i += 1) {
      await store.approve("ws-1", approval(digest(i + 1), "edited-many-times"));
    }
    expect(await store.approved("ws-1")).toEqual(new Set([digest(3)]));

    const store2 = createLocalHttpApprovalStore({
      dir: await tempDir(),
      cipher: fakeCipher(),
      nowMs: () => 1000,
    });
    for (let i = 0; i < MAX_WORKSPACE_HTTP_APPROVALS; i += 1) {
      await store2.approve("ws-1", approval(digest(i + 1), `notify-${i}`));
    }
    await store2.approve("ws-1", approval(digest(1), "notify-0"));
    await expect(
      store2.approve("ws-1", approval(digest(MAX_WORKSPACE_HTTP_APPROVALS + 1), "notify-overflow")),
    ).rejects.toBeInstanceOf(LocalHttpApprovalLimitError);
  });
});
