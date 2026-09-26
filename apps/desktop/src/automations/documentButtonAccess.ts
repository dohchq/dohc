import { isRecord } from "@dohc/workspace-core/records";
import { recordedShareSelector } from "../workspaces/shareViewRecords";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { shareViewTakesLocalWrites } from "../workspaces/shareWriteGate";

/**
 * Who may press a document Collection's buttons from this computer, and
 * where the press runs. A workspace that is not a share view takes hand
 * edits, so it takes presses and runs them here. A share view cannot run
 * them: its automations need the owner's list of who can edit, which only
 * the owner can read. With Edit on main over the Collection's folder or a
 * folder above it, its presses are "relayed" to the computer that runs the
 * owner's schedules (ADR 0012); the relay checks the same rule. Edit on one
 * record's file, a version share, or a lower level is not enough.
 */
export function documentButtonAccess(shareView: unknown, collectionPath: string): "press" | "relayed" | "no-access" {
  if (!shareViewIsPresent(shareView)) return "press";
  const marker = isRecord(shareView) ? shareView : {};
  const grant = recordedShareSelector(marker.grantedSelector);
  if (!grant || !shareViewTakesLocalWrites({ access: grant.access, ended: marker.ended === true })) return "no-access";
  if (grant.versionId !== null || grant.paths.length === 0) return "no-access";
  const covers = grant.paths.some((path) => collectionPath === path || collectionPath.startsWith(`${path}/`));
  return covers ? "relayed" : "no-access";
}
