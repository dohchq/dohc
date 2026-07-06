import type {
  VersionFileChange,
  VersionFileChangeStatus,
} from "@dohc/workspace-contracts/engine";
import type {
  VersionId,
  VersionedTextStore,
  WorkspaceId,
} from "./versionedTextStore";

// UI-facing whole-version comparison (PR 0M-4). The per-file three-way
// comparison (compareTextFileVersions) answers "how do these sides relate for
// ONE path"; this composes the store's snapshot listings into the shape the
// product surface needs: every path that differs between two versions, with
// a plain added/modified/deleted status and both texts for diffing.
//
// Status reads from the SOURCE version's perspective against the TARGET
// (product framing: "what does this Version change relative to Main"):
//   - added:    the path exists only in the source version.
//   - deleted:  the path exists only in the target version.
//   - modified: both versions have the path with different text.
// Identical paths are omitted — an empty result means "no differences".

export type {
  VersionFileChange,
  VersionFileChangeStatus,
} from "@dohc/workspace-contracts/engine";

export async function compareVersionFiles(
  store: VersionedTextStore,
  input: {
    workspaceId: WorkspaceId;
    sourceVersionId: VersionId;
    targetVersionId: VersionId;
  },
): Promise<VersionFileChange[]> {
  const [targetFiles, sourceFiles] = await Promise.all([
    store.listTextFiles({
      workspaceId: input.workspaceId,
      versionId: input.targetVersionId,
    }),
    store.listTextFiles({
      workspaceId: input.workspaceId,
      versionId: input.sourceVersionId,
    }),
  ]);

  const targetByPath = new Map(targetFiles.map((file) => [file.path, file]));
  const sourceByPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...targetByPath.keys(), ...sourceByPath.keys()])].sort();

  const changes: VersionFileChange[] = [];
  for (const path of paths) {
    const target = targetByPath.get(path);
    const source = sourceByPath.get(path);
    if (target && source) {
      const targetKind = target.contentKind ?? "text";
      const sourceKind = source.contentKind ?? "text";
      const same =
        targetKind === sourceKind &&
        (targetKind === "binary" ? target.sha256 === source.sha256 : target.text === source.text);
      if (!same) {
        changes.push({
          path,
          status: "modified",
          ...(targetKind === "binary" || sourceKind === "binary"
            ? { binary: true }
            : { currentText: target.text, incomingText: source.text }),
        });
      }
      continue;
    }
    if (source) {
      changes.push(
        (source.contentKind ?? "text") === "binary"
          ? { path, status: "added", binary: true }
          : { path, status: "added", incomingText: source.text },
      );
      continue;
    }
    if (target) {
      changes.push(
        (target.contentKind ?? "text") === "binary"
          ? { path, status: "deleted", binary: true }
          : { path, status: "deleted", currentText: target.text },
      );
    }
  }
  return changes;
}
