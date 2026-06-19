import type { ChangeSet } from "@dohc/workspace-core";

// The liberal collaboration policy (plan Phase 10): ordinary edits — human or
// agent — sync with zero ceremony. Friction exists only where it earns its
// keep: explicitly protected targets become proposals, boundary crossings
// (sharing, permissions, bulk deletes) need a human yes, and a permission
// denial keeps work safe locally with a plain-language explanation — never a
// lost edit, never an error code.

export type CollaborationDecision =
  | { action: "sync" }
  | { action: "propose"; reason: string }
  | { action: "confirm"; reason: string }
  | { action: "keep-local"; reason: string };

export interface CollaborationInput {
  set: ChangeSet;
  // Folders the user explicitly protected (workspace-relative path prefixes).
  protectedPaths?: string[];
  // The server refused this actor's write (resolved upstream).
  permissionDenied?: boolean;
}

function isUnder(path: string, prefix: string): boolean {
  const normalizedPrefix = prefix
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalizedPrefix) return false;
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

export function decideCollaboration(input: CollaborationInput): CollaborationDecision {
  if (input.permissionDenied) {
    return {
      action: "keep-local",
      reason:
        "You don't have access to change this in the shared workspace, so your edit stays on this device. Ask a workspace owner for access to sync it.",
    };
  }

  if (input.set.boundaryCrossings.length > 0) {
    return {
      action: "confirm",
      reason: `This change crosses a boundary (${input.set.boundaryCrossings.join(", ")}) — for example sharing or permission changes — so it waits for your explicit OK.`,
    };
  }

  const protectedHit = input.set.files.find((file) =>
    (input.protectedPaths ?? []).some((prefix) => isUnder(file.path, prefix)),
  );
  if (protectedHit) {
    return {
      action: "propose",
      reason: `${protectedHit.path} is in a protected folder, so this lands as a proposal to review instead of a direct change.`,
    };
  }

  return { action: "sync" };
}
