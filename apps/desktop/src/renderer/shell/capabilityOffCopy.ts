import { engineStoreRefusalCopy, type SyncStatusResult } from "../../ipc/bridgeContract";

// What the history-off placeholder may claim. Whether changes are recorded
// is main's answer (syncStatus, from the open that decided the recorder),
// and a cause is named only when that status established it. A status that
// has not landed proves nothing: main may be recording, and "not being
// recorded" would then be a false privacy assurance.
// Each cause is one line, per the empty-state recipe (copy.md): what is
// missing, then the next step its surface really has.
export function historyOffPlaceholderCopy(
  syncStatus: SyncStatusResult | null,
  share: { ended: boolean; granterEmail: string | null } | null,
): string {
  if (share) {
    // A capability, not a failure: a shared view is fed
    // by the share's pull and records no history here. The next step matches
    // the surface — Refresh exists only while the share is live, so an ended
    // share must not name it — and the ended line names who acted, as the
    // banner does.
    return share.ended
      ? `A shared view records no history. ${share.granterEmail ?? "The person who shared it"} ended this share. You can still open the files it shared.`
      : "A shared view records no history. Refresh the shared view to get the latest shared changes.";
  }
  if (syncStatus?.engineStoreRefused) {
    return engineStoreRefusalCopy(syncStatus.engineStoreRefused);
  }
  if (syncStatus?.historyRecordingUnavailable) {
    // A failure, not a decision — same copy as the notice center.
    return "dohc could not start recording history for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  // Main has not said recording is off. It may be recording right now, so
  // no cause and no "not recorded" — only what dohc could not do, plus the
  // one next step that reliably re-runs both reads (no lighter re-read is
  // wired on this surface).
  return "History is unavailable. dohc could not confirm whether this workspace records history. Restart dohc to try again.";
}

// What a persisted version-compare tab may claim when the version surface is
// off and the workspace is not a shared view. Same rule as
// `historyOffPlaceholderCopy` above, and one rule of its own: **a capability
// flag is not a count**. `historyRecordingUnavailable` says the recorder
// could not be built this session; versions created before it can still be on
// disk and reachable after the restart this copy prescribes. "You have no
// versions" is a claim about durable data, and dohc does not make one it has
// not established. Every line here says what dohc cannot do now, and none of
// them says what does not exist.
export function versionCompareOffCopy(syncStatus: SyncStatusResult | null): string {
  if (syncStatus?.engineStoreRefused) {
    return engineStoreRefusalCopy(syncStatus.engineStoreRefused);
  }
  if (syncStatus?.historyRecordingUnavailable) {
    // A failure, not a decision, and not an emptiness.
    return "dohc could not open versions for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  // Main has not said anything is wrong, so the version read failing is
  // all this surface knows. No cause, and no claim about what exists.
  return "Versions are unavailable. dohc could not confirm whether this workspace has versions. Close this tab to go back to your files.";
}

// What the Chats surfaces may claim when main's capture cannot serve them and
// the workspace is not a shared view. Same two rules as the copy above:
// only main's status names a cause, and a capability flag is not a count —
// chats live on disk and outlive a session whose capture failed to build.
//
// One function for the panel and the tab, because the next step is the same on
// both: the panel has no tab to close, and restarting is what re-runs the
// capture build either way.
export function chatsOffCopy(syncStatus: SyncStatusResult | null): string {
  if (syncStatus?.engineStoreRefused) {
    return engineStoreRefusalCopy(syncStatus.engineStoreRefused);
  }
  if (syncStatus?.historyRecordingUnavailable) {
    // A failure, not a decision, and not an emptiness.
    return "dohc could not open chats for this workspace. Your files still save normally. Restart dohc to try again.";
  }
  // Main has not said anything is wrong, so the chat read failing is all
  // this surface knows. No cause, and no claim about what exists.
  return "Chats are unavailable. dohc could not confirm whether this workspace has chats. Restart dohc to try again.";
}
