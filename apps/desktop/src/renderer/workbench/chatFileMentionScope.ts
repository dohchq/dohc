import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import { chatFileLinkCovers } from "../../workspaces/chatFileLinkCovers";
import type { FileMentionCandidate } from "./MentionComposer";

const NO_FILES: readonly FileMentionCandidate[] = [];

// A direct message links no file.
export const DM_FILE_CANDIDATES = NO_FILES;

// The files a composer offers in a chat: those its messages may link, by the
// rule the send checks. A chat whose rule the channel list has not given
// offers every file. A joined Group's files are this workspace's copy of its
// owner's, under shared-with-me/<mountLabel>/, and its messages link the
// owner's paths, which every reader of the Group uses. With no mount it offers
// none.
export function channelFileCandidates(
  files: readonly FileMentionCandidate[],
  channel: Pick<ChatChannelRecord, "fileLinks"> | null,
  joined: { mountLabel: string | null } | null,
): readonly FileMentionCandidate[] {
  const scope = channel?.fileLinks;
  if (!scope || scope.kind === "any") return files;
  if (scope.kind === "none") return NO_FILES;
  if (!joined) return files.filter((file) => chatFileLinkCovers(scope, file.path));
  if (joined.mountLabel === null) return NO_FILES;
  const prefix = `shared-with-me/${joined.mountLabel}/`;
  return files.flatMap((file) => {
    if (!file.path.startsWith(prefix)) return [];
    const path = file.path.slice(prefix.length);
    return chatFileLinkCovers(scope, path) ? [{ ...file, path, readPath: file.path }] : [];
  });
}
