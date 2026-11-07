import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createOwnedProjectionRepairer } from "./ownedProjectionRepair";
import type {
  ShareViewFiles,
  ShareViewFilesTarget,
  ShareViewProjectionStatus,
  ShareViewReconcileOutcome,
} from "./shareViewFiles";
import {
  withExclusiveWorkspaceOperation,
  withStaleSensitiveWorkspaceOperation,
} from "./workspaceAssets";

const target: ShareViewFilesTarget = {
  kind: "mount",
  workspaceId: "workspace-owner-test",
  shareId: "share-owner-test",
};

const validRepair: ShareViewReconcileOutcome = {
  kind: "repair",
  repairedPaths: 0,
  unjournalablePaths: [],
  failedPaths: [],
};

const damagedRecord = new Error("record unreadable");

function owner(input?: {
  statuses?: ShareViewProjectionStatus[];
  repair?: ShareViewReconcileOutcome | Error;
}) {
  const statuses = [...(input?.statuses ?? [{ state: "current" }, { state: "current" }])];
  const projectionStatus = vi.fn(async () => statuses.shift() ?? { state: "current" as const });
  const reconcile = vi.fn(async () => {
    if (input?.repair instanceof Error) throw input.repair;
    return input?.repair ?? validRepair;
  });
  return {
    files: { projectionStatus, reconcile } satisfies Pick<
      ShareViewFiles,
      "projectionStatus" | "reconcile"
    >,
    projectionStatus,
    reconcile,
  };
}

function ensureCurrent(
  files: Pick<ShareViewFiles, "projectionStatus" | "reconcile">,
  name: string,
) {
  return createOwnedProjectionRepairer(files)({
    rootPath: join(tmpdir(), name),
    target,
  });
}

