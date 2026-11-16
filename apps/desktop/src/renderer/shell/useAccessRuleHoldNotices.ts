import { useCallback, useEffect, useRef, useState } from "react";
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
/** The level members get where no rule sets one, from Members settings; null when dohc can't read it. */
export type MemberLevel = Extract<AccessRuleReach, "view" | "comment" | "edit"> | null;

const identityOf = (hold: Pick<AccessRuleHold, "versionId" | "folder">) =>
  `access-rule:${hold.versionId}:${hold.folder}`;
const waitsOf = (identity: string) => `${identity}:waits`;
const decidedOf = (identity: string) => `${identity}:decided`;
// A hold the engine judged again, such as after a decision on a rule that
// changed since, reads as a new notice.
const judgedKey = (hold: AccessRuleHold) => `${hold.reason}|${hold.observedSha256 ?? ""}`;
// A hold dohc noticed again, even with the same judgment, has a new time.
const heldKey = (hold: AccessRuleHold) => `${judgedKey(hold)}|${hold.recordedAtMs}`;
// Outer folders first: an inner folder's decision waits for theirs.
const depth = (folder: string) => (folder === "" ? 0 : folder.split("/").length);

/** Whether the hold's words name the level members get without a rule. */
const usesMemberLevel = (hold: AccessRuleHold) =>
  (hold.reason === "removed" && hold.fallsBackTo === null) ||
  hold.changes.some((change) => change.before === "workspace" || change.after === "workspace");

// Anything else its row shows, which updates the row where it stands.
const shownContent = (hold: AccessRuleHold, level: MemberLevel) =>
  JSON.stringify([
    hold.recordedRule,
    hold.rulePath,
    hold.changes,
    hold.unreadable,
    hold.fallsBackTo,
    hold.recordedAtMs,
    usesMemberLevel(hold) ? level : null,
  ]);

const LEVEL: Record<Exclude<AccessRuleReach, "workspace">, string> = {
  view: "View",
  comment: "Comment",
  edit: "Edit",
  none: "No access",
};
const IN_SETTINGS = "set in Members settings";
// What a level lets someone do to a place, in a sentence.
const CAN: Partial<Record<AccessRuleReach, string>> = {
  view: "view",
  comment: "comment on",
  edit: "edit",
};
// The same, where the place is the whole workspace and goes unsaid.
const CAN_HERE: Partial<Record<AccessRuleReach, string>> = {
  view: "view",
  comment: "comment",
  edit: "edit",
};
/** What a level lets someone do to a folder, or to the workspace for its own rule; undefined for none. */
const canDo = (reach: AccessRuleReach | null | undefined, folder: string) => {
  if (!reach) return undefined;
  const verb = (folder ? CAN : CAN_HERE)[reach];
  return verb && (folder ? `${verb} ${folder}` : verb);
};

const whoOf = (who: string) => (who === "members" ? "Members" : who);
/** A reach with the workspace's member level put in, or null when dohc can't read it. */
const resolve = (reach: AccessRuleReach, level: MemberLevel): AccessRuleReach | null =>
  reach === "workspace" ? level : reach;
