import { useCallback, useEffect, useRef, useState } from "react";
import type { AccessRuleHold, AccessRuleReach } from "../../ipc/bridgeContract";
import {
  heldOuterAccessRuleFolder,
  isAccessRuleChangedRefusal,
  isAccessRuleNotHeldRefusal,
  isFileLockedError,
  readError,
} from "../../ipc/errorWords";
import type { NoticeTarget } from "../../notices/noticeTarget";
import { bridge } from "../bridge";
import type { ShellError, useShellError } from "./useShellError";

type Decision = "accept" | "restore";
/** The level members get where no rule sets one, from Members settings; null when dohc can't read it. */
export type MemberLevel = Extract<AccessRuleReach, "view" | "comment" | "edit"> | null;

const identityOf = (hold: Pick<AccessRuleHold, "versionId" | "folder">) =>
  `access-rule:${hold.versionId}:${hold.folder}`;
// Each kind of row has its own prefix, since a folder name may contain ":waits".
const waitsOf = (identity: string) => `waits-${identity}`;
const decidedOf = (identity: string) => `decided-${identity}`;
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
    hold.canAccept,
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

// A refusal dohc has words for, such as a rule file another program holds
// or a moved workspace folder, says what to do, so its words replace the
// row's own. `final` is one that trying again only repeats. Beside Try
// again, the words end at what to do first.
const refusalWords = (error: unknown): { words: string; final: boolean } | null => {
  const read = readError(error);
  if (!read.mapped || !read.words) return null;
  const final = read.canRetry === false;
  return { words: final ? read.words : read.words.replace(/, then try again\.$/u, "."), final };
};

/** Why a choice didn't run: the level read at the press differs from the one the row showed. */
type LevelMove = "changed" | "unreadable" | "readable";
const LEVEL_MOVED: Record<LevelMove, string> = {
  changed: "dohc didn't apply your choice because the members' level changed in Members settings.",
  unreadable: "dohc didn't apply your choice because it can't read the members' level now.",
  readable: "dohc didn't apply your choice because it can now read the members' level.",
};
const levelMove = (shown: MemberLevel, now: MemberLevel): LevelMove =>
  now === null ? "unreadable" : shown === null ? "readable" : "changed";

/** The place a hold is about, in a sentence: the folder, or this workspace for its own rule. */
const placeOf = (folder: string) => folder || "this workspace";
// The same place opening a sentence; a folder keeps its own spelling.
const placeOpening = (folder: string) => folder || "This workspace";
const ruleOf = (folder: string) =>
  folder ? `The access rule for ${folder}` : "The workspace's access rule";
const ruleOfLower = (folder: string) =>
  folder ? `the access rule for ${folder}` : "the workspace's access rule";

// While dohc can't read the widened rule on disk, the row leads with what the
// owner does about it, so the row's three lines show it without Show more.
// Neither choice can read a locked or unreadable file, so they offer no
// change to allow. A locked rule names its file, as it is spelled on disk, so
// the owner can find it in the program that has it open.
const ON_DISK: Record<"locked" | "on-disk", (folder: string, path: string | null) => string> = {
  locked: (folder, path) =>
    `Close ${path ?? ruleOfLower(folder)} in the program that has it open, so dohc can read it.`,
  "on-disk": (folder, path) => `Check that you can open ${path ?? ruleOfLower(folder)}.`,
};