describe("createOwnedProjectionRepairer", () => {
  it("repairs before returning even when the first status is current", async () => {
    const trace: string[] = [];
    const projectionStatus = vi.fn(async () => {
      trace.push("status");
      return { state: "current" as const };
    });
    const reconcile = vi.fn(async (_lease, _target, request) => {
      trace.push(`reconcile:${request}`);
      return validRepair;
    });

    await createOwnedProjectionRepairer({ projectionStatus, reconcile })({
      rootPath: join(tmpdir(), "dohc-owned-projection-current"),
      target,
    });

    expect(trace).toEqual(["status", "reconcile:repair", "status"]);
  });

  it("fails closed before repair when the owner is unavailable", async () => {
    const harness = owner({ statuses: [{ state: "unavailable" }] });

    await expect(
      ensureCurrent(harness.files, "dohc-owned-projection-unavailable"),
    ).rejects.toThrow(/share record is damaged/i);
    expect(harness.reconcile).not.toHaveBeenCalled();
  });

  it("refuses to return when repair does not make the projection current", async () => {
    const harness = owner({
      statuses: [
        {
          state: "pending",
          pendingPathCount: 1,
          pendingPaths: ["a.md"],
          collisionPathCount: 0,
          collisionPaths: [],
          pullInFlight: false,
        },
        {
          state: "pending",
          pendingPathCount: 1,
          pendingPaths: ["a.md"],
          collisionPathCount: 0,
          collisionPaths: [],
          pullInFlight: false,
        },
      ],
    });

    await expect(
      ensureCurrent(harness.files, "dohc-owned-projection-pending"),
    ).rejects.toThrow(/still being restored/i);
  });

  it("rejects an outcome from the wrong reconcile operation", async () => {
    const harness = owner({
      repair: {
        kind: "settle",
        capturedPaths: 0,
        repairedPaths: 0,
        unjournalablePaths: [],
      },
    });

    await expect(
      ensureCurrent(harness.files, "dohc-owned-projection-wrong-outcome"),
    ).rejects.toThrow(/invalid result/i);
  });

  it.each([
    {
      name: "a damaged collision record",
      repair: damagedRecord,
      refusal: /record unreadable/,
    },
    {
      name: "an unjournalable path",
      repair: {
        ...validRepair,
        unjournalablePaths: [
          { path: "large.md", reason: "oversized-text" as const },
        ],
      },
      refusal: /large\.md.*text limit/i,
    },
  ])("refuses $name", async ({ repair, refusal }) => {
    const harness = owner({ repair });
    await expect(
      ensureCurrent(
        harness.files,
        `dohc-owned-projection-${repair instanceof Error ? "damaged-record" : repair.kind}`,
      ),
    ).rejects.toThrow(refusal);
  });

  it("passes a refusal from repair through unchanged", async () => {
    const harness = owner({ repair: damagedRecord });
    await expect(ensureCurrent(harness.files, "dohc-damaged-repair")).rejects.toBe(damagedRecord);
    expect(harness.projectionStatus).toHaveBeenCalledOnce();
    const refusal = new Error("store unavailable");
    harness.reconcile.mockRejectedValue(refusal);
    await expect(ensureCurrent(harness.files, "dohc-unavailable-repair")).rejects.toBe(refusal);
  });

  it("waits for the workspace's exclusive lease before repairing", async () => {
    const rootPath = join(tmpdir(), "dohc-owned-projection-exclusive");
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      holderEntered = resolve;
    });
    const holding = withExclusiveWorkspaceOperation(rootPath, async () => {
      holderEntered();
      await holderReleased;
    });
    await entered;

    const projectionStatus = vi.fn(async () => ({ state: "current" as const }));
    const reconcile = vi.fn(async (lease, _target, request) => {
      expect(lease.rootPath).toBe(rootPath);
      expect(request).toBe("repair");
      return validRepair;
    });
    const repairing = createOwnedProjectionRepairer({
      projectionStatus,
      reconcile,
    })({ rootPath, target });

    await vi.waitFor(() => expect(projectionStatus).toHaveBeenCalledTimes(1));
    expect(reconcile).not.toHaveBeenCalled();
    releaseHolder();
    await holding;
    await repairing;
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  const pending: ShareViewProjectionStatus = {
    state: "pending",
    pendingPathCount: 1,
    pendingPaths: ["a.md"],
    collisionPathCount: 0,
    collisionPaths: [],
    pullInFlight: false,
  };

  it.each<{
    name: string;
    repair: ShareViewReconcileOutcome | Error;
    after?: ShareViewProjectionStatus | Error;
    writeLands?: boolean;
    refusal?: RegExp;
  }>([
    { name: "lets a write queued behind a no-op repair land", repair: validRepair, writeLands: true },
    { name: "refuses a write queued behind a repair that restored a path", repair: { ...validRepair, repairedPaths: 1 } },
    {
      name: "refuses a write queued behind a repair that found a damaged record",
      repair: damagedRecord,
      refusal: /record unreadable/,
    },
    {
      name: "refuses a write queued behind a repair that found an unjournalable path",
      repair: { ...validRepair, unjournalablePaths: [{ path: "large.md", reason: "oversized-text" }] },
      refusal: /large\.md/,
    },
    {
      name: "refuses a write queued behind a repair that left the projection pending",
      repair: validRepair,
      after: pending,
      refusal: /still being restored/i,
    },
    { name: "refuses a write queued behind a repair whose capture gave up on a path", repair: { ...validRepair, failedPaths: ["docs/a.md"] } },
    {
      name: "refuses a write queued behind a repair that left the projection unavailable",
      repair: validRepair,
      after: { state: "unavailable" },
      refusal: /still being restored/i,
    },
    {
      name: "refuses a write queued behind a repair whose status read failed",
      repair: validRepair,
      after: new Error("status unreadable"),
      refusal: /status unreadable/,
    },
    {
      name: "refuses a write queued behind an outcome from the wrong reconcile operation",
      repair: { kind: "settle", capturedPaths: 0, repairedPaths: 0, unjournalablePaths: [] },
      refusal: /invalid result/i,
    },
    {
      name: "refuses a write queued behind a repair outcome with no repaired-path count",
      repair: { kind: "repair", unjournalablePaths: [], failedPaths: [] } as unknown as ShareViewReconcileOutcome,
    },
    {
      name: "refuses a write queued behind a repair outcome with no failed-path list",
      repair: { kind: "repair", repairedPaths: 0, unjournalablePaths: [] } as unknown as ShareViewReconcileOutcome,
    },
    {
      name: "refuses a write queued behind a repair outcome with a field the check does not name",
      repair: { ...validRepair, restoredFromBackup: true } as ShareViewReconcileOutcome,
    },
    { name: "refuses a write queued behind a repair that failed", repair: new Error("disk full"), refusal: /disk full/ },
  ])("$name", async ({ name, repair, after = { state: "current" }, writeLands = false, refusal }) => {
    const rootPath = join(tmpdir(), `dohc-owned-projection-write-${name.replaceAll(" ", "-")}`);
    const statuses: Array<ShareViewProjectionStatus | Error> = [{ state: "current" }, after];
    let write: Promise<string> | undefined;
    const repairing = createOwnedProjectionRepairer({
      projectionStatus: vi.fn(async () => {
        const status = statuses.shift() ?? { state: "current" as const };
        if (status instanceof Error) throw status;
        return status;
      }),
      reconcile: vi.fn(async () => {
        // The write arrives while the repair holds the workspace, so it is
        // admitted before the repair ends and runs after it.
        write = withStaleSensitiveWorkspaceOperation(rootPath, async () => "written");
        if (repair instanceof Error) throw repair;
        return repair;
      }),
    })({ rootPath, target });

    if (refusal) await expect(repairing).rejects.toThrow(refusal);
    else await repairing;
    if (writeLands) await expect(write).resolves.toBe("written");
    else await expect(write).rejects.toThrow(/changed before this write started/);
  });
});
