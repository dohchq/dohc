import { useEffect, useRef } from "react";
import type { AccessRuleHold, AccessRuleReach, AccessRuleUndo } from "../../ipc/bridgeContract";
import {
  heldOuterAccessRuleFolder,
  isAccessRuleChangedRefusal,
  isAccessRuleNotHeldRefusal,
} from "../../ipc/errorWords";
import type { NoticeTarget } from "../../notices/noticeTarget";
import { bridge } from "../bridge";
import type { ShellError, useShellError } from "./useShellError";

type Decision = "accept" | "restore";

const identityOf = (hold: Pick<AccessRuleHold, "versionId" | "folder">) =>
  `access-rule:${hold.versionId}:${hold.folder}`;
const waitsOf = (identity: string) => `${identity}:waits`;
// A hold the engine judged again, such as after a decision on a rule that
// changed since, reads as a new notice.
const judgedKey = (hold: AccessRuleHold) => `${hold.reason}|${hold.observedSha256 ?? ""}`;
// Anything else its row shows, which updates the row where it stands.
const shownContent = (hold: AccessRuleHold) =>
  JSON.stringify([
    hold.recordedRule,
    hold.rulePath,
    hold.changes,
    hold.unreadable,
    hold.fallsBackTo,
    hold.recordedAtMs,
  ]);
// Outer folders first: an inner folder's decision waits for theirs.
const depth = (folder: string) => (folder === "" ? 0 : folder.split("/").length);

const REACH: Record<AccessRuleReach, string> = {
  view: "View",
  comment: "Comment",
  edit: "Edit",
  none: "none",
  workspace: "workspace access",
};
// What a level lets someone do to a place, in a sentence.
const CAN: Partial<Record<AccessRuleReach, string>> = {
  view: "view",
  comment: "comment on",
  edit: "edit",
};

/** The place a hold is about, in a sentence: the folder, or this workspace for its own rule. */
const placeOf = (folder: string) => folder || "this workspace";
// The same place opening a sentence; a folder keeps its own spelling.
const placeOpening = (folder: string) => folder || "This workspace";
const ruleOf = (folder: string) =>
  folder ? `The access rule for ${folder}` : "The workspace's access rule";
const ruleOfLower = (folder: string) =>
  folder ? `the access rule for ${folder}` : "the workspace's access rule";
const rulePossessive = (folder: string) =>
  folder ? `${folder}'s access rule` : "the workspace's access rule";

/** What a folder follows without its own rule. */
function fallbackOf(hold: AccessRuleHold): string {
  return hold.fallsBackTo === null
    ? "each member's workspace access"
    : ruleOfLower(hold.fallsBackTo);
}

export function accessRuleHoldWords(hold: AccessRuleHold): {
  title: string;
  message: string;
  rows: string[];
  accept: string;
  accepting: string;
} {
  const place = placeOf(hold.folder);
  const until = `Until you choose, dohc doesn't record or share changes in ${place}. Members keep their earlier access.`;
  const rows = hold.changes.map(
    (change) => `${change.who}: ${REACH[change.before]} → ${REACH[change.after]}`,
  );
  const unreadable =
    hold.unreadable === "recorded"
      ? " dohc can't read the rule it recorded, so it can't list who gains access."
      : hold.unreadable === "on-disk"
        ? ` dohc can't read the access rule now on disk. Allowing it hides ${place} from members.`
        : "";
  if (hold.reason === "removed") {
    return {
      title: `${ruleOf(hold.folder)} was removed outside dohc`,
      message: `${until} Without it, ${place} follows ${fallbackOf(hold)}.${unreadable}`,
      rows,
      accept: "Remove rule",
      accepting: "Removing…",
    };
  }
  return {
    title: `Access to ${place} was widened outside dohc`,
    message: `${until} Restoring keeps the rule from outside dohc as a copy.${unreadable || (rows.length ? " Allowing the new rule gives:" : "")}`,
    rows,
    accept: "Allow new access",
    accepting: "Allowing…",
  };
}

