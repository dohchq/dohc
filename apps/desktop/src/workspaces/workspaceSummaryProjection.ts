import { ShareSkippedOpsSummary, WorkspaceSummary } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";
import { usableShareMountRecord } from "./shareMounts";
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
  const shareMountsShape = WorkspaceSummary.shape.shareMounts;

  const rawShareView: unknown = entry.shareView;
  let shareView: Record<string, unknown> | undefined;
  if (shareViewIsPresent(rawShareView)) {
    // PRESENT, so restricted — readable or not. A non-object value here is
    // still a share view that lost its marker, never an ordinary workspace.
    const raw = isRecord(rawShareView) ? rawShareView : {};
    // AUTHORITATIVE fields only. `damaged` means "this grant cannot be read",
    // and only two things can make that true: the share has no identity to
    // act on, or its pinned grant is unreadable. Display metadata gets no
    // vote — a malformed `ended` flag saying the GRANT is unreadable would be
    // a false statement, and it would suppress the refresh as well.
    const shareId = boundedString(raw.shareId, 1, 200);
    const level = readableShareLevel(raw.grantedSelector);
    const damaged = shareId === null || level === null;
    // Ancillary metadata normalizes FAIL-SOFT and independently: each field
    // is kept when the wire schema will carry it and dropped when it will
    // not. Dropping one costs a line of display; rejecting the record costs
    // the whole workspace list.
    const skipped = ShareSkippedOpsSummary.safeParse(raw.skippedOps);
    shareView = {
      ...(shareId !== null ? { shareId } : {}),
      granterEmail: shareViewGranterEmail(raw),
      ...(damaged ? { damaged: true as const } : { access: level }),
      ...(raw.ended === true ? { ended: true } : {}),
      ...(skipped.success ? { skippedOps: skipped.data } : {}),
    };
  }

  const rawMounts: unknown = entry.shareMounts;
  const shareMounts = Array.isArray(rawMounts)
    ? rawMounts
        .map((row: unknown) => {
          if (!isRecord(row)) return row;
          // Same split as the share view. A mount's authoritative fields are
          // its identity and its grant — and its LABEL is part of that
          // identity: it names the folder on disk, and a label this app would
          // never materialize through cannot be trusted to address one.
          const shareId = boundedString(row.shareId, 1, 200);
          const label = boundedString(row.label, 1, 64);
          const usableRecord = usableShareMountRecord(rawMounts, row);
          const level = readableShareLevel(row.grantedSelector);
          const damaged = shareId === null || !usableRecord || level === null;
          const skipped = ShareSkippedOpsSummary.safeParse(row.skippedOps);
          return {
            ...(shareId !== null ? { shareId } : {}),
            ...(label !== null ? { label } : {}),
            granterEmail: shareViewGranterEmail(row),
            ...(damaged ? { damaged: true as const } : { access: level }),
            ...(row.ended === true ? { ended: true } : {}),
            ...(skipped.success ? { skippedOps: skipped.data } : {}),
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
