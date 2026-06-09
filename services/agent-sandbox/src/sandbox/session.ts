import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

export type SandboxBackendMode = "convex" | "postgres";

export type SandboxSessionStatus =
  | "starting"
  | "running"
  | "applying"
  | "complete"
  | "failed";

export type SandboxSession = {
  id: string;
  workspaceId: string;
  userId: string;
  backendMode: SandboxBackendMode;
  mountPath: string;
  cleanupDir?: string;
  status: SandboxSessionStatus;
};

export type CreateSandboxSessionInput = {
  workspaceId: string;
  userId: string;
  backendMode: SandboxBackendMode;
  mountPath: string;
  cleanupDir?: string;
  id?: string;
};

export function createSandboxSession({
  workspaceId,
  userId,
  backendMode,
  mountPath,
  cleanupDir,
  id = `sandbox_${randomUUID()}`,
}: CreateSandboxSessionInput): SandboxSession {
  return {
    id,
    workspaceId,
    userId,
    backendMode,
    mountPath,
    cleanupDir,
    status: "running",
  };
}

export function setSandboxStatus(session: SandboxSession, status: SandboxSessionStatus): SandboxSession {
  session.status = status;
  return session;
}

export function cleanupSandboxSession(session: SandboxSession): void {
  if (!session.cleanupDir) return;
  rmSync(session.cleanupDir, { recursive: true, force: true });
  session.cleanupDir = undefined;
}