/** What took effect, for the toast that follows a decision. */
export function accessRuleDecidedWords(
  hold: AccessRuleHold,
  decision: Decision,
  kept: readonly string[],
): string {
  const place = placeOf(hold.folder);
  if (decision === "restore") {
    const keptCopy = kept[0] ? ` The rule from outside dohc is saved as a copy of ${kept[0]}.` : "";
    return `Restored ${ruleOfLower(hold.folder)}.${keptCopy}`;
  }
  if (hold.reason === "removed")
    return `Removed ${ruleOfLower(hold.folder)}. ${placeOpening(hold.folder)} now follows ${fallbackOf(hold)}.`;
  const [only] = hold.changes;
  const can = only && CAN[only.after];
  if (hold.changes.length === 1 && only && can) {
    return `${only.who === "members" ? "Members" : only.who} can now ${can} ${place}.`;
  }
  return `${placeOpening(hold.folder)} now follows the new access rule.`;
}

/** Where a press on the row goes: a widening opens its rule; a removal reveals its folder. */
function targetOf(hold: AccessRuleHold): NoticeTarget {
  return hold.reason === "widened" && hold.rulePath
    ? { to: "file", path: hold.rulePath }
    : { to: "folder", path: hold.folder };
}

/**
 * One Notices row for each folder whose access rule changed outside dohc.
 * The rule dohc last recorded applies until the owner keeps the change or
 * restores the rule. The row comes from the engine's durable list, so it
 * returns after a restart and goes once the engine stops listing it.
 */
