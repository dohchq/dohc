import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  ShareUnavailableError,
  createVersionedTextStore,
  pullShareView,
  type ShareViewChangedPath,
  type SyncRelayConnection,
} from "@dohc/workspace-engine";

// The receive side of a relay share (PR 18): a shared view is a local
// engine store fed EXCLUSIVELY by the share's filtered op log — no watcher,
// no capture, no push. This module owns the pull + disk materialization the
// openSharedView/refreshSharedView IPC handlers drive.

export type SharedViewRefreshStatus = "updated" | "unchanged" | "ended";

export interface RefreshSharedViewOutcome {
  status: SharedViewRefreshStatus;
  changedPaths: number;
}

// Containment before any disk write: the engine already restricts paths to
// validated workspace-relative ones, but a defense layer this close to
// fs writes is cheap and permanent.
function containedTarget(rootDir: string, relativePath: string): string {
  const target = resolve(rootDir, relativePath);
  const root = resolve(rootDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Shared view path escapes the workspace: ${relativePath}`);
  }
  return target;
}

export async function materializeSharedViewPaths(
  rootDir: string,
  workspaceId: string,
  changedPaths: readonly ShareViewChangedPath[],
): Promise<void> {
  if (changedPaths.length === 0) return;
  const store = createVersionedTextStore(rootDir);
  try {
    const main = await store.ensureMainVersion({ workspaceId });
    for (const change of changedPaths) {
      const target = containedTarget(rootDir, change.path);
      if (change.operation === "delete") {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      if (change.contentKind === "binary") {
        const bytes = await store.readBinaryFile({
          workspaceId,
          versionId: main.id,
          path: change.path,
        });
        if (bytes) await writeFile(target, bytes);
        continue;
      }
      const snapshot = await store.readTextFile({
        workspaceId,
        versionId: main.id,
        path: change.path,
      });
      if (snapshot) await writeFile(target, snapshot.text, "utf8");
    }
  } finally {
    await store.close();
  }
}

// One refresh pass: pull the share's filtered ops into the local store,
// materialize what changed, then commit the cursor. Revocation (or a share
// that stopped existing for this account) comes back as status "ended" —
// the local files are left exactly as they were.
export async function refreshSharedViewOnce(input: {
  rootDir: string;
  workspaceId: string;
  relay: SyncRelayConnection;
  shareId: string;
}): Promise<RefreshSharedViewOutcome> {
  let pull;
  try {
    pull = await pullShareView({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: input.shareId,
    });
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      return { status: "ended", changedPaths: 0 };
    }
    throw error;
  }
  await materializeSharedViewPaths(input.rootDir, input.workspaceId, pull.changedPaths);
  await pull.commitCursor();
  return {
    status: pull.changedPaths.length > 0 ? "updated" : "unchanged",
    changedPaths: pull.changedPaths.length,
  };
}
