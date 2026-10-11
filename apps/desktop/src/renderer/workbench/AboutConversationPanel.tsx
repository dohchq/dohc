import { useState } from "react";
import { AboutAccess, AboutHeader, type AboutNotices, type AccessContext } from "./About";
import type { AboutConversation } from "./aboutConversation";

// About for the open conversation: a Group, a person or an agent. Its name and
// who is here come from the conversation's own page; Access asks main about
// the chat's grants, the way it asks about a file's.
export function AboutConversationPanel(props: {
  workspaceId: string;
  conversation: AboutConversation;
  notices: AboutNotices;
  accessContext: AccessContext;
}) {
  const { conversation } = props;
  // Closed until opened, like a file's Access: opening it is what asks main
  // to check again. It stays open while the person moves between chats.
  const [accessOpen, setAccessOpen] = useState(false);
  return (
    <div data-testid="about-panel" data-conversation-kind={conversation.kind} className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={conversation} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutAccess
          workspaceId={props.workspaceId}
          subject={{ kind: "chat", channelWireId: conversation.channelWireId }}
          received={conversation.received}
          expanded={accessOpen}
          onToggle={() => setAccessOpen((open) => !open)}
          notices={props.notices}
          context={props.accessContext}
        />
      </div>
    </div>
  );
}
