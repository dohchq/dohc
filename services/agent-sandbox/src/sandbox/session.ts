import { randomUUID } from "node:crypto";

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
  status: SandboxSessionStatus;
};

export type CreateSandboxSessionInput = {
  workspaceId: string;
  userId: string;
  backendMode: SandboxBackendMode;
  mountPath: string;
  id?: string;
};

export function createSandboxSession({
  workspaceId,
  userId,
  backendMode,
  mountPath,
  id = `sandbox_${randomUUID()}`,
}: CreateSandboxSessionInput): SandboxSession {
  return {
    id,
    workspaceId,
    userId,
    backendMode,
    mountPath,
    status: "running",
  };
}

export function setSandboxStatus(session: SandboxSession, status: SandboxSessionStatus): SandboxSession {
  session.status = status;
  return session;
}
