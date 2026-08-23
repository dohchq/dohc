import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isSharedWithMePath,
  validateUserReadPath,
  validateUserWritePath,
} from "@dohc/workspace-core";
import { isInside } from "../security/pathContainment";
// See the note in workspaceGraph.ts: the path floor is a cross-process security
// contract with a Rust twin, not engine state.
import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { ShareViewSelector } from "./shareViewInfo";
import { RelayUnauthorizedError } from "@dohc/workspace-contracts/relay";
import { ShareMountStatusRow } from "../ipc/bridgeContract";
import { SharePinInvalidError } from "./shareViewRecords";
import { assertResolvedWorkspacePath } from "./workspaceRealPath";
import type { ShareMountRecord } from "./registryStore";

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
const SHARE_ID_MAX = 200;
const INVALID_SHARE_MOUNT_DETAILS =
  "dohc cannot verify this mounted share because its saved details are invalid. Remove the share. Add it again.";

// A mount label must be exactly one safe path segment. The registry file is
// data, not a write path into the tree — labels are re-validated on every
// use so an edited registry cannot smuggle traversal into materialization.
export function validShareMountId(shareId: unknown): shareId is string {
  return (
    typeof shareId === "string" &&
    shareId.length > 0 &&
    shareId.length <= SHARE_ID_MAX
  );
}

