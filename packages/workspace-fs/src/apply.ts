import { readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import type { Actor, WorkspaceBackend } from "@dohc/workspace-contracts";
import type { FsDiff } from "./diff";
import {
  assertSafeWorkspacePath,
  assetKindForMediaType,
  atomKindForMediaType,
  isTextMediaType,
  mediaTypeForPath,
  readManifest,
  resolveWorkspacePath,
} from "./metadata";

export type ApplyFsDiffOptions = {
  backend: WorkspaceBackend;
  actor: Actor;
  rootDir: string;
  diff: FsDiff;
};

export async function applyFsDiff({
  backend,
  actor,
  rootDir,
  diff,
}: ApplyFsDiffOptions): Promise<void> {
  const manifest = await readManifest(rootDir);
  for (const operation of diff.operations) {
    if (operation.op === "create") {
      const path = assertSafeWorkspacePath(operation.path);
      const bytes = await readFile(resolveWorkspacePath(rootDir, path));
      const mediaType = operation.mediaType || mediaTypeForPath(path);
      if (isTextMediaType(mediaType, path)) {
        await backend.createAtom(actor, {
          path,
          kind: atomKindForMediaType(mediaType, path),
          body: new TextDecoder().decode(bytes),
        });
      } else {
        await backend.saveAsset(actor, {
          path,
          kind: assetKindForMediaType(mediaType, path),
          mediaType,
          bytes,
        });
      }
    } else if (operation.op === "update") {
      const path = assertSafeWorkspacePath(operation.path);
      const entry = manifest.files[path];
      if (!entry) throw new Error(`manifest entry not found: ${path}`);
      const bytes = await readFile(resolveWorkspacePath(rootDir, path));
      if (entry.kind === "atom" && isTextMediaType(entry.contentType, path)) {
        await backend.writeAtom(actor, {
          path,
          expectedRevision: operation.expectedRevision,
          body: new TextDecoder().decode(bytes),
        });
      } else {
        // Binary UPDATE goes to updateAsset (saveAsset is create-only) so the
        // expectedRevision arbitrates instead of silently overwriting.
        await backend.updateAsset(actor, {
          path,
          expectedRevision: operation.expectedRevision,
          kind: assetKindForMediaType(entry.contentType, path),
          mediaType: entry.contentType,
          bytes,
        });
      }
    } else if (operation.op === "delete") {
      await backend.deleteFile(
        actor,
        assertSafeWorkspacePath(operation.path),
        operation.expectedRevision,
      );
    } else {
      const fromPath = assertSafeWorkspacePath(operation.fromPath);
      const toPath = assertSafeWorkspacePath(operation.toPath);
      if (dirname(fromPath) !== dirname(toPath)) {
        throw new Error("cross-folder renames are not supported by this backend contract yet");
      }
      await backend.renameFile(actor, {
        fromPath,
        toName: basename(toPath),
        expectedRevision: operation.expectedRevision,
      });
    }
  }
}
