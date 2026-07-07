import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeTrackedEngineDbHandlesForTest } from "./engineDbSchema";
import { createLinkedChatStore } from "./linkedChatStore";
import { createVersionedFileWorkspace } from "./versionedFileWorkspace";
import { createVersionedTextStore } from "./versionedTextStore";
import { searchWorkspaceEngine } from "./workspaceSearch";

let root: string;
let now = 1000;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "dohc-phase0-proof-"));
  now = 1000;
});

afterEach(async () => {
  closeTrackedEngineDbHandlesForTest();
  await rm(root, { recursive: true, force: true });
});

function nextNow() {
  now += 10;
  return now;
}

function createIdFactory() {
  const counters = { channel: 0, conflict: 0, message: 0, moment: 0, object: 0, thread: 0, version: 0 };
  return (kind: keyof typeof counters) => {
    counters[kind] += 1;
    return `${kind}-${counters[kind]}`;
  };
}

describe("Phase 0 proof arc", () => {
  it("connects files, history, versions, merge conflicts, chats, and policy search", async () => {
    const createId = createIdFactory();
    const workspaceId = "workspace-a";
    const files = createVersionedFileWorkspace({
      rootDir: root,
      workspaceId,
      nowMs: nextNow,
      createId,
    });

    const first = await files.writeTextFile({
      path: "docs/plan.md",
      text: "Launch plan\n\nalpha starts here\n",
      summary: "Seed plan",
    });
    const second = await files.writeTextFile({
      path: "docs/plan.md",
      text: "Launch plan\n\nalpha changed here\n",
      summary: "Edit plan",
    });
    await files.restoreTextFile({
      changeSetId: second.history.id,
      path: "docs/plan.md",
    });
    await expect(readFile(join(root, "docs/plan.md"), "utf8")).resolves.toBe(
      "Launch plan\n\nalpha starts here\n",
    );
    await expect(files.history.list()).resolves.toHaveLength(3);

    const versions = createVersionedTextStore(root, {
      nowMs: nextNow,
      createId,
    });
    const main = await versions.ensureMainVersion({ workspaceId });
    await versions.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "docs/clean.md",
      text: "Title\n\nIntro\n\nCost: old\n",
      metadata: { origin: "api", summary: "seed clean merge file" },
    });
    await versions.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "docs/conflict.md",
      text: "Decision: base\n",
      metadata: { origin: "api", summary: "seed conflict file" },
    });
    const named = await versions.createNamedVersion({
      workspaceId,
      name: "Experiment",
      fromVersionId: main.id,
    });
    await versions.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "docs/clean.md",
      text: "Title\n\nIntro from Main\n\nCost: old\n",
      metadata: { origin: "api", summary: "main clean edit" },
    });
    await versions.writeTextFile({
      workspaceId,
      versionId: named.id,
      path: "docs/clean.md",
      text: "Title\n\nIntro\n\nCost: from named\n",
      metadata: { origin: "api", summary: "named clean edit" },
    });
    const cleanMerge = await versions.mergeTextFileFromVersion({
      workspaceId,
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/clean.md",
      metadata: { origin: "api", summary: "merge clean file" },
    });
    expect(cleanMerge).toMatchObject({ kind: "merged", operation: "write" });
    await expect(
      versions.readTextFile({ workspaceId, versionId: main.id, path: "docs/clean.md" }),
    ).resolves.toMatchObject({
      text: "Title\n\nIntro from Main\n\nCost: from named\n",
    });

    await versions.writeTextFile({
      workspaceId,
      versionId: main.id,
      path: "docs/conflict.md",
      text: "Decision: Main\n",
      metadata: { origin: "api", summary: "main conflict edit" },
    });
    await versions.writeTextFile({
      workspaceId,
      versionId: named.id,
      path: "docs/conflict.md",
      text: "Decision: named\n",
      metadata: { origin: "api", summary: "named conflict edit" },
    });
    const conflict = await versions.mergeTextFileFromVersion({
      workspaceId,
      targetVersionId: main.id,
      sourceVersionId: named.id,
      path: "docs/conflict.md",
      metadata: { origin: "api", summary: "merge conflict file" },
    });
    expect(conflict).toMatchObject({
      kind: "conflict",
      conflict: {
        base: { text: "Decision: base\n" },
        current: { text: "Decision: Main\n" },
        incoming: { text: "Decision: named\n" },
      },
    });

    const chats = createLinkedChatStore(root, {
      nowMs: nextNow,
      createId: (kind) => createId(kind),
    });
    const thread = await chats.createThread({
      workspaceId,
      title: "Plan discussion",
      linkedFile: { objectId: first.snapshot.objectId, pathHint: "docs/plan.md" },
    });
    await chats.sendMessage({
      workspaceId,
      threadId: thread.id,
      author: { kind: "agent", displayName: "Ice's agent" },
      body: "The alpha chat context stays beside the plan.",
    });
    // PR 08 hardened "no .env leakage": the text store now refuses to hold a
    // secret path as plaintext at all — the strongest possible version of the
    // Phase 0 gate (secret content is versioned encrypted by the secret file
    // store instead; see secretFileStore.test.ts).
    await expect(
      versions.writeTextFile({
        workspaceId,
        versionId: main.id,
        path: ".env",
        text: "ALPHA_SECRET=do-not-index\n",
        metadata: { origin: "local-file", summary: "throwaway secret" },
      }),
    ).rejects.toMatchObject({ code: "invalid-path" });

    const search = await searchWorkspaceEngine({
      workspaceId,
      versionId: main.id,
      query: "alpha",
      versions,
      chats,
    });
    expect(search.map((result) => result.surface)).toEqual(["file", "chat"]);
    expect(JSON.stringify(search)).not.toContain("ALPHA_SECRET");
  });

  it("captures a normal local file edit without actor-specific attribution", async () => {
    const createId = createIdFactory();
    const workspaceId = "workspace-a";
    const files = createVersionedFileWorkspace({
      rootDir: root,
      workspaceId,
      nowMs: nextNow,
      createId,
    });

    await files.writeTextFile({
      path: "notes/agent-task.txt",
      text: "before agent\n",
      metadata: { origin: "local-file", summary: "external editor save" },
    });

    const history = await files.history.list();
    expect(history[0]).toMatchObject({
      author: { kind: "local", label: "Local file edit" },
    });
    expect(history[0]?.author.kind).not.toBe("agent");
  });
});
