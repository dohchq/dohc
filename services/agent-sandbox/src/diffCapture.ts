import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import { applyFsDiff, scanWorkspaceDiff, type FsDiff } from "@dohc/workspace-fs";
import { sandboxApprovalFromError, type SandboxApprovalRequest } from "./approvals";
import { setSandboxStatus, type SandboxSession } from "./sandbox/session";

export type ApplyWorkspaceShellDiffOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  diff: FsDiff;
};

export type ApplyWorkspaceShellDiffResult = {
  applied: number;
  approvalRequests: SandboxApprovalRequest[];
};

export async function captureWorkspaceShellDiff(session: SandboxSession): Promise<FsDiff> {
  return await scanWorkspaceDiff(session.mountPath);
}

export async function applyWorkspaceShellDiff(
  session: SandboxSession,
  { backend, actor, diff }: ApplyWorkspaceShellDiffOptions,
): Promise<ApplyWorkspaceShellDiffResult> {
  setSandboxStatus(session, "applying");
  let applied = 0;
  const approvalRequests: SandboxApprovalRequest[] = [];

  for (const operation of diff.operations) {
    try {
      await applyFsDiff({
        backend,
        actor,
        rootDir: session.mountPath,
        diff: { operations: [operation] },
      });
      applied += 1;
    } catch (error) {
      const approval = sandboxApprovalFromError(error, operation);
      if (approval) {
        approvalRequests.push(approval);
        continue;
      }
      setSandboxStatus(session, "failed");
      throw error;
    }
  }

  setSandboxStatus(session, approvalRequests.length > 0 ? "running" : "complete");
  return { applied, approvalRequests };
}

export function discardWorkspaceShellDiff(session: SandboxSession): ApplyWorkspaceShellDiffResult {
  setSandboxStatus(session, "complete");
  return { applied: 0, approvalRequests: [] };
}
