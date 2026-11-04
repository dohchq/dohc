import type { WorkspaceSummary } from "../ipc/bridgeContract";

// What removing a workspace from the list drops beyond its place there, one
// line per loss, each with its way back. An empty list means the row holds
// only its place, so it is removed without asking.

const SETTINGS_SYNC = "Settings › Sync and sharing";

// "A", "A and B", "A, B and C", then "A, B, C and 2 more".
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

export function removalFacts(workspace: WorkspaceSummary): string[] {
  const facts: string[] = [];
  if (workspace.sync === "on") {
    facts.push(`Sync turns off. Turn it on again in ${SETTINGS_SYNC}.`);
  } else if (workspace.sync === "paused") {
    facts.push(`Its paused sync ends. Turn sync on again in ${SETTINGS_SYNC}.`);
  }

  const chats = workspace.joinedChatCount ?? 0;
  if (chats === 1) {
    facts.push(
      "1 shared chat leaves this workspace. In Chats, join it again from Shared with you or Message requests, unless its share has ended.",
    );
  } else if (chats > 1) {
    facts.push(
      `${chats} shared chats leave this workspace. In Chats, join groups again from Shared with you and direct messages from Message requests, unless their share has ended.`,
    );
  }

  // An ended or unreadable mount already refreshes nothing, so it loses nothing.
  const mounts = (workspace.shareMounts ?? []).filter((mount) => !mount.ended && !mount.damaged);
  const [onlyMount] = mounts;
  if (mounts.length === 1 && onlyMount) {
    facts.push(`Shared folder ${onlyMount.label} stops refreshing, and its files stay.`);
  } else if (mounts.length > 1) {
    facts.push(
      `Shared folders ${namesList(mounts.map((mount) => mount.label))} stop refreshing, and their files stay. A share added again with its code arrives as a new folder.`,
    );
  }

  if (workspace.shareView && !workspace.shareView.ended && !workspace.shareView.damaged) {
    facts.push("Its folder stays but stops refreshing. To open the share again, use its share code.");
  }
  return facts;
}
