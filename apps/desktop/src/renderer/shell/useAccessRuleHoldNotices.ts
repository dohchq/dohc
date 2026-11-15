import { useEffect, useRef } from "react";
import type { AccessRuleHold } from "../../ipc/bridgeContract";
import { isAccessRuleChangedRefusal } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

const identityOf = (hold: AccessRuleHold) => `access-rule:${hold.versionId}:${hold.folder}`;
// A hold the engine judged again, such as after a decision on a rule that
// changed since, reads as a new notice.
const shownKey = (hold: AccessRuleHold) =>
  `${identityOf(hold)}|${hold.reason}|${hold.observedSha256 ?? ""}`;

export function accessRuleHoldWords(
  hold: AccessRuleHold,
  workspaceName: string,
): { title: string; accept: string } {
  const folder = hold.folder || workspaceName;
  return hold.reason === "removed"
    ? { title: `The access rule for ${folder} was removed outside dohc`, accept: "Remove access" }
    : { title: `Access for ${folder} was widened outside dohc`, accept: "Allow" };
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
    workspaceName: string;
    holds: readonly AccessRuleHold[] | undefined;
  } & Pick<ReturnType<typeof useShellError>, "reportShellFailure" | "clearIdentity">,
) {
  const { workspaceId, workspaceName, holds, reportShellFailure, clearIdentity } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Map<string, string>());
  useEffect(() => {
    shown.current = new Map();
  }, [workspaceId]);
  const latest = useRef({ reportShellFailure });
  latest.current = { reportShellFailure };
  const running = useRef(new Set<string>());

  const decide = (
    asked: string,
    hold: AccessRuleHold,
    decision: "accept" | "restore",
    name: string,
  ): void => {
    const identity = identityOf(hold);
    if (running.current.has(identity)) return;
    running.current.add(identity);
    void bridge()
      .decideAccessRule({
        workspaceId: asked,
        folder: hold.folder,
        decision,
        expectedSha256: hold.observedSha256,
      })
      .finally(() => running.current.delete(identity))
      .catch((error: unknown) => {
        // A changed rule comes back as its notice, judged again.
        if (currentWorkspace.current !== asked || isAccessRuleChangedRefusal(error)) return;
        const folder = hold.folder || name;
        latest.current.reportShellFailure({
          title:
            decision === "restore"
              ? `dohc could not restore the access rule for ${folder}`
              : `dohc could not change access for ${folder}`,
          message: "Changes in this folder still wait, and members keep their earlier access.",
          cause: error,
          details: [["Folder", folder]],
          retry: () => decide(asked, hold, decision, name),
        });
      });
  };
  const decideRef = useRef(decide);
  decideRef.current = decide;

  useEffect(() => {
    if (holds === undefined) return;
    const listed = new Map(holds.map((hold) => [identityOf(hold), shownKey(hold)]));
    for (const identity of shown.current.keys()) {
      if (listed.has(identity)) continue;
      shown.current.delete(identity);
      clearIdentity(identity);
    }
    for (const hold of holds) {
      const identity = identityOf(hold);
      if (shown.current.get(identity) === shownKey(hold)) continue;
      shown.current.set(identity, shownKey(hold));
      const words = accessRuleHoldWords(hold, workspaceName);
      reportShellFailure({
        identity,
        tone: "warning",
        title: words.title,
        message:
          "Until you choose, changes in this folder wait and members keep their earlier access.",
        retry: null,
        noDismiss: true,
        details: [["Folder", hold.folder || workspaceName]],
        action: {
          label: words.accept,
          run: () => decideRef.current(workspaceId, hold, "accept", workspaceName),
          additional: [
            {
              label: "Restore rule",
              run: () => decideRef.current(workspaceId, hold, "restore", workspaceName),
            },
          ],
        },
      });
    }
  }, [holds, workspaceId, workspaceName, reportShellFailure, clearIdentity]);
}
