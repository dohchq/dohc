import { useEffect, useRef } from "react";
import type { AccessRuleHold, AccessRuleReach, AccessRuleUndo } from "../../ipc/bridgeContract";
import { heldOuterAccessRuleFolder, isAccessRuleChangedRefusal } from "../../ipc/errorWords";
import type { NoticeTarget } from "../../notices/noticeTarget";
import { bridge } from "../bridge";
import type { ShellError, useShellError } from "./useShellError";

type Decision = "accept" | "restore";

const identityOf = (hold: Pick<AccessRuleHold, "versionId" | "folder">) =>
  `access-rule:${hold.versionId}:${hold.folder}`;
// A hold the engine judged again, such as after a decision on a rule that
// changed since, reads as a new notice.
const shownKey = (hold: AccessRuleHold) =>
  `${identityOf(hold)}|${hold.reason}|${hold.observedSha256 ?? ""}`;
// Outer folders first: an inner folder's decision waits for theirs.
const depth = (folder: string) => (folder === "" ? 0 : folder.split("/").length);

const REACH: Record<AccessRuleReach, string> = {
  view: "View",
  comment: "Comment",
  edit: "Edit",
  none: "none",
  workspace: "workspace access",
};

/** The place a hold is about, in a sentence: the folder, or this workspace for its own rule. */
const placeOf = (folder: string) => folder || "this workspace";
const ruleOf = (folder: string) =>
  folder ? `The access rule for ${folder}` : "The workspace's access rule";
const ruleOfLower = (folder: string) =>
  folder ? `the access rule for ${folder}` : "the workspace's access rule";

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
  const until = `Until you choose, dohc doesn't record or share changes in ${place}, and members keep their earlier access.`;
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
    message: `${until}${unreadable || (rows.length ? " Allowing the new rule gives:" : "")}`,
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
    const keptCopy = kept[0]
      ? ` dohc kept the rule from outside dohc as a kept copy of ${kept[0]}.`
      : "";
    return `Restored ${ruleOfLower(hold.folder)}.${keptCopy}`;
  }
  if (hold.reason === "removed")
    return `Removed ${ruleOfLower(hold.folder)}. ${place === "this workspace" ? "This workspace" : place} now follows ${fallbackOf(hold)}.`;
  const [only] = hold.changes;
  if (hold.changes.length === 1 && only && only.after !== "none" && only.after !== "workspace") {
    return only.who === "members"
      ? `Members now reach ${place} at ${REACH[only.after]}.`
      : `${only.who} now reaches ${place} at ${REACH[only.after]}.`;
  }
  return `${place === "this workspace" ? "This workspace" : place} now follows the new access rule.`;
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
  const shown = useRef(new Map<string, string>());
  useEffect(() => {
    shown.current = new Map();
  }, [workspaceId]);
  const latest = useRef(input);
  latest.current = input;
  const running = useRef(new Set<string>());

  // The hold's row; `busy` names the pressed button, which reads as working
  // while both wait. A busy row, or one put back after a failure, files
  // without a new toast.
  const show = (asked: string, hold: AccessRuleHold, busy?: Decision): void => {
    const words = accessRuleHoldWords(hold);
    const decide = (decision: Decision) => () => decideRef.current(asked, hold, decision);
    const action: NonNullable<ShellError["action"]> = {
      label: busy === "restore" ? "Restoring…" : "Restore rule",
      run: decide("restore"),
      additional: [
        { label: busy === "accept" ? words.accepting : words.accept, run: decide("accept") },
      ],
      ...(busy ? { busy: busy === "restore" ? 0 : 1 } : {}),
    };
    latest.current.reportShellFailure({
      identity: identityOf(hold),
      tone: "warning",
      title: words.title,
      message: words.message,
      ...(words.rows.length ? { rows: words.rows } : {}),
      retry: null,
      noDismiss: true,
      ...(busy ? { quiet: true } : {}),
      details: [
        ["Folder", placeOf(hold.folder)],
        [
          "Recorded rule",
          hold.recordedRule ?? (hold.unreadable === "recorded" ? "unreadable" : "none"),
        ],
        ["Noticed", new Date(hold.recordedAtMs).toISOString()],
      ],
      target: targetOf(hold),
      action,
    });
  };

  const undo = (asked: string, hold: AccessRuleHold, change: AccessRuleUndo): void => {
    const writes = bridge();
    const done =
      change.text === null
        ? writes.deleteWorkspacePath({ workspaceId: asked, relativePath: change.path })
        : change.expectedSha256 === null
          ? writes.createWorkspaceFile({
              workspaceId: asked,
              relativePath: change.path,
              initialText: change.text,
              exclusive: true,
            })
          : writes.writeWorkspaceText({
              workspaceId: asked,
              relativePath: change.path,
              text: change.text,
              expectedContentHash: change.expectedSha256,
            });
    void Promise.resolve(done).then(
      () => undefined,
      (error: unknown) => {
        if (currentWorkspace.current !== asked) return;
        latest.current.reportShellFailure({
          title: `dohc could not undo the change to ${ruleOfLower(hold.folder)}`,
          message: `${ruleOf(hold.folder)} stays as you chose.`,
          cause: error,
          details: [
            ["Folder", placeOf(hold.folder)],
            ["Path", change.path],
          ],
          retry: () => undo(asked, hold, change),
        });
      },
    );
  };

  const decide = (asked: string, hold: AccessRuleHold, decision: Decision): void => {
    const identity = identityOf(hold);
    if (running.current.has(identity)) return;
    running.current.add(identity);
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
          // A changed rule comes back as its notice, judged again.
          if (isAccessRuleChangedRefusal(error)) return;
          show(asked, hold);
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            latest.current.reportShellFailure({
              identity: `${identity}:waits`,
              tone: "warning",
              title: `Decide ${placeOf(outer)} first`,
              message: `${ruleOf(outer)} also changed outside dohc.`,
              retry: null,
              action: {
                label: `Show ${outer || "workspace"}`,
                run: () =>
                  latest.current.showNotice(
                    identityOf({ versionId: hold.versionId, folder: outer }),
                  ),
                ends: true,
              },
            });
            return;
          }
          const place = placeOf(hold.folder);
          latest.current.reportShellFailure({
            title:
              decision === "restore"
                ? `dohc could not restore ${ruleOfLower(hold.folder)}`
                : `dohc could not change access to ${place}`,
            message: `dohc still doesn't record or share changes in ${place}, and members keep their earlier access.`,
            cause: error,
            details: [["Folder", place]],
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
    const listed = new Map(holds.map((hold) => [identityOf(hold), shownKey(hold)]));
    for (const identity of shown.current.keys()) {
      if (listed.has(identity)) continue;
      shown.current.delete(identity);
      clearIdentity(identity);
      clearIdentity(`${identity}:waits`);
    }
    // Notices lists the newest first, so the outer folder files last.
    for (const hold of [...holds].sort((a, b) => depth(b.folder) - depth(a.folder))) {
      const identity = identityOf(hold);
      if (shown.current.get(identity) === shownKey(hold)) continue;
      shown.current.set(identity, shownKey(hold));
      showRef.current(workspaceId, hold);
    }
  }, [holds, workspaceId, reportShellFailure, clearIdentity]);
}
