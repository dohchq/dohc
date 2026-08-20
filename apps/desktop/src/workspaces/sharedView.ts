import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { existingAncestor } from "./workspaceFiles";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import {
  isShareAccessValue,
  isShareablePathList,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import type { ShareViewSelector } from "./shareViewInfo";
import {
  ShareUnavailableError,
  type PullShareViewResult,
  type ShareViewChangedPath,
  type ShareViewRefusal,
  type SyncRelayConnection,
} from "@dohc/workspace-contracts/relay";
import { shareViewTakesLocalWrites } from "./shareWriteGate";
import { withOrderedWorkspaceTextPath } from "./workspaceAssets";
import { readDiskContent, type DiskTextState } from "./workspaceEngineCapture";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// The receive side of a relay share (PR 18): a shared view is a local
// engine store fed EXCLUSIVELY by the share's filtered op log — no watcher,
// no capture, no push. This module owns the pull + disk materialization the
// openSharedView/refreshSharedView IPC handlers drive.

export type SharedViewRefreshStatus = "updated" | "unchanged" | "ended";

export interface RefreshSharedViewOutcome {
  status: SharedViewRefreshStatus;
  changedPaths: number;
  // Standalone refreshes always populate this. Direct refreshes do when the
  // caller supplies an exclusion set. Mount refreshes predate capture and
  // keep their existing outcome shape.
  excludedPaths?: string[];
  // Ops the pull refused. The pull skips them and keeps going, so without
  // this the view silently stops carrying part of what the granter shares.
  refusedOps: number;
  // The first refusal's message, for the UI. It names the constraint the op
  // broke; the whole list goes to the log.
  refusedDetail: string | null;
}

export interface CaptureSharedViewLocalDivergenceOutcome {
  capturedPaths: number;
  unjournalablePaths: string[];
}

/**
 * Raised when a share record carries no readable pinned selector, so the
 * refresh did NOT pull.
 *
 * The pin is part of the record contract: both accept paths resolve a
 * selector from the relay and write it with the record, so a record without
 * one is damaged. It is NOT repaired from the relay. Re-asking would let a
 * relay that can damage or race a record restate a wider selector and have
 * that become the pin — the exact widening the pin exists to stop. The way
 * back is the accept flow, which pins before the record exists.
 */
export class SharePinInvalidError extends Error {
  constructor(readonly shareId: string) {
    super(
      `Share ${shareId} has no readable pinned selector; ` +
        "its record is damaged and the share must be added again.",
    );
    this.name = "SharePinInvalidError";
  }
}

/**
 * A registry record is data, not a contract: read the pinned selector back
 * defensively, against the relay's OWN rules for the selector it issued.
 * Anything the relay could not have issued is damage and reads as null, which
 * fails the refresh closed rather than reaching the engine.
 *
 * The user never sees or chooses this scope. Pinning only stops the relay
 * from restating a wider one on a later pull.
 */
export function recordedShareSelector(
  value: unknown,
): ShareViewSelector | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as {
    paths?: unknown;
    versionId?: unknown;
    access?: unknown;
  };
  if (!Array.isArray(candidate.paths)) return null;
  // One rule, one place: a path the relay could not have issued (empty,
  // unnormalized, untracked, secret) must not read back as a granted one.
  if (!isShareablePathList(candidate.paths)) return null;
  // The version dimension decides whether a no-paths selector grants the whole
  // tracked workspace, so a version id the relay could not have issued ("",
  // " v1", or an unbounded one) must never read as one. Same rule, same place,
  // as the relay applies at creation.
  if (candidate.versionId !== null && !isValidShareVersionId(candidate.versionId)) {
    return null;
  }
  // Selects nothing, by the relay's own rule: `validateShareSelector` refuses
  // to create a selector with neither a path nor a version, and
  // `pathVisibleThroughShare` serves nothing through one.
  if (candidate.paths.length === 0 && candidate.versionId === null) return null;
  // The level is part of the pin (#646). A record whose level the relay could
  // not have issued is damaged the same way a bad version id is, and the
  // refresh fails closed rather than pulling at a level nobody granted.
  if (!isShareAccessValue(candidate.access)) return null;
  return {
    paths: [...(candidate.paths as string[])],
    versionId: isValidShareVersionId(candidate.versionId)
      ? candidate.versionId
      : null,
    access: candidate.access,
  };
}