export function validMountLabel(label: unknown): label is string {
  if (typeof label !== "string") return false;
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
function mountLabelFor(
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
  return target;
}

function mountField(mount: unknown, field: "shareId" | "label"): unknown {
  return typeof mount === "object" && mount !== null && !Array.isArray(mount)
    ? (mount as Record<string, unknown>)[field]
    : undefined;
}

function storedMountLabel(mount: unknown): string | null {
  const label = mountField(mount, "label");
  return typeof label === "string" ? label : null;
}

// Allocation reserves every stored string, not only records healthy enough
// to use. A damaged record still claims its spelling until it is removed;
// reusing that label would make two registry records name one projection.
function reservedShareMountLabels<Mount>(
  mounts: readonly Mount[],
): string[] {
  return mounts.flatMap((mount) => {
    const label = storedMountLabel(mount);
    return label === null ? [] : [label];
  });
}

/** Allocate one label without adopting a registry or disk-owned name. */
export function allocateShareMountLabel<Mount>(input: {
  storedMounts: readonly Mount[];
  onDiskNames: readonly string[];
  granterEmail: string | null;
}): string {
  return mountLabelFor(input.granterEmail, [
    ...reservedShareMountLabels(input.storedMounts),
    ...input.onDiskNames,
  ]);
}

// Mount labels are allocated case-insensitively on every platform. Keep the
// authority check equally conservative: default macOS filesystems alias case
// just like Windows, and a hand-edited registry must not let two owners claim
// one physical projection even on a case-sensitive host.
function mountLabelKey(label: string): string {
  return label.toLowerCase();
}

export function shareMountRecordsForId<Mount>(
  mounts: readonly Mount[],
  shareId: string,
): Array<Mount & { shareId: string }> {
  return mounts.filter(
    (mount): mount is Mount & { shareId: string } =>
      mountField(mount, "shareId") === shareId,
  );
}

export function usableShareMountRecord<Mount>(
  mounts: readonly Mount[],
  mount: Mount,
): mount is Mount & { shareId: string; label: string } {
  const shareId = mountField(mount, "shareId");
  const label = mountField(mount, "label");
  if (!validShareMountId(shareId) || !validMountLabel(label)) return false;
  if (shareMountRecordsForId(mounts, shareId).length !== 1) return false;
  const key = mountLabelKey(label);
  return (
    mounts.filter((candidate) => {
      const candidateLabel = storedMountLabel(candidate);
      return candidateLabel !== null && mountLabelKey(candidateLabel) === key;
    }).length === 1
  );
}

export function planShareMountRemoval<Mount>(
  mounts: readonly Mount[],
  shareId: string,
):
  | { kind: "missing" }
  | {
      kind: "registry-only";
      remaining: Mount[];
    }
  | {
      kind: "owner";
      mount: Mount & { shareId: string; label: string };
    } {
  const matches = shareMountRecordsForId(mounts, shareId);
  if (matches.length === 0) return { kind: "missing" };
  if (
    matches.length === 1 &&
    usableShareMountRecord(mounts, matches[0]!)
  ) {
    return { kind: "owner", mount: matches[0]! };
  }
  const damaged = new Set<Mount>(matches);
  return {
    kind: "registry-only",
    remaining: mounts.filter((mount) => !damaged.has(mount)),
  };
}

export type ResolvedShareProjectionPath<Mount> =
  | { kind: "workspace-root" }
  | { kind: "projection-root" }
  | { kind: "local" }
  | {
      kind: "mount";
      mount: Mount & { shareId: string; label: string };
      path: string;
    };

/** Decide which owner controls a path after resolving aliases and symlinks. */
export async function resolveShareProjectionPath<Mount>(
  hostRoot: string,
  relativePath: string,
  mounts: readonly Mount[],
): Promise<ResolvedShareProjectionPath<Mount>> {
  const validated = validateUserReadPath(relativePath);
  if (!validated.ok) return { kind: "local" };
  const resolved = await assertResolvedWorkspacePath({
    rootPath: hostRoot,
    absolutePath: join(hostRoot, validated.normalized),
    spelled: relativePath,
    label: "Shared file path",
    access: "read",
  });
  const normalizedPath = resolved.relative.replaceAll("\\", "/");
  if (normalizedPath === "") return { kind: "workspace-root" };
  if (isSharedWithMePath(normalizedPath) && !normalizedPath.includes("/")) {
    return { kind: "projection-root" };
  }
  const comparedPath = mountLabelKey(normalizedPath);
  const matches = mounts.filter((mount) => {
    const label = storedMountLabel(mount);
    if (label === null) return false;
    const prefix = `${SHARED_WITH_ME_FOLDER}/${label}`;
    const comparedPrefix = mountLabelKey(prefix);
    return (
      comparedPath === comparedPrefix ||
      comparedPath.startsWith(`${comparedPrefix}/`)
    );
  });
  if (matches.length === 0) {
    if (isSharedWithMePath(normalizedPath)) {
      throw new Error(INVALID_SHARE_MOUNT_DETAILS);
    }
    return { kind: "local" };
  }
  if (matches.length !== 1 || !usableShareMountRecord(mounts, matches[0]!)) {
    throw new Error(INVALID_SHARE_MOUNT_DETAILS);
  }
  const mount = matches[0]!;
  const prefix = `${SHARED_WITH_ME_FOLDER}/${mount.label}`;
  const comparedPrefix = mountLabelKey(prefix);
  return {
    kind: "mount",
    mount,
    path:
      comparedPath === comparedPrefix
        ? ""
        : normalizedPath.split("/").slice(2).join("/"),
  };
}

/**
 * Resolve a workspace read to the mount that owns its real destination.
 *
 * Authority follows the resolved path, not its spelling: a symlink or a
 * filesystem alias into shared-with-me must still read the mount's canonical
 * store instead of bypassing it through the disk copy.
 */
export async function resolveShareMountPath<Mount>(
  hostRoot: string,
  relativePath: string,
  mounts: readonly Mount[],
  hasMountRegistry: boolean,
): Promise<{
  mount: Mount & { shareId: string; label: string };
  path: string;
} | null> {
  if (mounts.length === 0 && !hasMountRegistry) return null;
  const resolved = await resolveShareProjectionPath(
    hostRoot,
    relativePath,
    mounts,
  );
  return resolved.kind === "mount"
    ? { mount: resolved.mount, path: resolved.path }
    : null;
}

export async function refuseMoveAcrossShareMount(
  hostRoot: string,
  fromPath: string,
  toPath: string,
  mounts: readonly Pick<ShareMountRecord, "shareId" | "label">[],
  hasMountRegistry: boolean,
): Promise<void> {
  const [source, destination] = await Promise.all([
    resolveShareMountPath(hostRoot, fromPath, mounts, hasMountRegistry),
    resolveShareMountPath(hostRoot, toPath, mounts, hasMountRegistry),
  ]);
  if (source === null && destination === null) return;
  throw new Error(
    "A mounted share is read-only. Move the item somewhere outside the mounted share.",
  );
}

/** Refuse an import destination owned by the read-only share projection. */
export async function refuseImportIntoShareProjection(
  hostRoot: string,
  targetDir: string | undefined,
  mounts: readonly Pick<ShareMountRecord, "shareId" | "label">[],
  hasMountRegistry: boolean,
): Promise<void> {
  if (targetDir === undefined || targetDir === "") return;
  if (mounts.length === 0 && !hasMountRegistry) return;
  const destination = await resolveShareProjectionPath(
    hostRoot,
    targetDir,
    mounts,
  );
  if (
    destination.kind === "local" ||
    destination.kind === "workspace-root"
  ) {
    return;
  }
  throw new Error(
    "A mounted share is read-only. Import the files into a folder outside the mounted share.",
  );
}

export async function overlayCanonicalShareMountFiles<
  FileEntry extends { path: string },
  Mount,
>(input: {
  disk: { files: readonly FileEntry[]; folders?: readonly string[] };
  mounts: readonly Mount[];
  listCanonical: (
    mount: Mount & { shareId: string; label: string },
  ) => Promise<{ files: readonly FileEntry[]; folders?: readonly string[] }>;
  onFailure?: (mount: Mount, error: unknown) => void;
}): Promise<{ files: FileEntry[]; folders: string[] }> {
  // The projection is only a materialized cache. Remove it wholesale before
  // adding owner listings: a malformed record may not carry a label that can
  // identify its stale disk prefix, and preserving that unknown prefix would
  // turn registry damage into recipient-owned bytes becoming authoritative.
  const files = input.disk.files.filter(
    (file) => !isSharedWithMePath(file.path),
  );
  const folders = (input.disk.folders ?? []).filter((folder) => {
    if (!isSharedWithMePath(folder)) return true;
    return !folder.replaceAll("\\", "/").includes("/");
  });
  for (const mount of input.mounts) {
    const label = storedMountLabel(mount);
    if (label === null) {
      input.onFailure?.(mount, new Error(INVALID_SHARE_MOUNT_DETAILS));
      continue;
    }
    if (!usableShareMountRecord(input.mounts, mount)) {
      input.onFailure?.(mount, new Error(INVALID_SHARE_MOUNT_DETAILS));
      continue;
    }
    const prefix = `${SHARED_WITH_ME_FOLDER}/${label}`;
    folders.push(prefix);

    let canonical: Awaited<ReturnType<typeof input.listCanonical>>;
    try {
      canonical = await input.listCanonical(mount);
    } catch (error) {
      input.onFailure?.(mount, error);
      continue;
    }
    files.push(
      ...canonical.files.map((file) => ({
        ...file,
        path: `${prefix}/${file.path}`,
      })),
    );
    folders.push(
      ...(canonical.folders ?? []).map((folder) => `${prefix}/${folder}`),
    );
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    folders: [...new Set(folders)].sort((left, right) =>
      left.localeCompare(right),
    ),
  };
}

// The REAL-path guard the lexical check above cannot give: refuses a
// symlinked shared-with-me or label directory (at either component) before
// any materialization. A refresh writes relay-controlled bytes, so a link
// planted at either level must never redirect those writes outside the
// workspace (gpt-5.6-sol P1). The workspace root itself is realpath'd first,
// so ancestor system symlinks above the workspace stay legal.
export async function assertRealMountRoot(
  hostRoot: string,
  label: string,
): Promise<void> {
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

export async function removeShareMountProjection(
  hostRoot: string,
  label: unknown,
): Promise<{ folderLeft: boolean; error?: unknown }> {
  if (!validMountLabel(label)) return { folderLeft: true };
  try {
    await removeMountFolder(hostRoot, label);
    return { folderLeft: false };
  } catch (error) {
    return { folderLeft: true, error };
  }
}