export function accessRuleHoldWords(
  hold: AccessRuleHold,
  level: MemberLevel,
): {
  title: string;
  message: string;
  rows: string[];
  openMembers: boolean;
  // Null when the rule cannot be read or safely published.
  accept: { label: string; busy: string } | null;
} {
  const place = placeOf(hold.folder);
  const until = `Until you choose, dohc doesn't record or share changes in ${place}.`;
  const rows = hold.changes.map((change) => {
    const [before, after] = [reachWords(change.before, level), reachWords(change.after, level)];
    // With the member level read in, a removal can turn out to change nothing.
    return `${whoOf(change.who)}: ${before === after ? `${before}, no change` : `${before} → ${after}`}`;
  });
  const openMembers = level === null && usesMemberLevel(hold);
  const recordedUnread =
    hold.unreadable === "recorded"
      ? " dohc can't read the rule it recorded, so it can't list who gains access."
      : "";
  // The engine reads a removed rule's disk not at all, so only a widening
  // can say why it can't show the rule on disk.
  if (hold.reason === "removed") {
    const without =
      hold.fallsBackTo !== null
        ? `${place} follows ${ruleOfLower(hold.fallsBackTo)}.`
        : `members get the level ${IN_SETTINGS}.${level === null ? " dohc can't read that level now." : ""}`;
    return {
      title: `${ruleOf(hold.folder)} was removed outside dohc`,
      message: hold.canAccept
        ? `${until} Without it, ${without}`
        : `Without it, ${without} dohc can't remove these files one at a time without briefly giving members more access. To remove the rule, restore it. Edit one file so it gives members View and names no one else. Delete all the files at once. Then choose Remove rule.`,
      rows,
      openMembers,
      accept: hold.canAccept ? { label: "Remove rule", busy: "Removing…" } : null,
    };
  }
  // Several readable spellings record as one rule members can't read, so
  // recording them hides the folder. Restore keeps each file from outside
  // dohc as a copy, so it loses nothing.
  if (hold.unreadable === "several-files") {
    return {
      title: hold.folder
        ? `More than one access rule file in ${hold.folder}`
        : "This workspace has more than one access rule file",
      message: !hold.canAccept
        ? "dohc can't record these files without briefly giving members more access. Restore, then put the rule in one file."
        : hold.recordedRule === null
          ? `${until} Restoring removes these access rule files and keeps them as copies.`
          : `${until} Restoring puts back the rule dohc recorded and keeps the files from outside dohc as copies.`,
      rows,
      openMembers,
      accept: hold.canAccept ? { label: "Hide from members", busy: "Hiding…" } : null,
    };
  }
  // dohc can't read the rule, so it can't say whether access widened.
  // Restore rule is its one step, and once dohc reads the rule the row asks
  // again, so it names no choice between two.
  if (hold.unreadable === "locked" || hold.unreadable === "on-disk") {
    const lead = ON_DISK[hold.unreadable](hold.folder, hold.rulePath);
    return {
      title: `dohc could not read ${ruleOfLower(hold.folder)}`,
      message: `${lead} Until you decide on this rule, dohc doesn't record or share changes in ${place}.`,
      rows,
      openMembers,
      accept: null,
    };
  }
  const title = `Access to ${place} was widened outside dohc`;
  return {
    title,
    message: `${until} Restoring keeps the rule from outside dohc as a copy.${recordedUnread}`,
    rows,
    openMembers,
    accept: hold.canAccept ? { label: "Allow new access", busy: "Allowing…" } : null,
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
    const members = hold.changes.find((change) => change.who === "members");
    const same = members !== undefined && resolve(members.before, level) === level;
    return can
      ? `Members can ${same ? "still" : "now"} ${can}.`
      : `Members now get the level ${IN_SETTINGS}.`;
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
    if (hold.unreadable === "several-files" && hold.recordedRule === null) {
      const copies = kept.length ? " dohc kept them as copies in Notices." : "";
      return `Removed the new access rule files from ${placeOf(hold.folder)}.${copies}`;
    }
    const [only] = hold.changes;
    const can =
      hold.changes.length === 1 && only
        ? canDo(resolve(only.before, level), hold.folder)
        : undefined;
    const now = can ? ` ${whoOf(only!.who)} can ${can}.` : "";
    // Each kept copy has its own unread row with Save copy.
    return `Restored ${ruleOfLower(hold.folder)}.${now}`;
  }
  if (hold.reason === "removed")
    return `Removed ${ruleOfLower(hold.folder)}. ${changedReach(hold, level)}`;
  if (hold.unreadable === "several-files") return `Hid ${placeOf(hold.folder)} from members.`;
  return changedReach(hold, level);
}

