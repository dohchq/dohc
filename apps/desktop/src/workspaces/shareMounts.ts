import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";
import { isInside } from "../security/pathContainment";
// See the note in workspaceGraph.ts: the path floor is a cross-process security
// contract with a Rust twin, not engine state. SyncRelayConnection stays on the
// oracle -- that one IS engine surface and migrates with the relay work.
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { ShareMountRecord } from "./registryStore";
import type { ShareViewSelector } from "./shareViewInfo";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { ShareMountStatusRow } from "../ipc/bridgeContract";
import {
  SharePinInvalidError,
  refreshSharedViewOnce,
  repairSharedViewProjection,
  type RefreshSharedViewOutcome,
} from "./sharedView";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

// Share mounts: the receive side of a relay share materialized INSIDE a host
// workspace as shared-with-me/<label>/ — ordinary read-only files the user's
// agent reads with normal tools — instead of (or alongside) the standalone
// shared-view window. Each mount is its own pull target: the nested
// <mount>/.dohc/engine/engine.db holds the share's replayed op log and fetch
// cursor, and is invisible to the host (`.dohc` is ignored at any depth).
// The host's own capture/search/relay-push already exclude shared-with-me
// via the effective-policy floor, so mounted content can never leak into the
// host's history or its synced copy.
//
// Everything here trusts its caller (main) for authorization: the host
// workspace is resolved via requireWorkspace and the relay connection is
// built from the machine's own credentials — never from renderer input.

// Folder-name budget for a mount label; generous but bounded (labels become
// one path component under shared-with-me/).
const MOUNT_LABEL_MAX = 64;

// A mount label must be exactly one safe path segment. The registry file is
// data, not a write path into the tree — labels are re-validated on every
// use so an edited registry cannot smuggle traversal into materialization.
export function validMountLabel(label: string): boolean {
  if (label.length === 0 || label.length > MOUNT_LABEL_MAX) return false;
  const validated = validateUserWritePath(label);
  // A secret-shaped label (".env", "prod.env") would have the read
  // classifier taint the whole mount — suppressed from search/graph/export
  // and denied to agents — so such labels are invalid by construction.
  if (classifyEngineFilePath(label).kind === "secret") return false;
  return validated.ok && validated.normalized === label && !label.includes("/");
}

// Derive a mount label from the granter: the email local part reduced to a
// conservative charset, deduplicated against existing labels the same way
// imports deduplicate basenames ("alex", "alex (2)", …).
export function mountLabelFor(
  granterEmail: string | null,
  existingLabels: readonly string[],
): string {
  const localPart = (granterEmail ?? "").split("@")[0] ?? "";
  let base =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, MOUNT_LABEL_MAX - 8) || "share";
  // "prod.env@example.com" must not produce a secret-shaped label that the
  // read classifier would suppress: rewrite dots until the shape is safe.
  if (classifyEngineFilePath(base).kind === "secret") {
    base = base.replaceAll(".", "-");
  }
  if (classifyEngineFilePath(base).kind === "secret") base = "share";
  const taken = new Set(existingLabels.map((label) => label.toLowerCase()));
  if (!taken.has(base) && validMountLabel(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${base} (${attempt})`;
    if (!taken.has(candidate) && validMountLabel(candidate)) return candidate;
  }
}

export function mountRootFor(hostRoot: string, label: string): string {
  if (!validMountLabel(label)) {
    throw new Error(`Invalid share mount label: ${label}`);
  }
  const target = resolve(join(hostRoot, SHARED_WITH_ME_FOLDER, label));
  const container = resolve(join(hostRoot, SHARED_WITH_ME_FOLDER));
  // Containment sandwich even though validMountLabel already refused
  // separators/traversal — this is the last hop before fs operations.
  if (!isInside(container, target)) {
    throw new Error(`Share mount escapes shared-with-me: ${label}`);
  }
  if (target === container) {
    throw new Error(`Share mount label resolves to shared-with-me itself: ${label}`);
  }
  return target;
}

// The REAL-path guard the lexical check above cannot give: refuses a
// symlinked shared-with-me or label directory (at either component) before
// any materialization. A refresh writes relay-controlled bytes, so a link
// planted at either level must never redirect those writes outside the
// workspace (gpt-5.6-sol P1). The workspace root itself is realpath'd first,
// so ancestor system symlinks above the workspace stay legal.
async function assertRealMountRoot(hostRoot: string, label: string): Promise<void> {
  const realHost = await realpath(hostRoot);
  for (const relative of [
    SHARED_WITH_ME_FOLDER,
    `${SHARED_WITH_ME_FOLDER}/${label}`,
  ]) {
    const absolute = join(realHost, ...relative.split("/"));
    const stat = await lstat(absolute).catch(() => null);
    if (stat === null) continue; // not created yet — mkdir will make a real dir
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Share mount path is not a real directory: ${relative}`);
    }
  }
}

