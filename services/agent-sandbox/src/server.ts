import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import { runWorkspaceShellCommand } from "./sandbox/commands";
import { createSandboxSession, type SandboxSession } from "./sandbox/session";
import { mountWorkspaceFolder } from "./workspaceMount";
import {
  applyWorkspaceShellDiff,
  captureWorkspaceShellDiff,
  discardWorkspaceShellDiff,
} from "./diffCapture";

export { runWorkspaceShellCommand };
export {
  applyWorkspaceShellDiff,
  captureWorkspaceShellDiff,
  discardWorkspaceShellDiff,
};
export type { SandboxSession };

export type StartWorkspaceShellSessionOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  rootDir?: string;
  sessionId?: string;
};

export async function startWorkspaceShellSession({
  backend,
  actor,
  rootDir,
  sessionId,
}: StartWorkspaceShellSessionOptions): Promise<SandboxSession> {
  const mount = await mountWorkspaceFolder({
    backend,
    actor,
    rootDir,
  });
  return createSandboxSession({
    id: sessionId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    mountPath: mount.mountPath,
    cleanupDir: mount.cleanupDir,
  });
}

export function createAgentSandboxService() {
  return {
    startWorkspaceShellSession,
    runWorkspaceShellCommand,
    captureWorkspaceShellDiff,
    applyWorkspaceShellDiff,
    discardWorkspaceShellDiff,
  };
}
