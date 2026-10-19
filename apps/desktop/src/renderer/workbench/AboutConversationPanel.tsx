import { AboutAccess, AboutHeader, type AboutNotices, type AccessContext } from "./About";
import type { AboutConversation } from "./aboutConversation";

// About for the open conversation: a Group, a person or an agent. Its name and
// who is here come from the conversation's own page; Access asks main about
// the chat's grants, the way it asks about a file's.
export function AboutConversationPanel(props: {
  workspaceId: string;
  conversation: AboutConversation;
  // Closed until opened, like a file's Access: opening it is what asks main
  // to check again. The rail holds it, so it stays open between chats while
  // this panel remounts for each one.
  accessOpen: boolean;
  onToggleAccess: () => void;
  notices: AboutNotices;
  accessContext: AccessContext;
}) {
  const { conversation } = props;
  return (
    <div data-testid="about-panel" data-conversation-kind={conversation.kind} className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={conversation} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutAccess
          workspaceId={props.workspaceId}
          subject={{ kind: "chat", channelWireId: conversation.channelWireId }}
          received={conversation.received}
          expanded={props.accessOpen}
          onToggle={props.onToggleAccess}
          notices={props.notices}
          context={props.accessContext}
        />
      </div>
    </div>
  );
}