// Creates the mount directory, guarding the container FIRST: a symlinked
// shared-with-me must be refused before mkdir would follow it and create the
// label outside the workspace (codex P2 — the refresh guard alone ran after
// this write). The label directory itself is created EXCLUSIVELY: a mount
// only ever owns a directory it created — a leftover or hand-made folder
// must never be adopted (pulls would overwrite it; rollback/unmount would
// delete it).
export async function createMountDirectory(
  hostRoot: string,
  label: string,
): Promise<void> {
  const rootDir = mountRootFor(hostRoot, label);
  await assertRealMountRoot(hostRoot, label);
  const container = join(await realpath(hostRoot), SHARED_WITH_ME_FOLDER);
  await mkdir(container, { recursive: true });
  await mkdir(rootDir); // NOT recursive: EEXIST refuses adoption
}

// A mount needs file content to follow. A null selector is a different grant
// kind (a chat-channel share, which carries no file selector at all) and must
// be joined from Chats, not mounted as an (empty) folder. An unreadable
// selector never reaches here — `fetchShareViewInfo` refuses it outright,
// because softening one into "grants everything" is exactly the widening this
// containment exists to stop.
export function assertMountableSelector(
  selector: ShareViewSelector | null,
): asserts selector is ShareViewSelector {
  if (selector === null) {
    throw new Error(
      "This code is for a shared chat channel — join it from Chats instead of mounting it.",
    );
  }
}

// The store-scoping workspace id inside the mount's own nested engine.db.
// Purely local and deterministic; it never leaves the machine.
//
// It MUST include the host: daemon sessions and relay routes are keyed by
// workspace id alone, and `EngineWorkspaceSessions` hands back a cached
// binding without comparing rootPath. Two host workspaces mounting the SAME
// share would otherwise collide on one session and one route — the second
// refresh reusing a connection bound to the first host's mount folder.
//
// The host is a fixed-width digest rather than a raw id, so the pair is
// unambiguous: concatenating two opaque ids with a separator lets
// ("host-a", "s") and ("host", "a-s") produce the same string.
function hostDigest(hostWorkspaceId: string): string {
  return createHash("sha256").update(hostWorkspaceId).digest("hex").slice(0, 16);
}

export function mountStoreWorkspaceIdFor(
  hostWorkspaceId: string,
  shareId: string,
): string {
  return `share-mount-${shareId}-${hostDigest(hostWorkspaceId)}`;
}

export function relayTargetForShareMount(
  hostWorkspaceId: string,
  hostRoot: string,
  mount: Pick<ShareMountRecord, "shareId" | "label">,
): { workspaceId: string; rootPath: string; shareMount: true } {
  return {
    workspaceId: mountStoreWorkspaceIdFor(hostWorkspaceId, mount.shareId),
    rootPath: mountRootFor(hostRoot, mount.label),
    shareMount: true,
  };
}

/**
 * One refresh result row, built so the wire schema can always carry it.
 *
 * The loop used to push the registry's raw `shareId` and `label` and parse
 * the whole array at the end, so ONE record with a 65-character label threw
 * after every pull had already run — no row survived, and the user was told
 * "Couldn't refresh shares." while the healthy mounts had in fact refreshed.
 *
 * Identity damage is contained exactly like grant damage: a row that cannot
 * state its own identity is dropped from the report rather than allowed to
 * take the whole report with it. Nothing is invented — a fabricated id or
 * label would be a lie the UI could act on.
 *
 * Validated against the ACTUAL wire schema rather than a restatement of its
 * bounds, because a restatement drifts and this function exists precisely to
 * stop a row the schema refuses from reaching it.
 */
