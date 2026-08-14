import { SHARE_ACCESS, WorkspaceSummary } from "../ipc/bridgeContract";
import type { RegistryEntry } from "./registryStore";

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
//   A share MOUNT row is DESCRIPTIVE. Read-only enforcement for
//   `shared-with-me/` is path-based and independent of these records, so an
//   unreadable row is dropped from the listing. Nothing about the mount's
//   restrictions depends on it.
//
// Damage to the WORKSPACE itself still throws, which is the behaviour the
// refusal screen already exists for (see `nativeWorkspaceSummaries`). Hiding
// a workspace would be a silent, unrecoverable answer to a fault the user
// needs told about.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The level a stored grant names, or undefined when it names none we can read. */
function levelOf(grantedSelector: unknown): unknown {
  return isRecord(grantedSelector) ? grantedSelector.access : undefined;
}

/**
 * Project one registry entry for the renderer.
 *
 * A share view keeps its marker even when its grant is unreadable. Unreadable
 * mount rows are dropped. Anything still unreadable after that is the
 * workspace itself, and throws.
 */
export function workspaceSummaryFor(entry: RegistryEntry): WorkspaceSummary {
  const shareViewShape = WorkspaceSummary.shape.shareView;
  const shareMountsShape = WorkspaceSummary.shape.shareMounts;

  const rawShareView: unknown = entry.shareView;
  let shareView: Record<string, unknown> | undefined;
  if (isRecord(rawShareView)) {
    const level = levelOf(rawShareView.grantedSelector);
    const withLevel = { ...rawShareView, access: level };
    // The level is checked against its OWN rule, not against the marker
    // schema. `access` is optional on the marker precisely so the degraded
    // shape can exist, so a missing level parses there and would sail
    // through as healthy — the damage has to be asked about directly.
    const readable =
      SHARE_ACCESS.safeParse(level).success &&
      shareViewShape.safeParse(withLevel).success;
    // The degraded marker keeps the stance and drops only the level. It is
    // never a guess about WHY: `damaged` says the grant could not be read,
    // and nothing here invents a level, an end, or a reason.
    const { access: _level, ...withoutLevel } = withLevel;
    shareView = readable ? withLevel : { ...withoutLevel, damaged: true as const };
  }

  const rawMounts: unknown = entry.shareMounts;
  const shareMounts = Array.isArray(rawMounts)
    ? rawMounts
        .map((row: unknown) =>
          isRecord(row) ? { ...row, access: levelOf(row.grantedSelector) } : row,
        )
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
