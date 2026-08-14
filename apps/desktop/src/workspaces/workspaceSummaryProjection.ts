import { WorkspaceSummary } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import {
  readableShareLevel,
  shareViewGranterEmail,
  shareViewIsPresent,
} from "./shareViewMarker";

// The registry -> renderer projection. The registry file is DATA, not a
// contract: a record can be hand-edited, half-written by a crash, or written
// by an older build. Every entry is parsed against the wire schema before it
// reaches the renderer, and every raw record is treated as `unknown` until it
// has been — reading a field off a row that turned out to be `null` is how
// one bad row used to take the whole workspace list with it.
//
// Damage is contained, and contained DIFFERENTLY for the two share kinds,
// because they fail closed in opposite directions:
//
//   A share VIEW marker is RESTRICTIVE. It is what tells the shell this
//   workspace is someone else's: read-only editors, no share surfaces, a
//   banner. Dropping it would present the workspace as an ordinary writable
//   one — damage failing OPEN. So a share view whose grant cannot be read
//   keeps its marker, loses only its level, and carries `damaged` so the
//   shell can say what happened.
//
//   A share MOUNT row carries no RESTRICTION — read-only enforcement for
//   `shared-with-me/` is path-based and independent of these records — but it
//   does carry MANAGEABILITY. The mount's folder is on disk, and the row is
//   what the Remove action is addressed by, so an unreadable row is kept and
//   marked rather than dropped. Dropping it would strand a folder the user
//   can no longer remove.
//
//   The one mount shape still dropped is a row that cannot name itself: with
//   no readable `shareId` or `label` there is nothing to remove or render.
//
// Damage to the WORKSPACE itself still throws, which is the behaviour the
// refusal screen already exists for (see `nativeWorkspaceSummaries`). Hiding
// a workspace would be a silent, unrecoverable answer to a fault the user
// needs told about.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Every field carried into a DAMAGED shape has to satisfy the schema that
// shape is parsed against. Twice now, a value the schema refused turned the
// fallback into the failure it was written to prevent — so damaged shapes are
// built from bounded reads, never from raw ones.
function boundedString(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max
    ? value
    : null;
}

/**
 * Project one registry entry for the renderer.
 *
 * A share view keeps its marker even when its grant is unreadable, and a
 * mount row keeps its identity so it stays removable. Anything still
 * unreadable after that is the workspace itself, and throws.
 */
export function workspaceSummaryFor(entry: RegistryEntry): WorkspaceSummary {
  const shareViewShape = WorkspaceSummary.shape.shareView;
  const shareMountsShape = WorkspaceSummary.shape.shareMounts;

  const rawShareView: unknown = entry.shareView;
  let shareView: Record<string, unknown> | undefined;
  if (shareViewIsPresent(rawShareView)) {
    // PRESENT, so restricted — readable or not. A non-object value here is
    // still a share view that lost its marker, never an ordinary workspace.
    const level = isRecord(rawShareView)
      ? readableShareLevel(rawShareView.grantedSelector)
      : null;
    const withLevel = isRecord(rawShareView)
      ? { ...rawShareView, access: level ?? undefined }
      : {};
    // A healthy marker needs an IDENTITY as well as a grant. `shareId` is
    // optional on the schema only so the damaged shape can omit it, so a
    // marker with a perfect grant and no id would classify healthy and then
    // fail every refresh it advertises — a live-looking share that can never
    // load. Bounded to the schema's own limits for the same reason the
    // granter email is: an out-of-range value carried into the damaged shape
    // would fail the summary parse and throw out of the whole projection.
    const shareId = boundedString(
      isRecord(rawShareView) ? rawShareView.shareId : undefined,
      1,
      200,
    );
    const readable =
      shareId !== null && level !== null && shareViewShape.safeParse(withLevel).success;
    // The degraded marker keeps the stance and drops only the level. It is
    // never a guess about WHY: `damaged` says the grant could not be read,
    // and nothing here invents a level, an end, or a reason.
    shareView = readable
      ? withLevel
      : {
          // Only what could actually be read. A share id is never invented:
          // an unreadable marker has no identity to state, and a placeholder
          // would be a lie the rest of the app could act on.
          ...(shareId !== null ? { shareId } : {}),
          granterEmail: shareViewGranterEmail(rawShareView),
          damaged: true as const,
        };
  }

  const rawMounts: unknown = entry.shareMounts;
  const shareMounts = Array.isArray(rawMounts)
    ? rawMounts
        .map((row: unknown) => {
          if (!isRecord(row)) return row;
          const level = readableShareLevel(row.grantedSelector);
          const healthy = { ...row, access: level ?? undefined };
          if (level !== null && shareMountsShape.safeParse([healthy]).success) {
            return healthy;
          }
          // Damaged, but KEPT: the mount's folder is on disk, and the Remove
          // action is the only way back. Every field is bounded to the wire
          // schema here, because a value it refuses would drop the row and
          // strand the folder — the failure this branch exists to prevent.
          return {
            shareId: boundedString(row.shareId, 1, 200),
            label: boundedString(row.label, 1, 64),
            granterEmail: boundedString(row.granterEmail, 3, 320),
            damaged: true as const,
          };
        })
        .filter((row) => shareMountsShape.safeParse([row]).success)
    : undefined;

  return WorkspaceSummary.parse({
    ...entry,
    shareView,
    ...(shareMounts ? { shareMounts } : {}),
  });
}

/** Project the whole registry. */
export function workspaceSummariesFrom(
  entries: readonly RegistryEntry[],
): WorkspaceSummary[] {
  return entries.map(workspaceSummaryFor);
}
