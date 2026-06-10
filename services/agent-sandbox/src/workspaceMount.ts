import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import { materializeWorkspace } from "@dohc/workspace-fs";
import type { SandboxBackendMode } from "./sandbox/session";

export type WorkspaceMountOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  backendMode: SandboxBackendMode;
  rootDir?: string;
};

export type WorkspaceMount = {
  mountPath: string;
  cleanupDir?: string;
};

export async function mountWorkspaceFolder({
  backend,
  actor,
  backendMode,
  rootDir,
}: WorkspaceMountOptions): Promise<WorkspaceMount> {
  const baseDir = rootDir ?? await mkdtemp(join(tmpdir(), "dohc-agent-sandbox-"));
  const mountPath = await mkdtemp(join(baseDir, "mount-"));
  await materializeWorkspace({
    backend,
    actor,
    targetDir: mountPath,
    backendMode,
  });
  return { mountPath, cleanupDir: rootDir ? undefined : baseDir };
}