export function useAccessRuleHoldNotices(
  input: {
    workspaceId: string;
    holds: readonly AccessRuleHold[] | undefined;
    // Focuses the Notices row of one identity.
    showNotice: (identity: string) => void;
    openHistory: () => void;
  } & Pick<
    ReturnType<typeof useShellError>,
    "reportShellFailure" | "clearIdentity" | "showSuccessNotice"
  >,
) {
  const { workspaceId, holds, reportShellFailure, clearIdentity } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Map<string, { judged: string; content: string }>());
  // Each row that sent a choice to an outer folder first, by the outer hold.
  const waitingOn = useRef(new Map<string, string>());
  useEffect(() => {
    shown.current = new Map();
    waitingOn.current = new Map();
  }, [workspaceId]);
  const latest = useRef(input);
  latest.current = input;
  const running = useRef(new Map<string, Decision>());

  // The hold's row; `busy` names the pressed button, which reads as working
  // while both wait. A busy row, or one put back after a failure, files
  // without a new toast.
  const show = (asked: string, hold: AccessRuleHold, busy?: Decision, quiet = false): void => {
    const words = accessRuleHoldWords(hold);
    const decide = (decision: Decision) => () => decideRef.current(asked, hold, decision);
    const action: NonNullable<ShellError["action"]> = {
      label: busy === "restore" ? "Restoring…" : "Restore rule",
      run: decide("restore"),
      additional: [
        { label: busy === "accept" ? words.accepting : words.accept, run: decide("accept") },
      ],
      ...(busy ? { busy: busy === "restore" ? 0 : 1 } : {}),
      // A choice runs on its row, so Notices stays open on what it does.
      stays: true,
    };
    latest.current.reportShellFailure({
      identity: identityOf(hold),
      tone: "warning",
      title: words.title,
      message: words.message,
      ...(words.rows.length ? { rows: words.rows } : {}),
      retry: null,
      noDismiss: true,
      ...(busy || quiet ? { quiet: true } : {}),
      details: [
        [
          "Recorded rule",
          hold.recordedRule ?? (hold.unreadable === "recorded" ? "unreadable" : "none"),
        ],
        ["Noticed", new Date(hold.recordedAtMs).toLocaleString()],
      ],
      target: targetOf(hold),
      action,
    });
  };

  // An outer folder's rule changed outside dohc too, so the owner chooses
  // for it first; its notice is a press away.
  const waitFor = (hold: AccessRuleHold, outer: string, what: string): void => {
    const waits = waitsOf(identityOf(hold));
    const outerIdentity = identityOf({ versionId: hold.versionId, folder: outer });
    waitingOn.current.set(waits, outerIdentity);
    latest.current.reportShellFailure({
      identity: waits,
      tone: "warning",
      title: `Choose for ${rulePossessive(outer)} first`,
      message: `${what} for ${placeOf(hold.folder)} wasn't applied. ${ruleOf(outer)} also changed outside dohc.`,
      retry: null,
      action: {
        label: "Show its notice",
        run: () => latest.current.showNotice(outerIdentity),
        ends: true,
      },
    });
  };

  const undo = (asked: string, hold: AccessRuleHold, change: AccessRuleUndo): void => {
    const place = placeOf(hold.folder);
    void bridge()
      .decideAccessRule({
        workspaceId: asked,
        versionId: hold.versionId,
        folder: hold.folder,
        decision: "undo",
        undo: change,
      })
      .then(
        () => {
          if (currentWorkspace.current !== asked) return;
          latest.current.showSuccessNotice(`${ruleOf(hold.folder)} is back as it was.`);
        },
        (error: unknown) => {
          if (currentWorkspace.current !== asked) return;
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            waitFor(hold, outer, "Your undo");
            return;
          }
          const title = `dohc could not undo your choice for ${place}`;
          const details: ShellError["details"] = [["Path", change.path]];
          if (isAccessRuleChangedRefusal(error)) {
            // Trying again meets the same changed rule; History holds the earlier one.
            latest.current.reportShellFailure({
              title,
              message: `${ruleOf(hold.folder)} changed since you chose. Its earlier versions are in History.`,
              cause: error,
              details,
              retry: null,
              action: { label: "Open History", run: latest.current.openHistory, ends: true },
            });
            return;
          }
          latest.current.reportShellFailure({
            title,
            message: `${ruleOf(hold.folder)} stays as you chose.`,
            cause: error,
            details,
            retry: () => undo(asked, hold, change),
          });
        },
      );
  };

  const decide = (asked: string, hold: AccessRuleHold, decision: Decision): void => {
    const identity = identityOf(hold);
    if (running.current.has(identity)) return;
    running.current.set(identity, decision);
    show(asked, hold, decision);
    void bridge()
      .decideAccessRule({
        workspaceId: asked,
        versionId: hold.versionId,
        folder: hold.folder,
        decision,
        expectedSha256: hold.observedSha256,
        expectedReason: hold.reason,
      })
      .finally(() => running.current.delete(identity))
      .then(
        (decided) => {
          if (currentWorkspace.current !== asked) return;
          const message = accessRuleDecidedWords(hold, decision, decided.kept);
          // Where no file change reverses it, the earlier rule is in History.
          const step: ShellError["action"] = decided.undo
            ? { label: "Undo", run: () => undo(asked, hold, decided.undo!), ends: true }
            : decision === "accept"
              ? { label: "Open History", run: latest.current.openHistory, ends: true }
              : undefined;
          latest.current.showSuccessNotice(message, undefined, undefined, step);
        },
        (error: unknown) => {
          if (currentWorkspace.current !== asked) return;
          show(asked, hold, undefined, true);
          // A changed rule comes back as its notice, judged again, and a hold
          // decided already leaves with the list that follows.
          if (isAccessRuleChangedRefusal(error) || isAccessRuleNotHeldRefusal(error)) return;
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            waitFor(hold, outer, "Your choice");
            return;
          }
          const place = placeOf(hold.folder);
          latest.current.reportShellFailure({
            title:
              decision === "restore"
                ? `dohc could not restore ${ruleOfLower(hold.folder)}`
                : `dohc could not change access to ${place}`,
            message: `dohc still doesn't record or share changes in ${place}. Members keep their earlier access.`,
            cause: error,
            retry: () => decideRef.current(asked, hold, decision),
          });
        },
      );
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;
  const showRef = useRef(show);
  showRef.current = show;

  useEffect(() => {
    if (holds === undefined) return;
    const listed = new Set(holds.map(identityOf));
    for (const identity of shown.current.keys()) {
      if (listed.has(identity)) continue;
      shown.current.delete(identity);
      clearIdentity(identity);
      clearIdentity(waitsOf(identity));
      // A choice that waited for this folder waits for nothing now.
      for (const [waits, outer] of waitingOn.current) {
        if (outer !== identity) continue;
        waitingOn.current.delete(waits);
        clearIdentity(waits);
      }
    }
    // Notices lists the newest first, so the outer folder files last.
    for (const hold of [...holds].sort((a, b) => depth(b.folder) - depth(a.folder))) {
      const identity = identityOf(hold);
      const was = shown.current.get(identity);
      const next = { judged: judgedKey(hold), content: shownContent(hold) };
      if (was?.judged === next.judged && was.content === next.content) continue;
      shown.current.set(identity, next);
      // The same judgment with new rows updates its row without a toast.
      showRef.current(
        workspaceId,
        hold,
        running.current.get(identity),
        was?.judged === next.judged,
      );
    }
  }, [holds, workspaceId, reportShellFailure, clearIdentity]);
}
