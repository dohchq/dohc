import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { existingAncestor } from "./workspaceFiles";
import {
  RelayUnauthorizedError,
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewChangedPath,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// The receive side of a relay share (PR 18): a shared view is a local
// engine store fed EXCLUSIVELY by the share's filtered op log — no watcher,
// no capture, no push. This module owns the pull + disk materialization the
// openSharedView/refreshSharedView IPC handlers drive.

export type SharedViewRefreshStatus = "updated" | "unchanged" | "ended";

export interface RefreshSharedViewOutcome {
  status: SharedViewRefreshStatus;
  changedPaths: number;
}

/**
 * The selector the RELAY stated for a share, pinned locally the first time
 * this client could read it and enforced against every later pull (trust on
 * first use). The user never sees or chooses this scope — pinning only stops
 * the relay from restating a wider one on a later pull.
 */
export interface PinnedShareSelector {
  paths: string[];
  versionId: string | null;
}

/**
 * Raised when a refresh could not resolve the share's selector, so it did NOT
 * pull. An unscoped pull enforces no containment, which would hand a relay
 * able to INDUCE this failure the one pull it is not checked on.
 */
export class ShareScopeUnavailableError extends Error {
  constructor(readonly shareId: string) {
    super(`The scope of share ${shareId} could not be read from the relay.`);
    this.name = "ShareScopeUnavailableError";
  }
}

/** How one refresh resolves the share's pinned selector. */
export interface ShareScopeSource {
  /** What the local record holds. Anything malformed reads as absent. */
  recorded: unknown;
  /** Asked ONCE, and only when the record holds no usable selector. */
  fetch: () => Promise<PinnedShareSelector>;
  /** Pin a fetched selector so no later refresh has to ask again. */
  record: (selector: PinnedShareSelector) => void;
}

/**
 * A registry record is data, not a contract: read the selector back
 * defensively. Anything the relay could not have issued reads as absent,
 * which is repaired by the fetch below rather than passed to the engine.
 */
export function recordedShareSelector(
  value: unknown,
): PinnedShareSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as { paths?: unknown; versionId?: unknown };
  if (!Array.isArray(candidate.paths)) return null;
  if (!candidate.paths.every((path) => typeof path === "string")) return null;
  if (candidate.versionId !== null && typeof candidate.versionId !== "string") {
    return null;
  }
  // Selects nothing, by the relay's own rule: `validateShareSelector` refuses
  // to create a selector with neither a path nor a version, and
  // `pathVisibleThroughShare` serves nothing through one. A record holding it
  // is damage, not a grant — re-fetch rather than pull against it.
  if (candidate.paths.length === 0 && candidate.versionId === null) return null;
  return {
    paths: [...(candidate.paths as string[])],
    versionId: candidate.versionId,
  };
}

/**
 * Fetch-then-pin BEFORE the pull, never after: a record with no usable
 * selector gets one now, or this refresh does not pull at all.
 */
