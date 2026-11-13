import type { ChatDispatchNotice } from "../ipc/bridgeContract";
import type { ChatWakeIntent } from "./chatWakeIntents";
import type { ChatWakeProblem } from "./chatWakeLifetime";

const REASONS = {
  unreadable: "wake-unreadable",
  dropped: "wake-dropped",
  parked: "wake-parked",
  unconfirmed: "wake-unconfirmed",
} as const satisfies Record<ChatWakeProblem, ChatDispatchNotice["reason"]>;

// What happened and the next step. The renderer gives each its title.
const MESSAGES: Record<ChatWakeProblem, string> = {
  unreadable: "Agents here do not start for messages from your phone until it can. Restore or repair the file in Details before you try again.",
  dropped: "The server no longer lists this computer for it, so nothing ran here.",
  parked: "Its workspace stopped syncing here with this account. dohc starts it once the workspace syncs here again.",
  unconfirmed: "Its request is queued on this computer, and the server no longer lists it.",
};

/**
 * The wake rows in each workspace's Notices. A wake's row goes to its own
 * workspace. The unreadable file's row goes to each of this account's synced
 * workspaces, once each: every failed read offers it again, so a workspace
 * that starts syncing meanwhile gets it too. Neither reporting nor clearing
 * throws; a workspace that could not take its row is offered it next time.
 */
export function createChatWakeNotices(deps: {
  /** The intent file, for the unreadable row's Details. */
  file: string;
  /** This account's synced workspaces on this computer, read without opening any. */
  workspaces(): readonly string[];
  report(workspaceId: string, notice: Omit<ChatDispatchNotice, "id">): void;
  clear(workspaceId: string, reason: ChatDispatchNotice["reason"]): void;
  log(error: unknown): void;
}) {
  const unreadableIn = new Set<string>();
  const attempt = (work: () => void): boolean => {
    try {
      work();
      return true;
    } catch (error) {
      deps.log(error);
      return false;
    }
  };
  return {
    report(workspaceId: string | null, problem: ChatWakeProblem, intent: ChatWakeIntent | null): void {
      const notice = {
        reason: REASONS[problem],
        message: MESSAGES[problem],
        ...(intent ? { threadId: intent.threadId, messageId: intent.messageId, wakeId: intent.wakeId } : { file: deps.file }),
      };
      if (workspaceId !== null) {
        // The lifetime counts the row as shown only if this returns.
        deps.report(workspaceId, notice);
        return;
      }
      let workspaceIds: readonly string[];
      try { workspaceIds = deps.workspaces(); }
      catch (error) {
        deps.log(error);
        return;
      }
      for (const id of workspaceIds) {
        if (!unreadableIn.has(id) && attempt(() => deps.report(id, notice))) unreadableIn.add(id);
      }
    },
    clear(workspaceId: string | null, problem: ChatWakeProblem): void {
      const workspaceIds = workspaceId !== null ? [workspaceId] : [...unreadableIn];
      if (workspaceId === null) unreadableIn.clear();
      for (const id of workspaceIds) attempt(() => deps.clear(id, REASONS[problem]));
    },
  };
}
