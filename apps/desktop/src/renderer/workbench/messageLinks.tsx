import { Link } from "lucide-react";
import { createContext, useCallback, useContext } from "react";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { offersWorkLinks } from "../../ipc/workLinkOffer";
import { bridge } from "../bridge";
import { CopyButton } from "../ui/CopyButton";
import { useRequestSequence } from "../useRequestSequence";

// Makes the web link to a message in this window's workspace. Null when the
// window left the workspace before main answered, so a late link is never
// copied for the next workspace. No maker means the workspace offers no links.
export type MakeMessageLink = (messageId: string) => Promise<string | null>;
export const MessageLinks = createContext<MakeMessageLink | null>(null);

export const MESSAGE_LINK_FAILURE = "dohc could not copy a link to this message.";

export function useMessageLinkMaker(workspace: Pick<WorkspaceSummary, "workspaceId" | "sync">): MakeMessageLink | null {
  const { workspaceId } = workspace;
  const requests = useRequestSequence([workspaceId]);
  const make = useCallback(async (messageId: string) => {
    const epoch = requests.current();
    const made = await bridge().makeMessageLink({ workspaceId, messageId });
    return requests.isCurrent(epoch) ? made?.url ?? null : null;
  }, [requests, workspaceId]);
  return offersWorkLinks(workspace) ? make : null;
}

// Copy link on a message, beside its Copy text. Nothing where the workspace
// offers no links.
export function CopyMessageLink(props: { messageId: string; testId: string }) {
  const make = useContext(MessageLinks);
  if (!make) return null;
  return (
    <CopyButton
      iconOnly
      icon={Link}
      label="Copy link"
      failure={MESSAGE_LINK_FAILURE}
      getText={() => make(props.messageId)}
      testId={props.testId}
    />
  );
}
