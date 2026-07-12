import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { validateUserWritePath } from "@dohc/workspace-core";
import type { SyncRelayConnection } from "@dohc/workspace-engine";
import { SHARED_WITH_ME_FOLDER } from "./createWorkspaceFolder";
import type { ShareMountRecord } from "./registryStore";
import {
  refreshSharedViewOnce,
  type RefreshSharedViewOutcome,
} from "./sharedView";

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
  const base =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-._]+|[-._]+$/g, "")
      .slice(0, MOUNT_LABEL_MAX - 8) || "share";
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
  if (target !== container && !target.startsWith(`${container}${sep}`)) {
    throw new Error(`Share mount escapes shared-with-me: ${label}`);
  }
  if (target === container) {
    throw new Error(`Share mount label resolves to shared-with-me itself: ${label}`);
  }
  return target;
}

// The store-scoping workspace id inside the mount's own nested engine.db.
// Purely local and deterministic; it never leaves the machine.
export function mountStoreWorkspaceIdFor(shareId: string): string {
  return `share-mount-${shareId}`;
}

// One refresh pass for one mount: pull the share's filtered ops into the
// mount's nested store, materialize under shared-with-me/<label>/, commit
// the cursor. Same crash-safe ordering as the standalone shared view
// (materialize before commit; re-replay is idempotent). Revocation comes
// back as status "ended" with the files left exactly as they were.
export async function refreshShareMountOnce(input: {
  hostRoot: string;
  mount: Pick<ShareMountRecord, "shareId" | "label">;
  relay: SyncRelayConnection;
}): Promise<RefreshSharedViewOutcome> {
  const rootDir = mountRootFor(input.hostRoot, input.mount.label);
  return refreshSharedViewOnce({
    rootDir,
    workspaceId: mountStoreWorkspaceIdFor(input.mount.shareId),
    relay: input.relay,
    shareId: input.mount.shareId,
  });
}

// Unmount: delete the projection folder (nested engine store included). The
// mount is a projection of the granter's data — removing it destroys no
// source of truth, so a plain recursive remove is honest. Callers remove the
// registry record; this only owns the disk side.
export async function removeMountFolder(
  hostRoot: string,
  label: string,
): Promise<void> {
  const rootDir = mountRootFor(hostRoot, label);
  await rm(rootDir, { recursive: true, force: true });
}
