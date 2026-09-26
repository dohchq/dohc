import { automationReachCopy } from "./automationReachCopy";
import { Zap } from "lucide-react";
import { useState } from "react";
import type { AutomationShareImpactResult } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import type { RelayShareTarget } from "./RelayShareDialog";

// Edit on a Collection, or a folder holding one, can narrow what its
// automations reach (ADR 0012). Before such a share is made, the share
// dialog asks main which switched-on steps it would stop, and says so in
// one sentence. A second Create makes the share. The check is advice: when
// it fails, the share goes ahead, and the notice for stopped steps names
// them afterward.

const AND = new Intl.ListFormat("en", { type: "conjunction" });
const OR = new Intl.ListFormat("en", { type: "disjunction" });

export const AUTOMATION_CHECK_FAILED = "dohc could not check which automations this share stops.";

/**
 * A share as the dialog shows it: who it makes an editor (an email, or
 * null for anyone who opens a link), its access, and, for a link added to
 * an existing share, that share's id.
 */
export interface AutomationShare {
  recipientEmail: string | null;
  access: string;
  shareId?: string;
}

/** The one sentence the dialog says when a share would stop automation steps, or null. */
export function automationShareWarning(
  stops: AutomationShareImpactResult["stops"],
  recipientEmail: string | null,
): string | null {
  if (stops.length === 0) return null;
  const automations = new Map(stops.map((stop) => [stop.automationId, `"${stop.automationName}" in ${stop.collectionPath}`]));
  const reach = [...new Set(stops.map((stop) => automationReachCopy(stop, true)))];
  const what = `${automations.size === 1 ? "the automation" : "the automations"} ${AND.format([...automations.values()])}`;
  const who = recipientEmail ?? "anyone who opens this link";
  return `This share stops ${what}, because ${who} cannot ${OR.format(reach)}.`;
}

export function useAutomationShareCheck(workspaceId: string, target: RelayShareTarget) {
  // A check answers for one share of one selection in one workspace.
  const keyOf = (share: AutomationShare) =>
    JSON.stringify([workspaceId, target, share.recipientEmail, share.access, share.shareId ?? null]);
  // What the last check found, for the share it checked.
  const [checked, setChecked] = useState<{ key: string; warning: string | null; failed: boolean } | null>(null);
  /** The warning or the failed check for the share on screen, or null. */
  const noteFor = (share: AutomationShare) => (checked?.key === keyOf(share) ? checked : null);
  /** Whether Create for this share asks main first: Edit on files, and no warning shown yet. */
  const asks = (share: AutomationShare) =>
    share.access === "edit" && target.kind === "paths" && noteFor(share)?.warning == null;
  return {
    noteFor,
    asks,
    /**
     * Resolves true when the share may be made now: it stops no step, the
     * person already saw its warning, or the check failed. `isCurrent` says
     * whether the share on screen is still the one asked about; when it is
     * not, the answer is dropped and the share is not made.
     */
    async mayShare(share: AutomationShare, isCurrent: () => boolean): Promise<boolean> {
      if (target.kind !== "paths" || !asks(share)) return true;
      const key = keyOf(share);
      let stops: AutomationShareImpactResult["stops"];
      try {
        ({ stops } = await bridge().automationShareImpact({
          workspaceId, recipientEmail: share.recipientEmail, paths: target.paths, access: "edit",
        }));
      } catch {
        if (!isCurrent()) return false;
        setChecked({ key, warning: null, failed: true });
        return true;
      }
      if (!isCurrent()) return false;
      const warning = automationShareWarning(stops, share.recipientEmail);
      setChecked({ key, warning, failed: false });
      return warning === null;
    },
  };
}

/** The warning before a share, or the sentence that the check failed. */
export function AutomationShareNote(props: { note: { warning: string | null; failed: boolean } | null }) {
  const { note } = props;
  if (note?.warning) {
    return (
      <p
        data-testid="share-automation-warning"
        role="status"
        className="m-0 flex items-start gap-1.5 text-xs leading-relaxed text-warning"
      >
        <Zap size={12} strokeWidth={1.9} aria-hidden className="mt-0.5 shrink-0" />
        {note.warning}
      </p>
    );
  }
  if (note?.failed) {
    return (
      <p data-testid="share-automation-check-failed" role="status" className="m-0 text-xs leading-relaxed text-muted">
        {AUTOMATION_CHECK_FAILED}
      </p>
    );
  }
  return null;
}