/**
 * The selector to enroll this share view's sync identity with (#646 PR3-1),
 * or null when it must not enroll.
 *
 * A share view replicates through its SHARE, so it needs a sync identity of
 * its own before a local write can journal or a push can leave. This decides
 * whether to ask for one, and it fails closed on every tri-state — the same
 * guard sequence the chat push-back and the refresh already use:
 *
 * - no share view record, or the share has ended;
 * - a pinned grant this build cannot read completely (a damaged record);
 * - no dohc Cloud credentials;
 * - a session signed into a relay that is not this share's origin;
 * - a `view` share, which may push nothing, so it needs no identity and must
 *   not be given one.
 *
 * Returning null means SKIP, never fail. A share view that cannot enroll is
 * still readable, and its local writes stay local.
 */
export function shareViewIdentitySelector(input: {
  shareView:
    | {
        grantedSelector?: unknown;
        ended?: boolean;
        relayUrl?: string | null;
      }
    | null
    | undefined;
  relayUrl: string | null | undefined;
  relayUrlsMatch: (left: string, right: string) => boolean;
}): ShareViewSelector | null {
  const { shareView, relayUrl, relayUrlsMatch } = input;
  if (!shareView || shareView.ended === true) return null;
  const grantedSelector = recordedShareSelector(shareView.grantedSelector);
  if (!grantedSelector) return null;
  if (grantedSelector.access === "view") return null;
  if (!relayUrl) return null;
  if (shareView.relayUrl && !relayUrlsMatch(relayUrl, shareView.relayUrl)) {
    return null;
  }
  return grantedSelector;
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
    // A mount keeps its own engine store at <mount>/.dohc. Containment cannot
    // see that: an alias planted inside the projection (`docs -> .dohc`)
    // resolves inside the mount and would let relay-controlled bytes rewrite
    // the store that decides what the projection holds. The rule runs against
    // the MOUNT root, which is what `.dohc` means here.
    //
    // "entry" for BOTH operations, because neither follows the leaf: a delete
    // is `rm`, and a write removes the target and recreates it with `wx`. So
    // the leaf is never a path this code reads or writes through, and a
    // tampered one is the thing being repaired. Following it here would refuse
    // a projected file someone replaced with a dangling, escaping, or
    // reserved-target link, and the refresh would throw before it commits its
    // cursor -- wedging every later replay on the same path instead of
    // healing it. The PARENT chain still resolves in full, so an alias into a
    // reserved area is still refused.
    //
    // The prepare, the removal, and the write all run on the resolution this
    // judged. Reusing the spelling would let a directory alias planted after
    // the check take the relay's bytes somewhere the rule never saw.
    const { resolvedAbsolute: resolvedTarget } = await assertResolvedWorkspacePath({
      rootPath: rootDir,
      absolutePath: target,
      spelled: change.path,
      label: "Shared view path",
      access: "entry",
    });
    if (change.operation === "delete") {
      // Deletes get the same REAL-parent containment as writes: a planted
      // directory symlink must not route the unlink outside the root. The
      // final component is safe either way — rm without `recursive`
      // removes a link as a link, never through it.
      const realParent = await realpath(dirname(resolvedTarget)).catch(() => null);
      if (realParent === null) continue; // parent gone — nothing to delete
      if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`Shared view parent escapes the workspace: ${target}`);
      }
      // recursive: a locally tampered DIRECTORY at the target must not
      // wedge the refresh with EISDIR. Node's rm removes a symlink as a
      // link either way — it never recurses through one.
      await rm(resolvedTarget, { recursive: true, force: true });
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
    await preparedTarget(resolvedTarget);
    if (content === null) continue;
    await writeFile(
      resolvedTarget,
      content,
      typeof content === "string" ? { encoding: "utf8", flag: "wx" } : { flag: "wx" },
    );
  }
}

export async function writeDiskContentToStore(input: {
  store: CaptureVersionedTextStore;
  workspaceId: string;
  versionId: string;
  path: string;
  content: DiskTextState & { kind: "text" | "binary" };
}): Promise<void> {
  if (input.content.kind === "text") {
    await input.store.writeTextFile({
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      text: input.content.text,
      metadata: { origin: "local-file" },
    });
  } else {
    await input.store.writeBinaryFile({
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      bytes: input.content.bytes,
      metadata: { origin: "local-file" },
    });
  }
}