const reachWords = (reach: AccessRuleReach, level: MemberLevel) => {
  const resolved = resolve(reach, level);
  return resolved === null || resolved === "workspace" ? IN_SETTINGS : LEVEL[resolved];
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

export function accessRuleHoldWords(
  hold: AccessRuleHold,
  level: MemberLevel,
): {
  title: string;
  message: string;
  rows: string[];
  accept: string;
  accepting: string;
  openMembers: boolean;
} {
  const place = placeOf(hold.folder);
  const until = `Until you choose, dohc doesn't record or share changes in ${place}. Members keep their earlier access.`;
  const rows = hold.changes.map(
    (change) =>
      `${whoOf(change.who)}: ${reachWords(change.before, level)} → ${reachWords(change.after, level)}`,
  );
  const openMembers = level === null && usesMemberLevel(hold);
  const hides = hold.unreadable === "on-disk";
  const unreadable =
    hold.unreadable === "recorded"
      ? " dohc can't read the rule it recorded, so it can't list who gains access."
      : hides
        ? ` dohc can't read the access rule now on disk. Allowing it hides ${place} from members.`
        : "";
  const accept = hides ? { accept: "Hide from members", accepting: "Hiding…" } : null;
  if (hold.reason === "removed") {
    const without =
      hold.fallsBackTo !== null
        ? `${place} follows ${ruleOfLower(hold.fallsBackTo)}.`
        : `members get the level ${IN_SETTINGS}.${level === null ? " dohc can't read that level now." : ""}`;
    return {
      title: `${ruleOf(hold.folder)} was removed outside dohc`,
      message: `${until} Without it, ${without}${unreadable}`,
      rows,
      openMembers,
      ...(accept ?? { accept: "Remove rule", accepting: "Removing…" }),
    };
  }
  return {
    title: `Access to ${place} was widened outside dohc`,
    message: `${until} Restoring keeps the rule from outside dohc as a copy.${unreadable || (rows.length ? " Allowing the new rule gives:" : "")}`,
    rows,
    openMembers,
    ...(accept ?? { accept: "Allow new access", accepting: "Allowing…" }),
  };
}

/** What members can do in the place once the hold's change takes effect. */
function changedReach(hold: AccessRuleHold, level: MemberLevel): string {
  if (hold.reason === "removed" && hold.fallsBackTo !== null) {
    return `${placeOpening(hold.folder)} now follows ${ruleOfLower(hold.fallsBackTo)}.`;
  }
  if (hold.reason === "removed") {
    // Without a rule anywhere above, every member gets the same level.
    const can = canDo(level, hold.folder);
    return can ? `Members can now ${can}.` : `Members now get the level ${IN_SETTINGS}.`;
  }
  const [only] = hold.changes;
  const can = only && canDo(resolve(only.after, level), hold.folder);
  if (hold.changes.length === 1 && only && can) return `${whoOf(only.who)} can now ${can}.`;
  return `${placeOpening(hold.folder)} now follows the new access rule.`;
}

/** What took effect, for the toast that follows a decision. */
export function accessRuleDecidedWords(
  hold: AccessRuleHold,
  decision: Decision,
  kept: readonly string[],
  level: MemberLevel,
): string {
  if (decision === "restore") {
    const [only] = hold.changes;
    const can =
      hold.changes.length === 1 && only
        ? canDo(resolve(only.before, level), hold.folder)
        : undefined;
    const now = can ? ` ${whoOf(only!.who)} can ${can}.` : "";
    const keptCopy = kept[0] ? ` The rule from outside dohc is saved as a copy of ${kept[0]}.` : "";
    return `Restored ${ruleOfLower(hold.folder)}.${now}${keptCopy}`;
  }
  if (hold.reason === "removed")
    return `Removed ${ruleOfLower(hold.folder)}. ${changedReach(hold, level)}`;
  return changedReach(hold, level);
}

/**
 * What an Undo left, for its toast. Undo of Restore puts the outside change
 * back, so it says what that change gives; Undo of the change puts back the
 * rule dohc recorded.
 */
export function accessRuleUndoneWords(
  hold: AccessRuleHold,
  decision: Decision,
  level: MemberLevel,
): string {
  return decision === "restore"
    ? changedReach(hold, level)
    : `${placeOpening(hold.folder)} follows its earlier access rule again.`;
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
    // Opens Settings at Members, where the owner sets the members' level.
    openMembers: () => void;
  } & Pick<
    ReturnType<typeof useShellError>,
    "reportShellFailure" | "clearIdentity" | "dropNoticeStep" | "showSuccessNotice"
  >,
) {
  const { workspaceId, holds, reportShellFailure, clearIdentity, dropNoticeStep } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Map<string, { judged: string; content: string }>());
  // Each row that sent a choice to an outer folder first, by the outer hold.
  const waitingOn = useRef(new Map<string, string>());
  // Each folder's decision whose toast offers Undo, by the hold it decided.
  const undoable = useRef(new Map<string, string>());
  useEffect(() => {
    shown.current = new Map();
    waitingOn.current = new Map();
    undoable.current = new Map();
  }, [workspaceId]);
  const latest = useRef(input);
  latest.current = input;
  const running = useRef(new Map<string, Decision>());

  // The members' level, read again for each new hold whose words name it.
  // A hold that names it waits for the read, so its toast never changes words.
  const [memberLevel, setMemberLevel] = useState<{
    workspaceId: string;
    key: string;
    level: MemberLevel;
  } | null>(null);
  const levelKey = (holds ?? []).filter(usesMemberLevel).map(judgedKey).join("\n");
  const level =
    memberLevel?.workspaceId === workspaceId && memberLevel.key === levelKey
      ? memberLevel.level
      : undefined;
  const levelRef = useRef<MemberLevel>(null);
  levelRef.current = level ?? memberLevel?.level ?? null;
  const levelKeyRef = useRef(levelKey);
  levelKeyRef.current = levelKey;
  const levelAsked = useRef(0);
  // Resolves to the level as Members settings has it now. Only the latest
  // read updates the rows, so an earlier answer arriving late shows nothing.
  const readLevel = (asked: string): Promise<MemberLevel> => {
    const order = ++levelAsked.current;
    const key = levelKeyRef.current;
    return bridge()
      .workspaceMembers({ workspaceId: asked, request: { action: "list" } })
      .then(
        (result) => (result.status === "ready" ? result.view.memberLevel : null),
        () => null,
      )
      .then((read) => {
        if (levelAsked.current === order && currentWorkspace.current === asked) {
          levelRef.current = read;
          setMemberLevel({ workspaceId: asked, key, level: read });
        }
        return read;
      });
  };
  const readLevelRef = useRef(readLevel);
  readLevelRef.current = readLevel;
  useEffect(() => {
    if (levelKey) void readLevelRef.current(workspaceId);
  }, [workspaceId, levelKey]);
  // The owner may have changed the level in Settings or another window since.
  const readMemberLevel = useCallback(() => {
    if (levelKeyRef.current) void readLevelRef.current(currentWorkspace.current);
  }, []);

  // The hold's row; `busy` names the pressed button, which reads as working
  // while both wait. A busy row, or one put back after a failure, files
  // without a new toast.
  const show = (
    asked: string,
    hold: AccessRuleHold,
    shownLevel: MemberLevel,
    busy?: Decision,
    quiet = false,
  ): void => {
    const words = accessRuleHoldWords(hold, shownLevel);
    const decide = (decision: Decision) => () => decideRef.current(asked, hold, decision);
    const action: NonNullable<ShellError["action"]> = {
      label: busy === "restore" ? "Restoring…" : "Restore rule",
      run: decide("restore"),
      additional: [
        { label: busy === "accept" ? words.accepting : words.accept, run: decide("accept") },
        ...(words.openMembers
          ? [{ label: "Open Members", run: () => latest.current.openMembers() }]
          : []),
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

  // Puts a hold's row back to its choices after one failed, as the engine
  // lists it now. A hold it no longer lists was decided: its row goes.
  const putBack = (asked: string, identity: string): boolean => {
    const now = latest.current.holds?.find((hold) => identityOf(hold) === identity);
    if (now) show(asked, now, levelRef.current, undefined, true);
    else latest.current.clearIdentity(identity);
    return now !== undefined;
  };

  // An outer folder's rule changed outside dohc too, so the owner chooses
  // for it first; its notice is a press away.
  const waitFor = (hold: AccessRuleHold, outer: string, what: "choice" | "undo"): void => {
    const waits = waitsOf(identityOf(hold));
    const outerIdentity = identityOf({ versionId: hold.versionId, folder: outer });
    waitingOn.current.set(waits, outerIdentity);
    latest.current.reportShellFailure({
      identity: waits,
      tone: "warning",
      title: `Choose for ${rulePossessive(outer)} first`,
      message: `dohc didn't apply your ${what} for ${placeOf(hold.folder)}. ${ruleOf(outer)} also changed outside dohc.`,
      retry: null,
      action: {
        label: "Show its notice",
        run: () => latest.current.showNotice(outerIdentity),
        ends: true,
      },
    });
  };

  const undo = (
    asked: string,
    hold: AccessRuleHold,
    decision: Decision,
    change: AccessRuleUndo,
  ): void => {
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
          latest.current.showSuccessNotice(accessRuleUndoneWords(hold, decision, levelRef.current));
        },
        (error: unknown) => {
          if (currentWorkspace.current !== asked) return;
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            waitFor(hold, outer, "undo");
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
            retry: () => undo(asked, hold, decision, change),
          });
        },
      );
  };

  const decide = (asked: string, hold: AccessRuleHold, decision: Decision): void => {
    const identity = identityOf(hold);
    if (running.current.has(identity)) return;
    running.current.set(identity, decision);
    const shownLevel = levelRef.current;
    show(asked, hold, shownLevel, decision);
    // The row's words name the members' level, so the choice runs only on
    // the level the owner saw. A changed one updates the row instead.
    if (!usesMemberLevel(hold)) {
      run(asked, hold, decision, shownLevel);
      return;
    }
    void readLevel(asked).then((now) => {
      if (now === shownLevel) {
        run(asked, hold, decision, now);
        return;
      }
      running.current.delete(identity);
      if (currentWorkspace.current === asked) putBack(asked, identity);
    });
  };

  const run = (asked: string, hold: AccessRuleHold, decision: Decision, now: MemberLevel): void => {
    const identity = identityOf(hold);
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
          const message = accessRuleDecidedWords(hold, decision, decided.kept, now);
          // Where no file change reverses it, the earlier rule is in History.
          const step: ShellError["action"] = decided.undo
            ? { label: "Undo", run: () => undo(asked, hold, decision, decided.undo!), ends: true }
            : decision === "accept"
              ? { label: "Open History", run: latest.current.openHistory, ends: true }
              : undefined;
          if (decided.undo) undoable.current.set(identity, heldKey(hold));
          latest.current.showSuccessNotice(
            message,
            undefined,
            undefined,
            step,
            undefined,
            decidedOf(identity),
          );
        },
        (error: unknown) => {
          if (currentWorkspace.current !== asked) return;
          // A changed rule comes back as its notice, judged again, and a hold
          // decided already leaves with the list that follows.
          if (
            !putBack(asked, identity) ||
            isAccessRuleChangedRefusal(error) ||
            isAccessRuleNotHeldRefusal(error)
          )
            return;
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            waitFor(hold, outer, "choice");
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
      // The folder is held again, so an earlier decision's Undo would put
      // back a rule the owner has not seen since.
      const decided = undoable.current.get(identity);
      if (decided !== undefined && decided !== heldKey(hold)) {
        undoable.current.delete(identity);
        dropNoticeStep(decidedOf(identity));
      }
      if (level === undefined && usesMemberLevel(hold)) continue;
      const was = shown.current.get(identity);
      const next = { judged: judgedKey(hold), content: shownContent(hold, level ?? null) };
      if (was?.judged === next.judged && was.content === next.content) continue;
      shown.current.set(identity, next);
      // The same judgment with new rows updates its row without a toast.
      showRef.current(
        workspaceId,
        hold,
        level ?? null,
        running.current.get(identity),
        was?.judged === next.judged,
      );
    }
  }, [holds, level, workspaceId, reportShellFailure, clearIdentity, dropNoticeStep]);

  return { readMemberLevel };
}
