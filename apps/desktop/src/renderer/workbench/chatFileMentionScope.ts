import { shareCoversLinkPath } from "@dohc/security-contract/share-selector";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import type { FileMentionCandidate } from "./MentionComposer";

const NO_FILES: readonly FileMentionCandidate[] = [];

// A direct message links no file.
export const DM_FILE_CANDIDATES = NO_FILES;

// The files a composer offers in a Group or agent chat, matching what the
// send accepts: a Group shared or joined offers its folder's files only. A
// Group whose sharing is not known yet, or not shared, offers every file.
export function channelFileCandidates(
  files: readonly FileMentionCandidate[],
  channel: Pick<ChatChannelRecord, "kind" | "folderPath"> | null,
  shared: boolean,
): readonly FileMentionCandidate[] {
  if (!channel || channel.kind === "agent") return files;
  if (channel.kind === "dm") return NO_FILES;
  if (!shared) return files;
  const { folderPath } = channel;
  if (folderPath === undefined) return NO_FILES;
  return files.filter(file => shareCoversLinkPath({ paths: [folderPath], versionId: null }, file.path));
}