const CAPTURE_IGNORED_DIRS = new Set([".dohc", "node_modules", ".git"]);

async function captureDiskPaths(rootDir: string): Promise<Set<string>> {
  const found = new Set<string>();
  async function walk(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!CAPTURE_IGNORED_DIRS.has(entry.name)) {
          await walk(join(dir, entry.name), path);
        }
      } else if (entry.isFile()) {
        found.add(path);
      }
    }
  }
  await walk(rootDir, "");
  return found;
}

async function pathConfirmedAbsentOnDisk(
  rootDir: string,
  path: string,
): Promise<boolean> {
  try {
    await lstat(join(rootDir, path));
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

// Capture out-of-app modifications and deletes for paths the standalone share
// view already tracks. A hand-placed file belongs to the recipient and stays
// outside the journal. Comparing disk with the engine head avoids echoing
// in-app writes and prior materialization.
export async function captureSharedViewLocalDivergence(
  rootDir: string,
  workspaceId: string,
  store: CaptureVersionedTextStore,
): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const realRoot = await realpath(rootDir).catch(() => null);
  if (realRoot === null) return { capturedPaths: 0, unjournalablePaths: [] };

  const main = await store.ensureMainVersion({ workspaceId });
  if (!store.listTextFileMetadata) {
    throw new Error("Shared view reconciliation requires file metadata listing support.");
  }
  const tracked = await store.listTextFileMetadata({
    workspaceId,
    versionId: main.id,
  });
  const diskPaths = await captureDiskPaths(realRoot);

  let capturedPaths = 0;
  const unjournalablePaths: string[] = [];
  for (const entry of tracked) {
    if (classifyEngineFilePath(entry.path).kind === "secret") continue;
    if (
      !diskPaths.has(entry.path) &&
      !(await pathConfirmedAbsentOnDisk(realRoot, entry.path))
    ) {
      continue;
    }
    const result = await withOrderedWorkspaceTextPath(
      rootDir,
      entry.path,
      async (_readCurrent) => {
        if (!diskPaths.has(entry.path)) {
          if (!(await pathConfirmedAbsentOnDisk(realRoot, entry.path))) {
            return "unchanged" as const;
          }
          await store.deleteTextFile({
            workspaceId,
            versionId: main.id,
            path: entry.path,
            metadata: { origin: "local-file" },
          });
          return "captured" as const;
        }

        const disk = await readDiskContent(resolve(realRoot, entry.path));
        if (disk.kind === "absent") {
          if (!(await pathConfirmedAbsentOnDisk(realRoot, entry.path))) {
            return "unchanged" as const;
          }
          await store.deleteTextFile({
            workspaceId,
            versionId: main.id,
            path: entry.path,
            metadata: { origin: "local-file" },
          });
          return "captured" as const;
        }
        if (disk.kind === "untracked-content") {
          return "unjournalable" as const;
        }
        if (disk.kind !== "text" && disk.kind !== "binary") {
          return "unchanged" as const;
        }

        const changed =
          entry.contentKind !== disk.kind || entry.sha256 !== disk.sha256;
        if (!changed) return "unchanged" as const;

        const moment = await store.getMoment({
          workspaceId,
          momentId: entry.latestMomentId,
        });
        if (
          moment?.payload.before &&
          moment.payload.before.contentKind === disk.kind &&
          moment.payload.before.sha256 === disk.sha256
        ) {
          await materializeSharedViewPaths(
            rootDir,
            workspaceId,
            [{ path: entry.path, operation: "write", contentKind: entry.contentKind }],
            store,
          );
          return "unchanged" as const;
        }

        await writeDiskContentToStore({
          store,
          workspaceId,
          versionId: main.id,
          path: entry.path,
          content: disk,
        });
        return "captured" as const;
      },
    );
    if (typeof result === "object" && "status" in result) {
      if (!diskPaths.has(entry.path)) {
        if (await pathConfirmedAbsentOnDisk(realRoot, entry.path)) {
          await store.deleteTextFile({
            workspaceId,
            versionId: main.id,
            path: entry.path,
            metadata: { origin: "local-file" },
          });
          capturedPaths += 1;
        }
        continue;
      }
      throw new Error("unreachable: capture never reads through the ordered path");
    }
    if (result === "captured") capturedPaths += 1;
    if (result === "unjournalable") unjournalablePaths.push(entry.path);
  }

  return { capturedPaths, unjournalablePaths };
}

export async function captureStandaloneShareViewDivergence(input: {
  rootDir: string;
  workspaceId: string;
  store: CaptureVersionedTextStore;
  pinnedSelector: unknown;
  shareId: string;
}): Promise<CaptureSharedViewLocalDivergenceOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  if (!shareViewTakesLocalWrites({ access: grantedSelector.access, ended: false })) {
    return { capturedPaths: 0, unjournalablePaths: [] };
  }
  return captureSharedViewLocalDivergence(
    input.rootDir,
    input.workspaceId,
    input.store,
  );
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
    grantedSelector: ShareViewSelector;
    recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
  }) => Promise<PullShareViewResult>;
  // Required at the factory boundary for the same reason: every rooted caller
  // must explicitly select its store implementation.
  store: CaptureVersionedTextStore;
  // The scope this refresh enforces, exactly as the share record holds it.
  // Read BEFORE the pull and never repaired from the relay, so no pull ever
  // runs unscoped and no refresh can re-pin a wider selector.
  pinnedSelector: unknown;
  // Where a refused op is written down. Called before the cursor that skips
  // past it is committed, and idempotent by origin coordinate, because a
  // re-fetched page repeats refusals the record already holds.
  recordRefusals: (refusals: ShareViewRefusal[]) => Promise<void>;
  excludeFromMaterialization?: ReadonlySet<string>;
}): Promise<RefreshSharedViewOutcome> {
  const grantedSelector = recordedShareSelector(input.pinnedSelector);
  if (grantedSelector === null) throw new SharePinInvalidError(input.shareId);
  let pull;
  try {
    pull = await input.pull({
      rootDir: input.rootDir,
      workspaceId: input.workspaceId,
      relay: input.relay,
      shareId: input.shareId,
      grantedSelector,
      recordRefusals: input.recordRefusals,
    });
  } catch (error) {
    if (error instanceof ShareUnavailableError) {
      return {
        status: "ended",
        changedPaths: 0,
        ...(input.excludeFromMaterialization !== undefined
          ? { excludedPaths: [] }
          : {}),
        refusedOps: 0,
        refusedDetail: null,
      };
    }
    throw error;
  }
  const excludedPaths = pull.changedPaths
    .filter((change) => input.excludeFromMaterialization?.has(change.path))
    .map((change) => change.path);
  await materializeSharedViewPaths(
    input.rootDir,
    input.workspaceId,
    pull.changedPaths.filter(
      (change) => !input.excludeFromMaterialization?.has(change.path),
    ),
    input.store,
  );
  await pull.commitCursor();
  // Logged one line per refusal, because the count alone cannot be diagnosed.
  // The engine's message names the constraint, and for a version refusal its
  // limit, unit and observed usage.
  for (const refusal of pull.refusals) {
    console.error(
      `[desktop] share ${input.shareId} skipped ${refusal.opKind} ` +
        `${refusal.originId}@${refusal.originSeq} (${refusal.code}): ${refusal.detail}`,
    );
  }
  return {
    status: pull.changedPaths.length > 0 ? "updated" : "unchanged",
    changedPaths: pull.changedPaths.length,
    ...(input.excludeFromMaterialization !== undefined
      ? { excludedPaths }
      : {}),
    refusedOps: pull.refusalCount,
    refusedDetail: pull.refusals[0]?.detail ?? null,
  };
}

export async function refreshStandaloneShareViewOnce(
  input: Parameters<typeof refreshSharedViewOnce>[0],
): Promise<RefreshSharedViewOutcome> {
  const captured = await captureStandaloneShareViewDivergence(input);
  const outcome = await refreshSharedViewOnce({
    ...input,
    excludeFromMaterialization: new Set(captured.unjournalablePaths),
  });
  return {
    ...outcome,
    status:
      outcome.status === "unchanged" && captured.capturedPaths > 0
        ? "updated"
        : outcome.status,
    changedPaths: outcome.changedPaths + captured.capturedPaths,
  };
}
