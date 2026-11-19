import type { ShareAccess } from "../ipc/bridgeContract";
import type { RelayShareTarget } from "./RelayShareDialog";

let newestCopy = 0;

/**
 * Takes the next turn in the one sequence every copy of an invitation or a
 * share code in Share belongs to. The answer says whether a later copy has
 * been asked for since, so only the newest reaches the clipboard.
 */
export function nextInvitationCopy(): () => boolean {
  const copy = ++newestCopy;
  return () => copy === newestCopy;
}

/** Whether the relay may answer an invitation with a browser link in place of the share code. */
export const invitationCanBeBrowserLink = (access: ShareAccess | null, target: RelayShareTarget) =>
  access === "edit" && target.kind === "paths";