async function pinnedShareSelector(
  scope: ShareScopeSource,
  shareId: string,
): Promise<PinnedShareSelector> {
  const recorded = recordedShareSelector(scope.recorded);
  if (recorded !== null) return recorded;
  let fetched: PinnedShareSelector;
  try {
    fetched = await scope.fetch();
  } catch (error) {
    // A revoked share answers 404 here exactly as the pull would, and an
    // expired session must reach the handler that tells the user to sign in —
    // wrapping either one would report a share as quietly "unchanged" while
    // it is actually gone or locked out. Only an ordinary metadata failure
    // leaves the scope unknown.
    if (
      error instanceof ShareUnavailableError ||
      error instanceof RelayUnauthorizedError
    ) {
      throw error;
    }
    throw new ShareScopeUnavailableError(shareId);
  }
  scope.record(fetched);
  return fetched;
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
  store: CaptureVersionedTextStore,
): Promise<void> {
  if (changedPaths.length === 0) return;
  const realRoot = await realpath(rootDir);
  // REAL containment for the write, not just the lexical check above: a
  // symlink planted inside the materialized tree (a linked directory or a
  // link at the target path) must never redirect relay-controlled bytes
  // outside the root. The parent is realpath-verified after mkdir, and the
  // target itself is removed then recreated exclusively so a final-component
  // link is deleted, never followed (gpt-5.6-sol P1).
  async function preparedTarget(target: string): Promise<string> {
    // Containment BEFORE mkdir, not just after: a planted directory symlink
    // on the write path would otherwise have recursive mkdir create real
    // directories outside the projection before the post-check throws. The
    // deepest existing ancestor must already be inside the root.
    const realAncestor = await realpath(await existingAncestor(dirname(target)));
    if (realAncestor !== realRoot && !realAncestor.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Shared view parent escapes the workspace: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
    return target;
  }
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
      // recursive: a locally tampered DIRECTORY at the target must not
      // wedge the refresh with EISDIR. Node's rm removes a symlink as a
      // link either way — it never recurses through one.
      await rm(target, { recursive: true, force: true });
      continue;
    }
    // Read the content BEFORE touching the projection. `preparedTarget`
    // removes the existing file, so a read that throws after it would leave a
    // hole where a good file was — and with the cursor uncommitted, every
    // later refresh would replay into the same hole.
    const content =
      change.contentKind === "binary"
        ? await store.readBinaryFile({
            workspaceId,
            versionId: main.id,
            path: change.path,
          })
        : (
            await store.readTextFile({
              workspaceId,
              versionId: main.id,
              path: change.path,
            })
          )?.text ?? null;
    await preparedTarget(target);
    if (content === null) continue;
    await writeFile(
      target,
      content,
      typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" },
    );
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
  store: CaptureVersionedTextStore,
): Promise<number> {
  // A root that doesn't exist yet (first refresh materializes it) has
  // nothing to repair.
  const maybeRealRoot = await realpath(rootDir).catch(() => null);
  if (maybeRealRoot === null) return 0;
  const realRoot: string = maybeRealRoot;
  const containsReal = (candidate: string) =>
    candidate === realRoot || candidate.startsWith(`${realRoot}${sep}`);
  // Self-heal a tampered tree: remove the first symlinked component on the
  // path (AS A LINK — rm without recursive never follows) so the
  // re-materialization below can rebuild the real directory chain instead
  // of wedging on the containment guard.
  async function healTamperedAncestors(relativePath: string): Promise<void> {
    let current: string = realRoot;
    const segments = relativePath.split("/");
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!);
      const stat = await lstat(current).catch(() => null);
      if (stat === null) return; // chain ends — nothing deeper exists
      if (stat.isSymbolicLink()) {
        await rm(current, { force: true });
        return;
      }
      // An ANCESTOR that is not a directory (a file squatting on the path)
      // blocks mkdir the same way a symlink misroutes it — remove it so the
      // real chain can rebuild. The final component is the target itself;
      // preparedTarget removes and recreates that one.
      const isAncestor = index < segments.length - 1;
      if (isAncestor && !stat.isDirectory()) {
        await rm(current, { recursive: true, force: true });
        return;
      }
    }
  }
  const damaged: ShareViewChangedPath[] = [];
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
      // REAL-parent containment before trusting anything on disk: a
      // symlinked ancestor would redirect the read to attacker-controlled
      // bytes that could pass the hash compare (CodeRabbit). Then lstat
      // the leaf: a symlink is damage regardless of what it points at.
      const realParent = await realpath(dirname(target));
      if (containsReal(realParent)) {
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
      }
    } catch {
      intact = false; // missing or unreadable — re-materialize
    }
    if (!intact) {
      await healTamperedAncestors(snapshot.path);
      damaged.push({ path: snapshot.path, operation: "write", contentKind });
    }
  }
  if (damaged.length > 0) {
    await materializeSharedViewPaths(rootDir, workspaceId, damaged, store);
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
  // Required at the factory boundary: every rooted caller must explicitly
  // select its relay implementation, so no call can drift back to the legacy
  // TypeScript SQLite path.
  pull: (input: {
    rootDir: string;
    workspaceId: string;
    relay: SyncRelayConnection;
    shareId: string;
    grantedSelector: PinnedShareSelector;
  }) => Promise<PullShareViewResult>;
  // Required at the factory boundary for the same reason: every rooted caller
  // must explicitly select its store implementation.
  store: CaptureVersionedTextStore;
  // The scope this refresh enforces. Resolved BEFORE the pull, so no pull
  // ever runs unscoped.
  scope: ShareScopeSource;
}): Promise<RefreshSharedViewOutcome> {
  let grantedSelector: PinnedShareSelector;
  try {
    grantedSelector = await pinnedShareSelector(input.scope, input.shareId);
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      return { status: "ended", changedPaths: 0 };
    }
    throw error;
  }
  let pull;
  try {
    pull = await input.pull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: input.shareId,
      grantedSelector,
    });
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      return { status: "ended", changedPaths: 0 };
    }
    throw error;
  }
  await materializeSharedViewPaths(
    input.rootDir,
    input.workspaceId,
    pull.changedPaths,
    input.store,
  );
  await pull.commitCursor();
  return {
    status: pull.changedPaths.length > 0 ? "updated" : "unchanged",
    changedPaths: pull.changedPaths.length,
  };
}
