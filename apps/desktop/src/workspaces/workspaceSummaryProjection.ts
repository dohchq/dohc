import { WorkspaceSummary } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";

// The registry -> renderer projection. The registry file is DATA, not a
// contract: a record can be hand-edited, half-written by a crash, or written
// by an older build, so every entry is parsed against the wire schema before
// it reaches the renderer.
//
// Share damage is contained to the share that carries it. A share record
// whose stored grant cannot be read is OMITTED; its workspace still lists,
// its other shares still list, and so does every other workspace. One
// unreadable share must not take the user's whole workspace list with it —
// that turns a share-sized fault into "dohc has no workspaces", which is
// false and offers the user no way back.
//
// Omitting is the fail-closed answer for a share: a share the renderer never
// receives is a share the renderer cannot act on. It is never repaired or
// guessed at here, and the level is never defaulted.
//
// Damage to the WORKSPACE itself still throws, which is the behaviour the
// refusal screen already exists for (see `nativeWorkspaceSummaries`). Hiding
// a workspace would be a silent, unrecoverable answer to a fault the user
// needs told about.

/**
 * Project one registry entry for the renderer.
 *
 * Share records that fail the wire schema are dropped, one by one. Anything
 * still unreadable after that is the workspace itself, and throws.
 */
export function workspaceSummaryFor(entry: RegistryEntry): WorkspaceSummary {
  const shareViewShape = WorkspaceSummary.shape.shareView;
  const shareMountsShape = WorkspaceSummary.shape.shareMounts;

  const shareView = entry.shareView
    ? { ...entry.shareView, access: entry.shareView.grantedSelector?.access }
    : undefined;
  const readableShareView = shareViewShape.safeParse(shareView).success
    ? shareView
    : undefined;

  const shareMounts = entry.shareMounts?.map((mount) => ({
    ...mount,
    access: mount.grantedSelector?.access,
  }));
  const readableShareMounts = shareMounts?.filter(
    (mount) => shareMountsShape.safeParse([mount]).success,
  );

  return WorkspaceSummary.parse({
    ...entry,
    shareView: readableShareView,
    ...(readableShareMounts ? { shareMounts: readableShareMounts } : {}),
  });
}

/** Project the whole registry. */
export function workspaceSummariesFrom(
  entries: readonly RegistryEntry[],
): WorkspaceSummary[] {
  return entries.map(workspaceSummaryFor);
}
