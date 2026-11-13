import { extractChatFileReferences } from "@dohc/workspace-contracts/chat-mentions";
import type { ChatChannel } from "@dohc/workspace-contracts/engine";
import type { ListedGrant } from "@dohc/automation-executor/roster-listing";
import type { ChatFileLinkScope } from "../ipc/bridgeContract";
import { chatFileLinkCovers } from "./chatFileLinkCovers";
import type { RegistryEntry } from "./registryStore";
import { joinedSharedChannelForWireId } from "./sharedChannels";

// Which files a message in one place may link. A Group whose share this
// computer knows links only what that share covers; a DM links no file;
// an agent's chat, a file's chat and a Group with no known share link any.
const ANY: ChatFileLinkScope = { kind: "any" };
const NONE: ChatFileLinkScope = { kind: "none" };

// A Group grant whose channel does not serve files, and a chat-only grant,
// cover no file.
function grantFolders(grant: ListedGrant): string[] {
  return "fileScope" in grant && grant.fileScope === "served" ? grant.selector.paths : [];
}

export function chatFileLinkScope(
  workspace: Pick<RegistryEntry, "sharedChannels" | "shareRoster">,
  channel: Pick<ChatChannel, "kind" | "folderPath"> | null,
  channelWireId: string | null,
): ChatFileLinkScope {
  if (!channel || channel.kind === "agent") return ANY;
  if (channel.kind === "dm") return NONE;
  const joined =
    channelWireId === null
      ? null
      : joinedSharedChannelForWireId(workspace.sharedChannels, channelWireId);
  // A member's Group: its owner shares the Group's folder.
  if (joined) return { kind: "shared", shares: [channel.folderPath ? [channel.folderPath] : []] };
  const roster = workspace.shareRoster;
  if (!roster || roster.grants === null || channelWireId === null) return ANY;
  const onChannel = (grant: ListedGrant) =>
    (grant.selector.kind === "group" || grant.selector.kind === "chat") &&
    grant.selector.channelWireId === channelWireId;
  const shares = [
    ...roster.grants.filter((grant) => grant.status === "active" && onChannel(grant)),
    ...roster.links
      .filter((link) => !link.ended && onChannel(link.grant))
      .map((link) => link.grant),
  ];
  if (shares.length === 0) return ANY;
  // Shares with the same folders cover the same files, so each set is listed once.
  const folders = new Map(
    shares.map((grant) => [JSON.stringify(grantFolders(grant)), grantFolders(grant)]),
  );
  return { kind: "shared", shares: [...folders.values()] };
}

// Throws on the first file link the scope does not take, across a message's
// body, poll options and post title. A malformed link is no file link.
export function refuseChatFileLinks(scope: ChatFileLinkScope, texts: readonly string[]): void {
  if (scope.kind === "any") return;
  for (const text of texts) {
    for (const { path } of extractChatFileReferences(text)) {
      if (scope.kind === "none") throw new Error("Files can't be linked in a direct message.");
      if (!chatFileLinkCovers(scope, path)) {
        throw new Error(
          `This Group's share doesn't include ${path}. Remove the link or share the file first.`,
        );
      }
    }
  }
}

// Whether any of the texts holds a well-formed file link, so a write without
// one skips the channel lookup.
export function hasChatFileLink(texts: readonly string[]): boolean {
  return texts.some((text) => extractChatFileReferences(text).length > 0);
}
