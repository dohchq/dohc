import { readManifest, type WorkspaceManifest } from "./metadata";
import { scanWorkspaceFiles } from "./scan";

export type FsDiffOperation =
  | { op: "create"; path: string; mediaType: string }
  | { op: "update"; path: string; expectedRevision: string }
  | { op: "delete"; path: string; expectedRevision: string }
  | {
      op: "rename";
      fromPath: string;
      toPath: string;
      expectedRevision: string;
    };

export type FsDiff = {
  operations: FsDiffOperation[];
};

export type ScannedWorkspaceDiff = FsDiff & {
  manifest: WorkspaceManifest;
};

export async function scanWorkspaceDiff(rootDir: string): Promise<ScannedWorkspaceDiff> {
  const manifest = await readManifest(rootDir);
  const diskFiles = await scanWorkspaceFiles(rootDir);
  const diskByPath = new Map(diskFiles.map((file) => [file.path, file]));
  const creates = diskFiles.filter((file) => !manifest.files[file.path]);
  const deletes = Object.entries(manifest.files)
    .filter(([path]) => !diskByPath.has(path))
    .map(([path, entry]) => ({
      op: "delete" as const,
      path,
      expectedRevision: entry.revision,
      sha256: entry.sha256,
    }));
  const updates = diskFiles
    .filter((file) => {
      const entry = manifest.files[file.path];
      return entry && entry.sha256 !== file.sha256;
    })
    .map((file) => ({
      op: "update" as const,
      path: file.path,
      expectedRevision: manifest.files[file.path]!.revision,
    }));

  const remainingCreates = [...creates];
  const remainingDeletes = [...deletes];
  const renames: Array<Extract<FsDiffOperation, { op: "rename" }>> = [];

  for (let deleteIndex = 0; deleteIndex < remainingDeletes.length; deleteIndex += 1) {
    const deleted = remainingDeletes[deleteIndex];
    if (!deleted.sha256) continue;
    const createIndex = remainingCreates.findIndex((created) => created.sha256 === deleted.sha256);
    if (createIndex < 0) continue;
    const [created] = remainingCreates.splice(createIndex, 1);
    remainingDeletes.splice(deleteIndex, 1);
    deleteIndex -= 1;
    renames.push({
      op: "rename",
      fromPath: deleted.path,
      toPath: created.path,
      expectedRevision: deleted.expectedRevision,
    });
  }

  return {
    manifest,
    operations: [
      ...updates.sort((a, b) => a.path.localeCompare(b.path)),
      ...renames.sort((a, b) => a.fromPath.localeCompare(b.fromPath)),
      ...remainingDeletes
        .map(({ op, path, expectedRevision }) => ({ op, path, expectedRevision }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      ...remainingCreates
        .map((file) => ({ op: "create" as const, path: file.path, mediaType: file.mediaType }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ],
  };
}
