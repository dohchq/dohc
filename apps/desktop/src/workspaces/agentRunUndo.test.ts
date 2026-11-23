import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonRefusalError, VERSIONED_METHOD } from "@dohc/workspace-engine-client";
import { VersionedLoopbackEngine } from "@dohc/workspace-engine-client/testing";
import { mockDaemonSessions } from "../testing/liveEngineSessions";
import {
  createWorkspaceEngineCapture,
  type WorkspaceEngineCapture,
} from "./workspaceEngineCapture";
import { createTestScratch } from "./testTemp";

const RESTORER = { kind: "human", humanId: "local-person" } as const;

function agentAuthor(agentRunId: string, agentId = "rover", agentName = "Rover") {
  return {
    kind: "agent" as const,
    agentId,
    agentName,
    onBehalfOf: "local-person",
    agentRunId,
  };
}

async function writeDisk(root: string, path: string, contents: string) {
  const absolute = join(root, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, contents);
}

async function readDisk(root: string, path: string): Promise<string> {
  return readFile(join(root, path), "utf8");
}

function createCapture(
  root: string,
  loopback: VersionedLoopbackEngine,
  options?: {
    hasRetainedLiveDraft?: (path: string, objectId: string) => Promise<boolean>;
  },
): WorkspaceEngineCapture {
  const workspaceId = "agent-run-undo-test";
  return createWorkspaceEngineCapture({
    workspaceId,
    rootPath: root,
    attachmentId: Symbol("agent-run-undo-test"),
    rustEngineSessions: mockDaemonSessions({ rootPath: root, workspaceId, loopback }),
    hasRetainedLiveDraft: options?.hasRetainedLiveDraft,
  });
}

