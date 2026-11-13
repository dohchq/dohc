import { shareCoversLinkPath } from "@dohc/security-contract/share-selector";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import type { FileMentionCandidate } from "./MentionComposer";

const NO_FILES: readonly FileMentionCandidate[] = [];

// A direct message links no file.
export const DM_FILE_CANDIDATES = NO_FILES;

// How the open Group is shared: not shared or not known yet, shared from this
// workspace, or joined. A joined Group's share is mounted under
// shared-with-me/<mountLabel>/, or nowhere when the mount is missing.
export type ChannelFileSharing =
  | { kind: "unshared" }
  | { kind: "owned" }
  | { kind: "joined"; mountLabel: string | null };

// The files a composer offers in a Group or agent chat, matching what the
// send accepts: a Group shared or joined offers its folder's files only. A
// Group whose sharing is not known yet, or not shared, offers every file.
export function channelFileCandidates(
  files: readonly FileMentionCandidate[],
  channel: Pick<ChatChannelRecord, "kind" | "folderPath"> | null,
  sharing: ChannelFileSharing,
): readonly FileMentionCandidate[] {
  if (!channel || channel.kind === "agent") return files;
  if (channel.kind === "dm") return NO_FILES;
  if (sharing.kind === "unshared") return files;
  const { folderPath } = channel;
  if (folderPath === undefined) return NO_FILES;
  const covers = (path: string) =>
    shareCoversLinkPath({ paths: [folderPath], versionId: null }, path);
  if (sharing.kind === "owned") return files.filter((file) => covers(file.path));
  // A joined Group's files are this workspace's copy of its owner's, and its
  // messages link the owner's paths, which every reader of the Group uses.
  if (sharing.mountLabel === null) return NO_FILES;
  const prefix = `shared-with-me/${sharing.mountLabel}/`;
  return files.flatMap((file) => {
    if (!file.path.startsWith(prefix)) return [];
    const path = file.path.slice(prefix.length);
    return covers(path) ? [{ ...file, path, readPath: file.path }] : [];
  });
}