/**
 * Where a press on the row goes: a widening opens its rule; a removal, or a
 * rule another program holds, reveals its folder.
 */
function targetOf(hold: AccessRuleHold): NoticeTarget {
  return hold.reason === "widened" && hold.rulePath && hold.unreadable !== "locked"
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
    "reportShellFailure" | "clearIdentity" | "showSuccessNotice"
  >,
) {
  const { workspaceId, holds, reportShellFailure, clearIdentity } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  const shown = useRef(new Map<string, { judged: string; content: string }>());
  // Each row that sent a choice to an outer folder first, by the outer hold.
  const waitingOn = useRef(new Map<string, string>());
  // Each hold whose choice didn't run because the level changed, until the
  // owner chooses again.
  const levelMoved = useRef(new Map<string, { held: string; why: LevelMove }>());
  // Each hold whose choice failed because another program had its rule file
  // open, and whether the list has shown the file held since. Once the
  // program lets go, the failure's words are no longer true, so it goes.
  const lockFailed = useRef(new Map<string, boolean>());
  useEffect(() => {
    shown.current = new Map();
    waitingOn.current = new Map();
    levelMoved.current = new Map();
    lockFailed.current = new Map();
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
  const latestRead = useRef<Promise<MemberLevel>>(Promise.resolve(null));
  // Resolves to the level as Members settings has it now. Only the latest
  // read updates the rows, and an earlier read resolves to the latest one's
  // answer, so a late answer neither shows nor lets a choice run.
  const readLevel = (asked: string): Promise<MemberLevel> => {
    const order = ++levelAsked.current;
    const key = levelKeyRef.current;
    const read = bridge()
      .workspaceMembers({ workspaceId: asked, request: { action: "list" } })
      .then(
        (result) => (result.status === "ready" ? result.view.memberLevel : null),
        () => null,
      )
      .then((level): MemberLevel | Promise<MemberLevel> => {
        if (levelAsked.current !== order) return latestRead.current;
        if (currentWorkspace.current === asked) {
          levelRef.current = level;
          setMemberLevel({ workspaceId: asked, key, level });
        }
        return level;
      });
    latestRead.current = read;
    return read;
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
    const moved = levelMoved.current.get(identityOf(hold));
    const lead = moved?.held === heldKey(hold) ? LEVEL_MOVED[moved.why] : undefined;
    const decide = (decision: Decision) => () => decideRef.current(asked, hold, decision);
    const action: NonNullable<ShellError["action"]> = {
      label: busy === "restore" ? "Restoring…" : "Restore rule",
      run: decide("restore"),
      additional: [
        ...(words.accept
          ? [
              {
                label: busy === "accept" ? words.accept.busy : words.accept.label,
                run: decide("accept"),
              },
            ]
          : []),
        ...(words.openMembers || lead
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
      ...(lead ? { lead } : {}),
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
        ["Until you choose", "Members keep their earlier access."],
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
  const waitFor = (hold: AccessRuleHold, outer: string): void => {
    const waits = waitsOf(identityOf(hold));
    const outerIdentity = identityOf({ versionId: hold.versionId, folder: outer });
    waitingOn.current.set(waits, outerIdentity);
    latest.current.reportShellFailure({
      identity: waits,
      tone: "warning",
      title: `Decide on ${ruleOfLower(outer)} first`,
      message: `dohc didn't apply your choice for ${placeOf(hold.folder)}. ${ruleOf(outer)} also changed outside dohc.`,
      retry: null,
      action: {
        label: "Show its notice",
        run: () => latest.current.showNotice(outerIdentity),
        ends: true,
      },
    });
  };

  const decide = (asked: string, hold: AccessRuleHold, decision: Decision): void => {
    const identity = identityOf(hold);
    if (running.current.has(identity)) return;
    running.current.set(identity, decision);
    levelMoved.current.delete(identity);
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
      if (currentWorkspace.current !== asked) return;
      // The row comes back unread, with a toast, saying why nothing ran, so
      // a second press is made on the words it shows now.
      const listed = latest.current.holds?.find((held) => identityOf(held) === identity);
      if (!listed) {
        latest.current.clearIdentity(identity);
        return;
      }
      levelMoved.current.set(identity, { held: heldKey(listed), why: levelMove(shownLevel, now) });
      show(asked, listed, levelRef.current);
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
      .finally(() => {
        running.current.delete(identity);
        lockFailed.current.delete(identity);
      })
      .then(
        (decided) => {
          if (currentWorkspace.current !== asked) return;
          // The row read as working until now. The engine's list after the
          // choice comes with it, ahead of the shell's status.
          const still = decided.heldAccessRules.find((held) => identityOf(held) === identity);
          if (still) show(asked, still, levelRef.current, undefined, true);
          else latest.current.clearIdentity(identity);
          const message = accessRuleDecidedWords(hold, decision, decided.kept, now);
          // The earlier rule stays in History; Restore's says where its copy is.
          const step: ShellError["action"] =
            decision === "accept"
              ? { label: "Open History", run: latest.current.openHistory, ends: true }
              : undefined;
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
          const listed = putBack(asked, identity);
          // A hold decided already leaves with the list that follows; the press
          // still says why nothing ran. The engine refuses alike when the hold
          // is gone (decided elsewhere, recorded with its outer rule, or put
          // back outside dohc) and when its Version is no longer open, so the
          // words hold for both. History shows what dohc recorded.
          if (isAccessRuleNotHeldRefusal(error)) {
            latest.current.reportShellFailure({
              identity: decidedOf(identity),
              tone: "warning",
              message: `dohc didn't apply your choice because ${ruleOfLower(hold.folder)} no longer waits for it in the version you have open.`,
              retry: null,
              action: { label: "Open History", run: latest.current.openHistory, ends: true },
            });
            return;
          }
          // A changed rule comes back as its notice, judged again, or leaves the
          // list once judging it again clears its hold. Either way the press
          // says why nothing ran.
          if (isAccessRuleChangedRefusal(error)) {
            latest.current.reportShellFailure({
              identity: decidedOf(identity),
              tone: "warning",
              message: `dohc didn't apply your choice because ${ruleOfLower(hold.folder)} changed again outside dohc.`,
              retry: null,
              action: { label: "Open History", run: latest.current.openHistory, ends: true },
            });
            return;
          }
          if (!listed) return;
          const outer = heldOuterAccessRuleFolder(error);
          if (outer !== null && outer !== hold.folder) {
            waitFor(hold, outer);
            return;
          }
          const place = placeOf(hold.folder);
          const refused = refusalWords(error);
          if (isFileLockedError(error)) {
            const now = latest.current.holds?.find((held) => identityOf(held) === identity);
            lockFailed.current.set(identity, now?.unreadable === "locked");
          }
          // It shares the outcome's identity, so a later choice that works
          // replaces it.
          latest.current.reportShellFailure({
            identity: decidedOf(identity),
            title:
              decision === "restore"
                ? `dohc could not restore ${ruleOfLower(hold.folder)}`
                : `dohc could not change access to ${place}`,
            message:
              refused?.words ??
              `dohc still doesn't record or share changes in ${place}. Members keep their earlier access.`,
            cause: error,
            retry: refused?.final ? null : () => decideRef.current(asked, hold, decision),
            // Try again runs the choice again on the waiting row, as its own button does.
            retryStays: true,
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
      lockFailed.current.delete(identity);
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
      const sawLocked = lockFailed.current.get(identity);
      if (sawLocked !== undefined && hold.unreadable === "locked")
        lockFailed.current.set(identity, true);
      else if (sawLocked) {
        lockFailed.current.delete(identity);
        clearIdentity(decidedOf(identity));
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
  }, [holds, level, workspaceId, reportShellFailure, clearIdentity]);

  return { readMemberLevel };
}