describe("planUndoAgentRun and undoAgentRun", () => {
  it("restores modified files across multiple edits, deletes created files, and records one correlated restore pass", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-basic-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/plan.md", "Initial plan\n");
      await writeDisk(root, "notes/budget.md", "Initial budget\n");
      await engine.flush();

      const run = agentAuthor("run-1");
      await engine.writeAuthoredFile(join(root, "notes/plan.md"), "Draft 1\n", run);
      await engine.writeAuthoredFile(join(root, "notes/plan.md"), "Draft 2\n", run);
      await engine.writeAuthoredFile(join(root, "notes/budget.md"), "Updated budget\n", run);
      await engine.writeAuthoredFile(join(root, "notes/checklist.md"), "Created by Rover\n", run);

      const plan = await engine.planUndoAgentRun("run-1", {
        resolveAgentName: (author) => (author.agentId === "rover" ? "Rover" : "Agent"),
      });
      expect(plan.agentRunId).toBe("run-1");
      expect(plan.agentName).toBe("Rover");
      expect(plan.truncated).toBe(false);
      expect(plan.skipped).toEqual([]);
      expect(plan.restorable.map((item) => [item.path, item.action, item.momentCount])).toEqual([
        ["notes/budget.md", "restore", 1],
        ["notes/checklist.md", "delete", 1],
        ["notes/plan.md", "restore", 2],
      ]);

      const undone = await engine.undoAgentRun("run-1", RESTORER, {
        expectedTargets: plan.restorable.map(
          ({ objectId, path, earliestMomentId, latestMomentId, action }) => ({
            objectId,
            path,
            earliestMomentId,
            latestMomentId,
            action,
          }),
        ),
      });
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([]);
      expect(undone.correlationId).toMatch(/^restore-agent-run-/);
      expect(undone.restored.map((item) => [item.path, item.restored])).toEqual([
        ["notes/budget.md", "text"],
        ["notes/checklist.md", "deleted"],
        ["notes/plan.md", "text"],
      ]);

      expect(await readDisk(root, "notes/plan.md")).toBe("Initial plan\n");
      expect(await readDisk(root, "notes/budget.md")).toBe("Initial budget\n");
      expect(existsSync(join(root, "notes/checklist.md"))).toBe(false);

      const history = await engine.listMoments({ limit: 10 });
      const restoreMoments = history.moments.filter(
        (moment) => moment.metadata.correlationId === undone.correlationId,
      );
      expect(restoreMoments).toHaveLength(3);
      expect(restoreMoments.every((moment) => moment.metadata.origin === "restore")).toBe(true);

      const secondPlan = await engine.planUndoAgentRun("run-1");
      expect(secondPlan.restorable).toEqual([]);
      expect(secondPlan.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["notes/budget.md", "unchanged"],
        ["notes/checklist.md", "unchanged"],
        ["notes/plan.md", "unchanged"],
      ]);
      expect(secondPlan.skipped.every((item) => item.detail.includes("Already undone"))).toBe(true);
    } finally {
      await engine.stop();
    }
  });

  it("skips files with later edits, interleaved edits, disk edits, reviewPaths, retained drafts, and otherWindow", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-skips-");
    const loopback = new VersionedLoopbackEngine();
    const retainedDraftPaths = new Set(["notes/retained.md"]);
    const engine = createCapture(root, loopback, {
      hasRetainedLiveDraft: async (path) => retainedDraftPaths.has(path),
    });
    try {
      await writeDisk(root, "notes/safe.md", "Safe before\n");
      await writeDisk(root, "notes/later.md", "Later before\n");
      await writeDisk(root, "notes/interleaved.md", "Interleaved before\n");
      await writeDisk(root, "notes/disk.md", "Disk before\n");
      await writeDisk(root, "notes/review.md", "Review before\n");
      await writeDisk(root, "notes/retained.md", "Retained before\n");
      await writeDisk(root, "notes/reverted.md", "Same\n");
      await engine.flush();

      const run = agentAuthor("run-skips");
      await engine.writeAuthoredFile(join(root, "notes/safe.md"), "Safe agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/later.md"), "Later agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/interleaved.md"), "Agent 1\n", run);
      await engine.writeAuthoredFile(
        join(root, "notes/interleaved.md"),
        "Human middle\n",
        RESTORER,
      );
      await engine.writeAuthoredFile(join(root, "notes/interleaved.md"), "Agent 2\n", run);
      await engine.writeAuthoredFile(join(root, "notes/disk.md"), "Disk agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/review.md"), "Review agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/retained.md"), "Retained agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/reverted.md"), "Temp\n", run);
      await engine.writeAuthoredFile(join(root, "notes/reverted.md"), "Same\n", run);

      await engine.writeAuthoredFile(join(root, "notes/later.md"), "Human after\n", RESTORER);
      await writeDisk(root, "notes/disk.md", "Unrecorded disk change\n");

      const otherWindowPlan = await engine.planUndoAgentRun("run-skips", {
        hasOtherWindow: () => true,
      });
      expect(otherWindowPlan.restorable).toEqual([]);
      expect(otherWindowPlan.skipped.find((item) => item.path === "notes/safe.md")?.reason).toBe(
        "other-window",
      );

      const plan = await engine.planUndoAgentRun("run-skips", {
        reviewPaths: ["notes/review.md"],
      });
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/safe.md"]);
      expect(plan.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["notes/disk.md", "later-edits"],
        ["notes/interleaved.md", "later-edits"],
        ["notes/later.md", "later-edits"],
        ["notes/retained.md", "local-changes"],
        ["notes/reverted.md", "unchanged"],
        ["notes/review.md", "local-changes"],
      ]);

      const undone = await engine.undoAgentRun("run-skips", RESTORER, {
        expectedPlanToken: plan.planToken,
        reviewPaths: ["notes/review.md"],
      });
      expect(undone.restored.map((item) => item.path)).toEqual(["notes/safe.md"]);
      expect(await readDisk(root, "notes/safe.md")).toBe("Safe before\n");
      expect(await readDisk(root, "notes/later.md")).toBe("Human after\n");
      expect(await readDisk(root, "notes/interleaved.md")).toBe("Agent 2\n");
      expect(await readDisk(root, "notes/disk.md")).toBe("Unrecorded disk change\n");
      expect(await readDisk(root, "notes/review.md")).toBe("Review agent\n");
      expect(await readDisk(root, "notes/retained.md")).toBe("Retained agent\n");
    } finally {
      await engine.stop();
    }
  });

  it("skips renamed files and delete-then-recreate path collisions", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-rename-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/orig.md", "Original\n");
      await writeDisk(root, "notes/collide.md", "Old collide\n");
      await engine.flush();

      const run = agentAuthor("run-rename");
      await engine.writeAuthoredFile(join(root, "notes/orig.md"), "Agent edit\n", run);
      await engine.changePathsAs(
        ["notes/orig.md", "notes/renamed.md"],
        { operation: "move", operationId: "op-rename-1", author: RESTORER },
        async (ops) => {
          await rename(join(root, "notes/orig.md"), join(root, "notes/renamed.md"));
          await ops.rename("notes/orig.md", "notes/renamed.md");
        },
        () => ["notes/orig.md"],
      );

      await engine.writeAuthoredFile(join(root, "notes/collide.md"), "Agent edit 1\n", run);
      await rm(join(root, "notes/collide.md"));
      engine.observeFileEvents([{ path: "notes/collide.md", operation: "delete" }]);
      await engine.flush();
      await engine.writeAuthoredFile(join(root, "notes/collide.md"), "Recreated\n", run);

      const plan = await engine.planUndoAgentRun("run-rename");
      expect(plan.restorable).toEqual([]);
      expect(plan.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["notes/collide.md", "path-collision"],
        ["notes/orig.md", "renamed"],
      ]);
    } finally {
      await engine.stop();
    }
  });

  it("enforces expectedTargets and reports partial per-file failures without aborting safe files", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-partial-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/a.md", "A before\n");
      await writeDisk(root, "notes/b.md", "B before\n");
      await writeDisk(root, "notes/c.md", "C before\n");
      await engine.flush();

      const run = agentAuthor("run-partial");
      await engine.writeAuthoredFile(join(root, "notes/a.md"), "A agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/b.md"), "B agent\n", run);

      const plan = await engine.planUndoAgentRun("run-partial");
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/a.md", "notes/b.md"]);

      await engine.writeAuthoredFile(join(root, "notes/c.md"), "C late agent\n", run);

      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: string }).path === "notes/a.md"
        ) {
          throw new DaemonRefusalError(
            { code: "INVALID_PARAMS", message: "file-locked", retry: "no" },
            null,
          );
        }
        return send(request);
      });

      const result = await engine.undoAgentRun("run-partial", RESTORER, {
        expectedTargets: plan.restorable.map(
          ({ objectId, path, earliestMomentId, latestMomentId, action }) => ({
            objectId,
            path,
            earliestMomentId,
            latestMomentId,
            action,
          }),
        ),
      });

      expect(result.restored.map((item) => item.path)).toEqual(["notes/b.md"]);
      expect(result.failed.map((item) => item.path)).toEqual(["notes/a.md"]);
      expect(result.skipped).toEqual([
        expect.objectContaining({ path: "notes/c.md", reason: "not-in-plan" }),
      ]);
      expect(await readDisk(root, "notes/b.md")).toBe("B before\n");
      expect(await readDisk(root, "notes/a.md")).toBe("A agent\n");
      expect(await readDisk(root, "notes/c.md")).toBe("C late agent\n");
    } finally {
      await engine.stop();
    }
  });

  it("refuses with policyUnreadable when workspace rules cannot be parsed", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-policy-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, ".dohc/files.toml", "not valid toml = [\n");
      const plan = await engine.planUndoAgentRun("run-any");
      expect(plan.policyUnreadable).toEqual([".dohc/files.toml"]);
      expect(plan.restorable).toEqual([]);

      const result = await engine.undoAgentRun("run-any", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(result.policyUnreadable).toEqual([".dohc/files.toml"]);
      expect(result.restored).toEqual([]);
    } finally {
      await engine.stop();
    }
  });

  it("refuses a stale planToken without touching any files", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-token-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/a.md", "A before\n");
      await engine.flush();
      const run = agentAuthor("run-token");
      await engine.writeAuthoredFile(join(root, "notes/a.md"), "A agent\n", run);

      const plan = await engine.planUndoAgentRun("run-token");
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/a.md"]);

      await engine.writeAuthoredFile(join(root, "notes/b.md"), "B late\n", run);

      const stale = await engine.undoAgentRun("run-token", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(stale.restored).toEqual([]);
      expect(stale.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["notes/a.md", "not-in-plan"],
        ["notes/b.md", "not-in-plan"],
      ]);
      expect(await readDisk(root, "notes/a.md")).toBe("A agent\n");
      expect(await readDisk(root, "notes/b.md")).toBe("B late\n");
    } finally {
      await engine.stop();
    }
  });

  it("skips Collection records and created drawings, while allowing edits to existing drawings", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-scope-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "tasks/collection.yaml", "fields:\n  title: text\n");
      await writeDisk(root, "ledger/dataset.json", '{"id":"ds-1"}\n');
      await writeDisk(
        root,
        "drawings/existing.excalidraw",
        '{"type":"excalidraw","version":2,"elements":[]}\n',
      );
      await writeDisk(root, "notes/plain.md", "Plain before\n");
      await engine.flush();

      const run = agentAuthor("run-scope");
      await engine.writeAuthoredFile(join(root, "tasks/item-1.md"), "# Task 1\n", run);
      await engine.writeAuthoredFile(join(root, "ledger/notes.md"), "Ledger note\n", run);
      await engine.writeAuthoredFile(
        join(root, "drawings/new.excalidraw"),
        '{"type":"excalidraw","version":2,"elements":[]}\n',
        run,
      );
      await engine.writeAuthoredFile(
        join(root, "drawings/existing.excalidraw"),
        '{"type":"excalidraw","version":2,"elements":[{"id":"1"}]}\n',
        run,
      );
      await engine.writeAuthoredFile(join(root, "notes/plain.md"), "Plain after\n", run);

      const plan = await engine.planUndoAgentRun("run-scope");
      expect(plan.restorable.map((item) => [item.path, item.action])).toEqual([
        ["drawings/existing.excalidraw", "restore"],
        ["notes/plain.md", "restore"],
      ]);
      expect(plan.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["drawings/new.excalidraw", "drawing"],
        ["ledger/notes.md", "collection"],
        ["tasks/item-1.md", "collection"],
      ]);

      const undone = await engine.undoAgentRun("run-scope", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(undone.restored.map((item) => item.path)).toEqual([
        "drawings/existing.excalidraw",
        "notes/plain.md",
      ]);
      expect(await readDisk(root, "tasks/item-1.md")).toBe("# Task 1\n");
      expect(await readDisk(root, "ledger/notes.md")).toBe("Ledger note\n");
      expect(existsSync(join(root, "drawings/new.excalidraw"))).toBe(true);
      expect(await readDisk(root, "drawings/existing.excalidraw")).toBe(
        '{"type":"excalidraw","version":2,"elements":[]}\n',
      );
      expect(await readDisk(root, "notes/plain.md")).toBe("Plain before\n");
    } finally {
      await engine.stop();
    }
  });

  it("skips a deleted file when another file was later created and deleted at the same path", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-revive-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/replaced.md", "Original v1\n");
      await engine.flush();

      const run = agentAuthor("run-delete");
      await engine.changePathsAs(
        ["notes/replaced.md"],
        { operation: "delete", operationId: "op-delete-1", author: run },
        async (ops) => {
          await rm(join(root, "notes/replaced.md"));
          await ops.delete("notes/replaced.md");
        },
        () => ["notes/replaced.md"],
      );

      await engine.writeAuthoredFile(join(root, "notes/replaced.md"), "Different file\n", RESTORER);
      await engine.changePathsAs(
        ["notes/replaced.md"],
        { operation: "delete", operationId: "op-delete-2", author: RESTORER },
        async (ops) => {
          await rm(join(root, "notes/replaced.md"));
          await ops.delete("notes/replaced.md");
        },
        () => ["notes/replaced.md"],
      );

      const plan = await engine.planUndoAgentRun("run-delete");
      expect(plan.restorable).toEqual([]);
      expect(plan.skipped).toEqual([
        expect.objectContaining({ path: "notes/replaced.md", reason: "path-collision" }),
      ]);
      expect(existsSync(join(root, "notes/replaced.md"))).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("refuses to revive a deleted file if another file is created and deleted at that path after the scan", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-race-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/raced.md", "Original before\n");
      await engine.flush();

      const run = agentAuthor("run-race");
      await engine.changePathsAs(
        ["notes/raced.md"],
        { operation: "delete", operationId: "op-race-del-1", author: run },
        async (ops) => {
          await rm(join(root, "notes/raced.md"));
          await ops.delete("notes/raced.md");
        },
        () => ["notes/raced.md"],
      );

      const plan = await engine.planUndoAgentRun("run-race");
      expect(plan.restorable.map((item) => [item.path, item.action])).toEqual([
        ["notes/raced.md", "restore"],
      ]);

      const send = loopback.sendRequest.bind(loopback);
      let injected = false;
      let nextInjectId = 900_000;
      vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (
          !injected &&
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: string; origin?: string }).path === "notes/raced.md" &&
          (request.params as { origin?: string }).origin === "restore"
        ) {
          injected = true;
          // Simulate another object created and deleted right before the write transaction,
          // even with an earlier wall-clock timestamp and different casing.
          await send({
            id: nextInjectId++,
            method: VERSIONED_METHOD.textWrite,
            workspace: request.workspace,
            idempotencyKey: "race-create",
            params: {
              versionId: "main",
              path: "notes/Raced.md",
              text: "Interloper\n",
              origin: "local-file",
              summary: "Created interloper",
              nowMs: 1,
            },
          });
          await send({
            id: nextInjectId++,
            method: VERSIONED_METHOD.textDelete,
            workspace: request.workspace,
            idempotencyKey: "race-delete",
            params: {
              versionId: "main",
              path: "notes/Raced.md",
              origin: "local-file",
              summary: "Deleted interloper",
              nowMs: 2,
            },
          });
        }
        return send(request);
      });

      const undone = await engine.undoAgentRun("run-race", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(undone.restored).toEqual([]);
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: "notes/raced.md", reason: "path-collision" }),
      ]);
      expect(existsSync(join(root, "notes/raced.md"))).toBe(false);
    } finally {
      await engine.stop();
    }
  });

  it("rechecks hasOtherWindow before each file write and stops if another window opens mid-undo", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-window-race-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/a.md", "A before\n");
      await writeDisk(root, "notes/b.md", "B before\n");
      await engine.flush();

      const run = agentAuthor("run-window");
      await engine.writeAuthoredFile(join(root, "notes/a.md"), "A agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/b.md"), "B agent\n", run);

      const plan = await engine.planUndoAgentRun("run-window", {
        hasOtherWindow: () => false,
      });
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/a.md", "notes/b.md"]);

      let windowOpened = false;
      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        const result = await send(request);
        if (
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: string }).path === "notes/a.md"
        ) {
          windowOpened = true;
        }
        return result;
      });

      const undone = await engine.undoAgentRun("run-window", RESTORER, {
        expectedPlanToken: plan.planToken,
        hasOtherWindow: () => windowOpened,
      });
      expect(undone.restored.map((item) => item.path)).toEqual(["notes/a.md"]);
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: "notes/b.md", reason: "other-window" }),
      ]);
      expect(await readDisk(root, "notes/a.md")).toBe("A before\n");
      expect(await readDisk(root, "notes/b.md")).toBe("B agent\n");
    } finally {
      await engine.stop();
    }
  });

  it("recovers a restore that committed before disk publication failed, preserving request identity on retry", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-publish-retry-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/a.md", "A before\n");
      await writeDisk(root, "notes/b.md", "B before\n");
      await engine.flush();

      const run = agentAuthor("run-publish");
      await engine.writeAuthoredFile(join(root, "notes/a.md"), "A agent\n", run);
      await engine.writeAuthoredFile(join(root, "notes/b.md"), "B agent\n", run);

      const plan1 = await engine.planUndoAgentRun("run-publish");
      expect(plan1.restorable.map((item) => item.path)).toEqual(["notes/a.md", "notes/b.md"]);

      const send = loopback.sendRequest.bind(loopback);
      let failFirstPublish = true;
      let publicationLanded = false;
      const seenRestoreRequestIds: string[] = [];
      let committedRestoreMomentId: string | null = null;
      let committedRestoreResponse: Awaited<ReturnType<typeof send>> | null = null;
      const seenLocalFileWritesAfterCommit: string[] = [];
      const spy = vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (
          committedRestoreMomentId !== null &&
          !publicationLanded &&
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: string; origin?: string }).path === "notes/a.md" &&
          (request.params as { origin?: string }).origin === "local-file"
        ) {
          seenLocalFileWritesAfterCommit.push(
            (request.params as { summary?: string }).summary ?? "",
          );
          return {
            id: request.id,
            result: {
              ...(committedRestoreResponse?.result as Record<string, unknown>),
              deduped: true,
              materialized: false,
            },
          };
        }
        if (
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { path?: string; origin?: string }).path === "notes/a.md" &&
          (request.params as { origin?: string }).origin === "restore"
        ) {
          seenRestoreRequestIds.push(request.idempotencyKey ?? "");
          const response = await send(request);
          if (failFirstPublish) {
            failFirstPublish = false;
            committedRestoreResponse = response;
            const body = response.result as Record<string, unknown>;
            const moment = body.moment as { momentId: string };
            committedRestoreMomentId = moment.momentId;
            return {
              ...response,
              result: { ...body, materialized: false, materializeOutcome: "error" },
            };
          }
          publicationLanded = true;
          return response;
        }
        if (
          request.method === VERSIONED_METHOD.publicationApplied &&
          committedRestoreMomentId !== null &&
          (request.params as { momentId?: string }).momentId === committedRestoreMomentId
        ) {
          return { id: request.id, result: publicationLanded };
        }
        return send(request);
      });

      const attempt1 = await engine.undoAgentRun("run-publish", RESTORER, {
        expectedPlanToken: plan1.planToken,
      });
      expect(attempt1.restored.map((item) => item.path)).toEqual(["notes/b.md"]);
      expect(attempt1.failed.map((item) => item.path)).toEqual(["notes/a.md"]);
      expect(await readDisk(root, "notes/a.md")).toBe("A agent\n");
      expect(await readDisk(root, "notes/b.md")).toBe("B before\n");

      const plan2 = await engine.planUndoAgentRun("run-publish");
      expect(plan2.restorable.map((item) => item.path)).toEqual(["notes/a.md"]);
      expect(plan2.skipped).toEqual([
        expect.objectContaining({
          path: "notes/b.md",
          reason: "unchanged",
          detail: "Already undone by an earlier attempt.",
        }),
      ]);

      const attempt2 = await engine.undoAgentRun("run-publish", RESTORER, {
        expectedPlanToken: plan2.planToken,
      });
      expect(attempt2.failed).toEqual([]);
      expect(attempt2.restored.map((item) => item.path)).toEqual(["notes/a.md"]);
      expect(await readDisk(root, "notes/a.md")).toBe("A before\n");
      expect(seenRestoreRequestIds).toHaveLength(2);
      expect(seenRestoreRequestIds[0]).toBeTruthy();
      expect(seenRestoreRequestIds[1]).toBe(seenRestoreRequestIds[0]);
      expect(seenLocalFileWritesAfterCommit).not.toContain("Saved latest edits");

      const plan3 = await engine.planUndoAgentRun("run-publish");
      expect(plan3.restorable).toEqual([]);
      expect(plan3.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["notes/a.md", "unchanged"],
        ["notes/b.md", "unchanged"],
      ]);
      spy.mockRestore();
    } finally {
      await engine.stop();
    }
  });

  it("reports actual scannedChanges and caps restorable files at MAX_AGENT_RUN_UNDO_FILES (1,000)", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-limit-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      const total = 1002;
      const run = agentAuthor("run-many");
      const files = Array.from(
        { length: total },
        (_, index) => `batch/file-${String(index).padStart(4, "0")}.md`,
      );
      await mkdir(join(root, "batch"), { recursive: true });
      let id = 500_000;
      await Promise.all(
        files.map(async (rel) => {
          const text = `created ${rel}\n`;
          await writeFile(join(root, rel), text);
          await loopback.sendRequest({
            id: id++,
            method: VERSIONED_METHOD.textWrite,
            workspace: "agent-run-undo-test",
            idempotencyKey: `seed-${rel}`,
            params: {
              versionId: "main",
              path: rel,
              text,
              origin: "local-file",
              summary: "Created file",
              author: run,
            },
          });
        }),
      );

      const plan = await engine.planUndoAgentRun("run-many");
      expect(plan.scannedChanges).toBe(total);
      expect(plan.restorable).toHaveLength(1000);
      expect(plan.skipped).toHaveLength(2);
      expect(plan.skipped.map((item) => [item.path, item.reason])).toEqual([
        ["batch/file-1000.md", "batch-limit"],
        ["batch/file-1001.md", "batch-limit"],
      ]);
      expect(plan.skipped[0]?.detail).toContain("1,000");
      expect(plan.skipped[0]?.detail).toContain("1,002");
    } finally {
      await engine.stop();
    }
  });

  it("rechecks hasOtherWindow after the final pre-write await before sending a mutation RPC", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-window-final-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/guarded.md", "Before\n");
      await engine.flush();
      const run = agentAuthor("run-window-final");
      await engine.writeAuthoredFile(join(root, "notes/guarded.md"), "After\n", run);

      const plan = await engine.planUndoAgentRun("run-window-final", {
        hasOtherWindow: () => false,
      });
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/guarded.md"]);

      let windowOpened = false;
      let sawRestoreWriteRpc = false;
      const send = loopback.sendRequest.bind(loopback);
      vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { origin?: string }).origin === "restore"
        ) {
          sawRestoreWriteRpc = true;
        }
        const response = await send(request);
        if (
          request.method === VERSIONED_METHOD.momentsList &&
          (request.params as { objectId?: string }).objectId === undefined &&
          (request.params as { limit?: number }).limit === 200
        ) {
          // Flip right during the final pre-write collision scan inside restoreFileToBeforeMomentInQueue.
          if (seenScanCount++ >= 1) windowOpened = true;
        }
        return response;
      });
      let seenScanCount = 0;

      const undone = await engine.undoAgentRun("run-window-final", RESTORER, {
        expectedPlanToken: plan.planToken,
        hasOtherWindow: () => windowOpened,
      });
      expect(sawRestoreWriteRpc).toBe(false);
      expect(undone.restored).toEqual([]);
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: "notes/guarded.md", reason: "other-window" }),
      ]);
      expect(await readDisk(root, "notes/guarded.md")).toBe("After\n");
    } finally {
      await engine.stop();
    }
  });

  it("refuses undo when the same file is edited and reverted to identical bytes before the write RPC and scans moments with metadataOnly", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-same-bytes-race-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/reverted.md", "Before\n");
      await engine.flush();
      const run = agentAuthor("run-same-bytes");
      await engine.writeAuthoredFile(join(root, "notes/reverted.md"), "Agent\n", run);

      const seenMetadataOnlyFlags: Array<boolean | undefined> = [];
      const send = loopback.sendRequest.bind(loopback);
      let injected = false;
      const spy = vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (request.method === VERSIONED_METHOD.momentsList) {
          seenMetadataOnlyFlags.push((request.params as { metadataOnly?: boolean }).metadataOnly);
        }
        if (
          !injected &&
          request.method === VERSIONED_METHOD.textWrite &&
          (request.params as { origin?: string; path?: string }).origin === "restore" &&
          (request.params as { path?: string }).path === "notes/reverted.md"
        ) {
          injected = true;
          await send({
            id: 980_001,
            method: VERSIONED_METHOD.textWrite,
            workspace: request.workspace,
            idempotencyKey: "same-bytes-human-1",
            params: {
              versionId: "main",
              path: "notes/reverted.md",
              text: "Human intermediate\n",
              publish: true,
              origin: "local-file",
              summary: "Human edit",
            },
          });
          await send({
            id: 980_002,
            method: VERSIONED_METHOD.textWrite,
            workspace: request.workspace,
            idempotencyKey: "same-bytes-human-revert",
            params: {
              versionId: "main",
              path: "notes/reverted.md",
              text: "Agent\n",
              publish: true,
              origin: "local-file",
              summary: "Human reverted to identical bytes",
            },
          });
        }
        return send(request);
      });

      const plan = await engine.planUndoAgentRun("run-same-bytes");
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/reverted.md"]);
      expect(seenMetadataOnlyFlags.length).toBeGreaterThan(0);
      expect(seenMetadataOnlyFlags.every((flag) => flag === true)).toBe(true);

      const undone = await engine.undoAgentRun("run-same-bytes", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(undone.restored).toEqual([]);
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: "notes/reverted.md", reason: "later-edits" }),
      ]);
      expect(await readDisk(root, "notes/reverted.md")).toBe("Agent\n");
      spy.mockRestore();
    } finally {
      await engine.stop();
    }
  });

  it("skips secret-floor paths as protected and files.toml exclusions as untracked without restoring them on disk", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-secret-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/safe.md", "Safe before\n");
      await writeDisk(root, "notes/excluded.md", "Excluded before\n");
      await writeDisk(root, ".env", "API_KEY=after\n");
      await engine.flush();

      const run = agentAuthor("run-secret");
      await engine.writeAuthoredFile(join(root, "notes/safe.md"), "Safe after\n", run);
      await engine.writeAuthoredFile(join(root, "notes/excluded.md"), "Excluded after\n", run);
      await writeDisk(
        root,
        ".dohc/files.toml",
        '[[rule]]\npath = "notes/excluded.md"\ntracked = false\n',
      );

      const send = loopback.sendRequest.bind(loopback);
      let templateMoment: Record<string, unknown> | undefined;
      const secretMomentId = "m-secret-agent";
      const secretObjectId = "obj-secret-env";
      const makeSecretMoment = () => ({
        ...templateMoment!,
        momentId: secretMomentId,
        objectId: secretObjectId,
        path: ".env",
        momentOrder: 999_999,
      });
      const spy = vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (
          request.method === VERSIONED_METHOD.momentsGet &&
          (request.params as { momentId?: string }).momentId === secretMomentId
        ) {
          const safeGet = await send({
            ...request,
            params: { momentId: templateMoment!.momentId },
          });
          const safeMoment = (safeGet as { result: Record<string, unknown> }).result;
          return {
            id: request.id,
            result: {
              ...safeMoment,
              momentId: secretMomentId,
              objectId: secretObjectId,
              path: ".env",
              momentOrder: 999_999,
            },
          };
        }
        const response = await send(request);
        if (request.method === VERSIONED_METHOD.momentsList && "result" in response) {
          const result = response.result as {
            moments: Array<Record<string, unknown>>;
            nextBeforeMomentOrder: number | null;
          };
          const params = request.params as {
            objectId?: string | null;
            beforeMomentOrder?: number | null;
          };
          if (!templateMoment) {
            templateMoment = result.moments.find((row) => row.path === "notes/safe.md");
          }
          if (params.objectId === secretObjectId && templateMoment) {
            return {
              ...response,
              result: {
                moments: [makeSecretMoment()],
                nextBeforeMomentOrder: null,
                latestMomentOrder: 999_999,
              },
            };
          }
          if (params.objectId == null && params.beforeMomentOrder == null && templateMoment) {
            return {
              ...response,
              result: {
                ...result,
                moments: [makeSecretMoment(), ...result.moments],
              },
            };
          }
        }
        return response;
      });

      const plan = await engine.planUndoAgentRun("run-secret");
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/safe.md"]);
      expect(plan.skipped).toEqual([
        expect.objectContaining({ path: ".env", reason: "protected" }),
        expect.objectContaining({ path: "notes/excluded.md", reason: "untracked" }),
      ]);

      const undone = await engine.undoAgentRun("run-secret", RESTORER, {
        expectedPlanToken: plan.planToken,
      });
      expect(undone.restored.map((item) => item.path)).toEqual(["notes/safe.md"]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: ".env", reason: "protected" }),
        expect.objectContaining({ path: "notes/excluded.md", reason: "untracked" }),
      ]);
      expect(await readDisk(root, "notes/safe.md")).toBe("Safe before\n");
      expect(await readDisk(root, "notes/excluded.md")).toBe("Excluded after\n");
      expect(await readDisk(root, ".env")).toBe("API_KEY=after\n");
      spy.mockRestore();
    } finally {
      await engine.stop();
    }
  });

  it("rechecks hasOtherWindow inside runMutation after session acquisition and never emits Saved latest edits during undo", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-session-window-");
    const loopback = new VersionedLoopbackEngine();
    const workspaceId = "agent-run-undo-test";
    const sessions = mockDaemonSessions({ rootPath: root, workspaceId, loopback });
    let flipOnNextRun = false;
    let windowOpened = false;
    const rawRun = sessions.run.bind(sessions);
    vi.spyOn(sessions, "run").mockImplementation(async (workspace, operation, runOptions) => {
      return await rawRun(
        workspace,
        async (binding) => {
          if (flipOnNextRun) {
            flipOnNextRun = false;
            windowOpened = true;
          }
          return await operation(binding);
        },
        runOptions,
      );
    });
    const engine = createWorkspaceEngineCapture({
      workspaceId,
      rootPath: root,
      attachmentId: Symbol("agent-run-undo-session-window"),
      rustEngineSessions: sessions,
    });
    try {
      await writeDisk(root, "notes/guarded.md", "Before\n");
      await engine.flush();
      const run = agentAuthor("run-session-window");
      await engine.writeAuthoredFile(join(root, "notes/guarded.md"), "After\n", run);

      const plan = await engine.planUndoAgentRun("run-session-window", {
        hasOtherWindow: () => false,
      });
      expect(plan.restorable.map((item) => item.path)).toEqual(["notes/guarded.md"]);

      let sawTextWrite = false;
      let sawSavedLatestEdits = false;
      const send = loopback.sendRequest.bind(loopback);
      let scanCount = 0;
      vi.spyOn(loopback, "sendRequest").mockImplementation(async (request) => {
        if (request.method === VERSIONED_METHOD.textWrite) {
          sawTextWrite = true;
          if ((request.params as { summary?: string }).summary === "Saved latest edits") {
            sawSavedLatestEdits = true;
          }
        }
        const response = await send(request);
        if (
          request.method === VERSIONED_METHOD.momentsList &&
          (request.params as { objectId?: string }).objectId === undefined &&
          (request.params as { limit?: number }).limit === 200
        ) {
          // Arm flip right after the final pre-write collision scan, so sessions.run flips
          // windowOpened AFTER restoreFileToBeforeMomentInQueue's outer check but BEFORE beforeSend.
          if (scanCount++ >= 1) flipOnNextRun = true;
        }
        return response;
      });

      const undone = await engine.undoAgentRun("run-session-window", RESTORER, {
        expectedPlanToken: plan.planToken,
        hasOtherWindow: () => windowOpened,
      });
      expect(sawSavedLatestEdits).toBe(false);
      expect(sawTextWrite).toBe(false);
      expect(undone.restored).toEqual([]);
      expect(undone.failed).toEqual([]);
      expect(undone.skipped).toEqual([
        expect.objectContaining({ path: "notes/guarded.md", reason: "other-window" }),
      ]);
      expect(await readDisk(root, "notes/guarded.md")).toBe("After\n");
    } finally {
      await engine.stop();
    }
  });

  it("records agent-attributed CLI undos with Undid agent run summary", async () => {
    const root = await createTestScratch("dohc-agent-run-undo-cli-author-");
    const loopback = new VersionedLoopbackEngine();
    const engine = createCapture(root, loopback);
    try {
      await writeDisk(root, "notes/solo.md", "Before\n");
      await engine.flush();
      const run = agentAuthor("run-solo");
      await engine.writeAuthoredFile(join(root, "notes/solo.md"), "After\n", run);

      const plan = await engine.planUndoAgentRun("run-solo");
      const cliAuthor = {
        kind: "agent" as const,
        agentId: "dohc-mcp",
        onBehalfOf: "local-person",
      };
      const undone = await engine.undoAgentRun("run-solo", cliAuthor, {
        expectedPlanToken: plan.planToken,
      });
      expect(undone.restored).toHaveLength(1);
      expect(await readDisk(root, "notes/solo.md")).toBe("Before\n");

      const restoredMoment = await engine.readMoment(undone.restored[0]!.restoredMomentId);
      expect(restoredMoment?.protected).toBe(false);
      if (restoredMoment && !restoredMoment.protected) {
        expect(restoredMoment.moment.metadata.summary).toBe("Undid agent run");
        expect(restoredMoment.moment.authors).toEqual([cliAuthor]);
      }
    } finally {
      await engine.stop();
    }
  });
});
