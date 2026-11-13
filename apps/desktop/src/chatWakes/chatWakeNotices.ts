import type { ChatDispatchNotice } from "../ipc/bridgeContract";
import type { ChatRunnerRefusal } from "./chatRunnerDeclaration";
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

// The declarations ledger: which workspaces this computer told the server about its agents. Without it, nothing is
// declared or withdrawn, and it is never written over, so the person restores or repairs it.
const LEDGER_UNREADABLE =
  "Your phone cannot wake agents here until it can. Restore or repair the file in Details before you try again.";

// Why the server can't take this computer's agents, and the one thing to do.
const REFUSALS: Record<ChatRunnerRefusal["reason"], string> = {
  "too-many-agents": "The server takes up to 64 agents from each computer, and this one has more. Remove some in Settings › Agents.",
  "same-name": "Two agents' names read as one name in chat. Rename one in Settings › Agents.",
  "agent-name": "The server cannot take one agent's name. Rename it in Settings › Agents.",
  "agent-id": "The server cannot take one agent's ID. Change it in your settings file.",
  "computer-label": "The server cannot take this computer's name. Rename this computer in your system settings.",
  "install-id": "The server cannot take this computer's ID.",
};

/**
 * The wake rows in each workspace's Notices. A wake's row goes to its own
 * workspace. An unreadable file's row goes to each of this account's synced
 * workspaces, once each: every failed read offers it again, so a workspace
 * that starts syncing meanwhile gets it too. Neither reporting nor clearing
 * throws; a workspace that could not take its row is offered it next time.
 */
export function createChatWakeNotices(deps: {
  /** The intent file, for the unreadable row's Details. */
  file: string;
  /** The declarations ledger, for its unreadable row's Details. */
  ledgerFile: string;
  /** This account's synced workspaces on this computer, read without opening any. */
  workspaces(): readonly string[];
  report(workspaceId: string, notice: Omit<ChatDispatchNotice, "id">): void;
  clear(workspaceId: string, reason: ChatDispatchNotice["reason"]): void;
  log(error: unknown): void;
}) {
  const attempt = (work: () => void): boolean => {
    try {
      work();
      return true;
    } catch (error) {
      deps.log(error);
      return false;
    }
  };
  // One file's row in each synced workspace, shown once each and offered again on every failed read.
  const fileRows = (reason: ChatDispatchNotice["reason"], message: string, file: string) => {
    const shownIn = new Set<string>();
    return {
      report(): void {
        let workspaceIds: readonly string[];
        try { workspaceIds = deps.workspaces(); }
        catch (error) {
          deps.log(error);
          return;
        }
        for (const id of workspaceIds) {
          if (!shownIn.has(id) && attempt(() => deps.report(id, { reason, message, file }))) shownIn.add(id);
        }
      },
      clear(): void {
        const workspaceIds = [...shownIn];
        shownIn.clear();
        for (const id of workspaceIds) attempt(() => deps.clear(id, reason));
      },
    };
  };
  const intentsFile = fileRows(REASONS.unreadable, MESSAGES.unreadable, deps.file);
  const ledgerFile = fileRows("wake-runners-unreadable", LEDGER_UNREADABLE, deps.ledgerFile);
  return {
    report(workspaceId: string | null, problem: ChatWakeProblem, intent: ChatWakeIntent | null): void {
      if (workspaceId === null) return intentsFile.report();
      // The lifetime counts the row as shown only if this returns.
      deps.report(workspaceId, {
        reason: REASONS[problem],
        message: MESSAGES[problem],
        ...(intent ? { threadId: intent.threadId, messageId: intent.messageId, wakeId: intent.wakeId } : {}),
      });
    },
    /** The declarations ledger could not be read. Offered again on each failed read. */
    ledgerUnreadable(): void {
      ledgerFile.report();
    },
    /** It read: takes its rows back. */
    ledgerReadable(): void {
      ledgerFile.clear();
    },
    /** The server can't take this computer's agents as they are. One row per workspace; the lifetime calls it once per change. */
    refused(workspaceId: string, refusal: ChatRunnerRefusal): void {
      deps.report(workspaceId, {
        reason: "wake-runners-refused",
        message: REFUSALS[refusal.reason],
        ...("agentId" in refusal ? { agentId: refusal.agentId } : {}),
      });
    },
    accepted(workspaceId: string): void {
      deps.clear(workspaceId, "wake-runners-refused");
    },
    clear(workspaceId: string | null, problem: ChatWakeProblem): void {
      if (workspaceId === null) intentsFile.clear();
      else attempt(() => deps.clear(workspaceId, REASONS[problem]));
    },
  };
}
