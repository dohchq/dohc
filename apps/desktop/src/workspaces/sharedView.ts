import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  const realRoot = await realpath(rootDir);
  // REAL containment for the write, not just the lexical check above: a
  // symlink planted inside the materialized tree (a linked directory or a
  // link at the target path) must never redirect relay-controlled bytes
  // outside the root. The parent is realpath-verified after mkdir, and the
  // target itself is removed then recreated exclusively so a final-component
  // link is deleted, never followed (gpt-5.6-sol P1).
  async function preparedTarget(target: string): Promise<string> {
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await rm(target, { force: true });
    return target;
  }
  try {
    const main = await store.ensureMainVersion({ workspaceId });
    for (const change of changedPaths) {
      const target = containedTarget(rootDir, change.path);
      if (change.operation === "delete") {
        // Deletes get the same REAL-parent containment as writes: a planted
        // directory symlink must not route the unlink outside the root. The
        // final component is safe either way — rm without `recursive`
        // removes a link as a link, never through it.
        const realParent = await realpath(dirname(target)).catch(() => null);
        if (realParent === null) continue; // parent gone — nothing to delete
        if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
          throw new Error(`Shared view parent escapes the workspace: ${target}`);
        }
        await rm(target, { force: true });
        continue;
      }
      await preparedTarget(target);
      if (change.contentKind === "binary") {
        const bytes = await store.readBinaryFile({
          workspaceId,
          versionId: main.id,
          path: change.path,
        });
        if (bytes) await writeFile(target, bytes, { flag: "wx" });
        continue;
      }
      const snapshot = await store.readTextFile({
        workspaceId,
        versionId: main.id,
        path: change.path,
      });
      if (snapshot) await writeFile(target, snapshot.text, { encoding: "utf8", flag: "wx" });
    }
  } finally {
    await store.close();
  }
}

// Verify the materialized projection against the local store and repair any
// drift. The pull only replays NEW relay deltas, so a mounted file modified
// or deleted locally (a rogue tool writing straight to disk — every dohc
// surface refuses) would otherwise persist while refreshes report
// "unchanged", breaking the read-only live-copy contract. Returns how many
// paths were re-materialized. Local ADDITIONS are left alone: they are
// indistinguishable from user data and harmless to the projection contract.
export async function repairSharedViewProjection(
  rootDir: string,
  workspaceId: string,
): Promise<number> {
  const store = createVersionedTextStore(rootDir);
  let damaged: ShareViewChangedPath[] = [];
  try {
    const main = await store.ensureMainVersion({ workspaceId });
    const snapshots = await store.listTextFiles({
      workspaceId,
      versionId: main.id,
    });
    for (const snapshot of snapshots) {
      const target = containedTarget(rootDir, snapshot.path);
      const contentKind = snapshot.contentKind === "binary" ? "binary" : "text";
      let intact = false;
      try {
        // lstat first: a symlink is damage regardless of what it points at.
        const stat = await lstat(target);
        if (stat.isFile()) {
          const bytes = await readFile(target);
          if (typeof snapshot.sha256 === "string" && snapshot.sha256.length > 0) {
            intact =
              createHash("sha256").update(bytes).digest("hex") === snapshot.sha256;
          } else {
            intact = bytes.toString("utf8") === snapshot.text;
          }
        }
      } catch {
        intact = false; // missing or unreadable — re-materialize
      }
      if (!intact) {
        damaged.push({ path: snapshot.path, operation: "write", contentKind });
      }
    }
  } finally {
    await store.close();
  }
  if (damaged.length > 0) {
    await materializeSharedViewPaths(rootDir, workspaceId, damaged);
  }
  return damaged.length;
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
