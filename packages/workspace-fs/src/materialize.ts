import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import {
  assertSafeWorkspacePath,
  resolveWorkspacePath,
  sha256,
  type WorkspaceBackendMode,
  type WorkspaceManifest,
} from "./metadata";
import { writeManifest } from "./metadata";

export type MaterializeWorkspaceOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  targetDir: string;
  backendMode: WorkspaceBackendMode;
};

export async function materializeWorkspace({
  backend,
  actor,
  targetDir,
  backendMode,
}: MaterializeWorkspaceOptions): Promise<WorkspaceManifest> {
  const files = await backend.listFiles(actor);
  const manifest: WorkspaceManifest = {
    version: 1,
    workspaceId: actor.workspaceId,
    backend: backendMode,
    files: {},
  };

  for (const file of files) {
    const path = assertSafeWorkspacePath(file.path);
    const targetPath = resolveWorkspacePath(targetDir, path);
    await mkdir(dirname(targetPath), { recursive: true });

    if (file.kind === "atom") {
      const read = await backend.readText(actor, path);
      await writeFile(targetPath, read.body, "utf8");
      manifest.files[path] = {
        id: file.id,
        kind: file.kind,
        contentType: file.contentType,
        revision: read.revision,
        sha256: sha256(read.body),
      };
    } else {
      const read = await backend.readAsset(actor, path);
      await writeFile(targetPath, read.bytes);
      manifest.files[path] = {
        id: file.id,
        kind: file.kind,
        contentType: file.contentType,
        revision: read.revision,
        sha256: sha256(read.bytes),
      };
    }
  }

  await writeManifest(targetDir, manifest);
  return manifest;
}
