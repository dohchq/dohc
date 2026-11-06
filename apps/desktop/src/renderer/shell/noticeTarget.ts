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