export function shareMountResultRow(input: {
  shareId: unknown;
  label: unknown;
  status: "updated" | "unchanged" | "ended" | "damaged";
  changedPaths: number;
}): ShareMountStatusRow | null {
  // A count that is not a number claims the minimum rather than carrying a
  // value the schema refuses — NaN and Infinity both survive `Math.trunc`
  // and would fail the final parse, which is the wholesale throw returning.
  const changedPaths = Number.isFinite(input.changedPaths)
    ? Math.max(0, Math.trunc(input.changedPaths))
    : 0;
  const parsed = ShareMountStatusRow.safeParse({
    shareId: input.shareId,
    label: input.label,
    status: input.status,
    changedPaths,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * What one mount's refresh failure does to the REST of the refresh.
 *
 * Only a failure that makes every remaining pull pointless may abandon them.
 * An expired session is that: nothing else can succeed until the user signs
 * in. A damaged pin is not — it is permanent for ONE mount, and throwing it
 * stopped healthy shares from refreshing at all.
 *
 * It gets a status of its own rather than "unchanged", because "unchanged"
 * would hide a mount that can never refresh again behind a word that means
 * everything is fine.
 */
export function classifyShareMountRefreshError(
  error: unknown,
): { kind: "abort"; message: string } | { kind: "row"; status: "damaged" | "unchanged" } {
  if (error instanceof RelayUnauthorizedError) {
    return {
      kind: "abort",
      message: "Your dohc Cloud session expired. Sign in again, then refresh shares.",
    };
  }
  if (error instanceof SharePinInvalidError) return { kind: "row", status: "damaged" };
  return { kind: "row", status: "unchanged" };
}

// One refresh pass for one mount: pull the share's filtered ops into the
// mount's nested store, materialize under shared-with-me/<label>/, commit
// the cursor. Same crash-safe ordering as the standalone shared view
// (materialize before commit; re-replay is idempotent). Revocation comes
// back as status "ended" with the files left exactly as they were.
export async function refreshShareMountOnce(input: {
  hostWorkspaceId: string;
  hostRoot: string;
  mount: Pick<ShareMountRecord, "shareId" | "label">;
  relay: SyncRelayConnection;
  pull: Parameters<typeof refreshSharedViewOnce>[0]["pull"];
  // Read from the mount record before this pull, exactly as a standalone
  // view does.
  pinnedSelector: unknown;
  // Same durable skip record a standalone view keeps, written to the MOUNT's
  // record: a mount's pulls commit past a refused op too.
  recordRefusals: Parameters<typeof refreshSharedViewOnce>[0]["recordRefusals"];
  openStore: (workspace: {
    workspaceId: string;
    rootPath: string;
  }) => CaptureVersionedTextStore;
}): Promise<RefreshSharedViewOutcome> {
  const rootDir = mountRootFor(input.hostRoot, input.mount.label);
  await assertRealMountRoot(input.hostRoot, input.mount.label);
  const storeWorkspaceId = mountStoreWorkspaceIdFor(
    input.hostWorkspaceId,
    input.mount.shareId,
  );
  // A mount's store is a workspace of its own (synthetic id, nested root), so
  // this refresh owns it and closes it below. The standalone shared-view
  // callers deliberately do NOT close theirs: there the store is the user's
  // live workspace session, and closing it would tear down capture mid-use.
  const store = input.openStore({ workspaceId: storeWorkspaceId, rootPath: rootDir });
  // Repair BEFORE pulling: the pull only replays deltas, so a file tampered
  // on disk (rogue tool — every dohc surface refuses these writes) must be
  // re-projected from the mount's store or refreshes would report
  // "unchanged" over broken content. Running the repair first also
  // self-heals a tampered directory chain (planted symlinks removed and the
  // real tree rebuilt) so the pull materializes onto a healthy projection
  // instead of wedging on its containment guards.
  try {
    const repaired = await repairSharedViewProjection(
      rootDir,
      storeWorkspaceId,
      store,
    );
    const outcome = await refreshSharedViewOnce({
      rootDir,
      workspaceId: storeWorkspaceId,
      relay: input.relay,
      shareId: input.mount.shareId,
      pull: input.pull,
      pinnedSelector: input.pinnedSelector,
      recordRefusals: input.recordRefusals,
      store,
    });
    if (repaired === 0) return outcome;
    return {
      status: outcome.status === "ended" ? "ended" : "updated",
      changedPaths: outcome.changedPaths + repaired,
      excludedPaths: outcome.excludedPaths,
      unjournalablePaths: outcome.unjournalablePaths,
      // A repair changes what the projection holds, never why the pull
      // refused an op: those carry through untouched.
      refusedOps: outcome.refusedOps,
      refusedDetail: outcome.refusedDetail,
    };
  } finally {
    // Best-effort, like every other session teardown in this flow: a failing
    // close must not discard a refresh that already materialized and committed
    // its cursor, or mountShare would roll back and delete the folder it just
    // wrote.
    await store.close().catch(() => undefined);
  }
}

// Unmount: delete the projection folder (nested engine store included). The
// mount is a projection of the granter's data — removing it destroys no
// source of truth, so a plain recursive remove is honest. Callers remove the
// registry record; this only owns the disk side.
export async function removeMountFolder(
  hostRoot: string,
  label: string,
): Promise<void> {
  mountRootFor(hostRoot, label); // label validation + lexical containment
  const realHost = await realpath(hostRoot);
  const container = join(realHost, SHARED_WITH_ME_FOLDER);
  const containerStat = await lstat(container).catch(() => null);
  if (containerStat === null) return; // nothing to remove
  if (containerStat.isSymbolicLink() || !containerStat.isDirectory()) {
    throw new Error(
      `Share mount path is not a real directory: ${SHARED_WITH_ME_FOLDER}`,
    );
  }
  const leaf = join(container, label);
  const leafStat = await lstat(leaf).catch(() => null);
  if (leafStat === null) return; // already gone
  if (leafStat.isSymbolicLink()) {
    // A tampered symlinked mount root is removed AS A LINK — rm without
    // `recursive` unlinks the entry itself, never following it — so unmount
    // always succeeds instead of wedging the share in Settings/Explorer.
    await rm(leaf, { force: true });
    return;
  }
  await rm(leaf, { recursive: true, force: true });
}
