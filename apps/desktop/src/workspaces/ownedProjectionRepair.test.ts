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
import { withExclusiveWorkspaceOperation } from "./workspaceAssets";

const target: ShareViewFilesTarget = {
  kind: "mount",
  workspaceId: "workspace-owner-test",
  shareId: "share-owner-test",
};

const validRepair: ShareViewReconcileOutcome = {
  kind: "repair",
  repairedPaths: 0,
  unjournalablePaths: [],
  collisionRecordQuarantined: false,
};

function owner(input?: {
  statuses?: ShareViewProjectionStatus[];
  repair?: ShareViewReconcileOutcome;
}) {
  const statuses = [...(input?.statuses ?? [{ state: "current" }, { state: "current" }])];
  const projectionStatus = vi.fn(async () => statuses.shift() ?? { state: "current" as const });
  const reconcile = vi.fn(async () => input?.repair ?? validRepair);
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
        collisionRecordQuarantined: false,
      },
    });

    await expect(
      ensureCurrent(harness.files, "dohc-owned-projection-wrong-outcome"),
    ).rejects.toThrow(/invalid result/i);
  });

  it.each([
    {
      name: "a quarantined collision record",
      repair: { ...validRepair, collisionRecordQuarantined: true },
      refusal: /damaged shared file recovery record/i,
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
        `dohc-owned-projection-${repair.kind}`,
      ),
    ).rejects.toThrow(refusal);
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
});
