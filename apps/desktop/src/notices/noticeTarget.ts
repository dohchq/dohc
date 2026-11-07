import { isAutomationControlsTarget } from "@dohc/workspace-contracts/relay";
import type { NoticeRow } from "../ipc/bridgeContract";
import type { SentNoticePlace } from "./sentNoticePlace";
// Where a Notices row opens, as plain data. The shell's openNoticeTarget is
// the one place that turns it into navigation, so it alone holds the
// workspace guard, and an agent-readable list can carry the same value.
export type NoticeTarget =
  | { to: "file"; path: string }
  // A folder in Files, such as a share mounted in shared-with-me.
  | { to: "folder"; path: string }
  // A conversation, at a message or at a run's last message when one is named.
  | { to: "chat"; thread: string; message?: string; run?: string }
  // Chats at a Group invitation or message request. `inputs` is the input
  // count when Open was chosen, so a later input keeps the person's focus.
  | { to: "chats-invitation"; shareId: string; inputs: number }
  // An automation's runs in the ⚡ panel, at a run this computer ran.
  | { to: "automation"; automation: string; run?: string }
  // An automation's switch. Through a share, `sharedFile` is its automations.yaml.
  | { to: "automation-controls"; automation: string; sharedFile?: string }
  | { to: "share-changes"; proposalId: string }
  | { to: "sharing-declined"; versionId: string; objectId: string }
  | { to: "history" }
  // The timeline with one change's file open beside it.
  | { to: "history-change"; moment: string; path: string }
  // Live documents, at a page when one is named.
  | { to: "live-documents"; reveal?: string }
  | { to: "conflicts" }
  | { to: "sync-settings" }
  // Sign-in when signed out, else the server's settings.
  | { to: "server-connection" }
  | { to: "privacy-settings" };

export const CHAT_NOT_FOUND_NOTE = "dohc could not find this chat.";
export const FILE_NOT_FOUND_NOTE = "dohc could not find this file.";
export const AUTOMATION_NOT_HERE_NOTE = "dohc cannot find this automation's Collection on this computer.";
// Said through the shell's errors, with Try again, when a lookup fails.
export const AUTOMATION_LOOKUP_FAILED_NOTE = "dohc could not open this automation.";
export const RUN_THREAD_LOOKUP_FAILED_NOTE = "dohc could not open this run's thread.";

// Only a chat or an automation is looked up, so only they can fail this way.
export function targetLookupFailedNote(target: NoticeTarget): string {
  return target.to === "chat" ? RUN_THREAD_LOOKUP_FAILED_NOTE : AUTOMATION_LOOKUP_FAILED_NOTE;
}

export const ACCESS_ENDED_NOTE =
  "Your access to this ended. Ask the person who shared it to share it again.";

// Notices about one automation, whose Open goes to the automation.
export const AUTOMATION_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "schedule-skipped", "automation-failed", "automation-switched-off",
]);

// A switched-off automation's notice opens its switch rather than its runs.
export const opensControls = (notice: NoticeRow) => notice.target !== null && isAutomationControlsTarget(notice.target);

// The places a sent notice can open, which an agent's list carries too.
export type SentNoticeTarget = Extract<NoticeTarget, { to: "file" | "folder" | "chat" | "automation" | "automation-controls" }>;

/**
 * What a sent notice opens in the workspace that holds it, or null when it
 * names nothing there. `controls` opens an automation's switch rather than
 * its runs. Through a share view or shared-with-me folder, the shared panel
 * finds the automation by its automations.yaml there.
 */
export function sentNoticeTarget(
  notice: NoticeRow,
  place: Extract<SentNoticePlace, { kind: "workspace" }>,
  controls: boolean,
): SentNoticeTarget | null {
  const { thread, message, run } = notice.target ?? {};
  // A run's notice, or one that names a conversation here and no file.
  if (thread !== undefined && (notice.kind === "agent-run" || (place.path === null && place.mount === null))) {
    return { to: "chat", thread, ...(message !== undefined ? { message } : run !== undefined ? { run } : {}) };
  }
  const automation = AUTOMATION_NOTICE_KINDS.has(notice.kind) ? notice.target?.automation : undefined;
  const shared = place.mount !== null || place.workspace.shareView !== undefined;
  const sharedFile = shared ? place.path ?? undefined : undefined;
  if (controls && automation !== undefined && (!shared || sharedFile !== undefined)) {
    return { to: "automation-controls", automation, ...(sharedFile === undefined ? {} : { sharedFile }) };
  }
  // Only the computer that ran a run holds it.
  if (automation !== undefined && place.mount === null && !controls) {
    return { to: "automation", automation, ...(notice.postedHere && run !== undefined ? { run } : {}) };
  }
  if (place.path !== null) return { to: "file", path: place.path };
  return place.mount !== null ? { to: "folder", path: `shared-with-me/${place.mount}` } : null;
}
