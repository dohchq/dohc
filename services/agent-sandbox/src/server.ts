import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import { runWorkspaceShellCommand } from "./sandbox/commands";
import { createSandboxSession, type SandboxBackendMode, type SandboxSession } from "./sandbox/session";
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
  backendMode: SandboxBackendMode;
  rootDir?: string;
  sessionId?: string;
};

export async function startWorkspaceShellSession({
  backend,
  actor,
  backendMode,
  rootDir,
  sessionId,
}: StartWorkspaceShellSessionOptions): Promise<SandboxSession> {
  const mountPath = await mountWorkspaceFolder({
    backend,
    actor,
    backendMode,
    rootDir,
  });
  return createSandboxSession({
    id: sessionId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    backendMode,
    mountPath,
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
