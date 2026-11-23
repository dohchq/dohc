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
 * an existing share, that share's id. `recipientName` is the name the dialog
 * shows for a person, which the warning uses when it is given.
 */
export interface AutomationShare {
  recipientEmail: string | null;
  recipientName?: string;
  access: string;
  shareId?: string;
}

/** The sentence(s) the dialog says when a share would stop automation steps or pause incoming webhooks, or null. */
export function automationShareWarning(
  stops: AutomationShareImpactResult["stops"],
  recipient: string | null,
  pausedWebhooks: AutomationShareImpactResult["pausedWebhooks"] = [],
): string | null {
  const parts: string[] = [];
  if (stops.length > 0) {
    const automations = new Map(
      stops.map((stop) => [
        stop.automationId,
        `"${stop.automationName}" in ${stop.collectionPath}`,
      ]),
    );
    const reach = [...new Set(stops.map((stop) => automationReachCopy(stop, true)))];
    const what = `${automations.size === 1 ? "the automation" : "the automations"} ${AND.format([...automations.values()])}`;
    const who = recipient ?? "anyone who opens this link";
    parts.push(`This share stops ${what} because ${who} cannot ${OR.format(reach)}.`);
  }
  if (pausedWebhooks && pausedWebhooks.length > 0) {
    const hooks = pausedWebhooks.map((hook) => `"${hook.name}" in ${hook.collectionPath}`);
    const what = `${hooks.length === 1 ? "the incoming webhook" : "the incoming webhooks"} ${AND.format(hooks)}`;
    parts.push(
      `This share pauses ${what} because incoming webhooks run only in private Collections.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export function useAutomationShareCheck(workspaceId: string, target: RelayShareTarget) {
  // A check answers for one share of one selection in one workspace.
  const keyOf = (share: AutomationShare) =>
    JSON.stringify([
      workspaceId,
      target,
      share.recipientEmail,
      share.access,
      share.shareId ?? null,
    ]);
  const [checked, setChecked] = useState<{
    key: string;
    warning: string | null;
    failed: boolean;
  } | null>(null);
  /** The warning or the failed check for the share on screen, or null. */
  const noteFor = (share: AutomationShare) => (checked?.key === keyOf(share) ? checked : null);
  /** Whether Create/Change asks main first: any Edit share, or any new path share (which can pause incoming webhooks). */
  const asks = (share: AutomationShare) =>
    target.kind === "paths" &&
    (share.access === "edit" || share.shareId === undefined) &&
    noteFor(share)?.warning == null;
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
      const access: "view" | "comment" | "edit" =
        share.access === "edit" || share.access === "comment" ? share.access : "view";
      let result: AutomationShareImpactResult;
      try {
        result = await bridge().automationShareImpact({
          workspaceId,
          recipientEmail: share.recipientEmail,
          paths: target.paths,
          access,
        });
      } catch {
        if (!isCurrent()) return false;
        setChecked({ key, warning: null, failed: true });
        return true;
      }
      if (!isCurrent()) return false;
      const warning = automationShareWarning(
        result.stops,
        share.recipientName ?? share.recipientEmail,
        result.pausedWebhooks,
      );
      setChecked({ key, warning, failed: false });
      return warning === null;
    },
    forget: () => setChecked(null),
  };
}

/** The warning before a share, or the sentence that the check failed. */
export function AutomationShareNote(props: {
  note: { warning: string | null; failed: boolean } | null;
}) {
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
      <p
        data-testid="share-automation-check-failed"
        role="status"
        className="m-0 text-xs leading-relaxed text-muted"
      >
        {AUTOMATION_CHECK_FAILED}
      </p>
    );
  }
  return null;
}
