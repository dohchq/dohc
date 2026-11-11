import { Trash2 } from "lucide-react";
import { automationAgent, type DesktopUserSettings } from "../../settings/userSettings";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * Asks before an agent leaves Settings, from its chat's menu or from
 * Settings. Its chat stays, and the notice after it holds Undo.
 */
export function RemoveAgentDialog(props: {
  agent: { id: string; name: string };
  settings: Pick<DesktopUserSettings, "agents">;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { agent, settings } = props;
  let automations: string | null = null;
  if (automationAgent(settings)?.id === agent.id) {
    const { [agent.id]: _removed, ...rest } = settings.agents;
    const next = automationAgent({ agents: rest });
    automations = next ? `Automations will wake ${next.name} instead.` : "Automations will have no agent to wake.";
  }
  return (
    <ConfirmDialog
      title={`Remove ${agent.name}?`}
      icon={Trash2}
      intent="danger"
      confirmLabel="Remove agent"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
      testId="remove-agent-dialog"
      cancelTestId="remove-agent-cancel"
      confirmTestId="remove-agent-confirm"
    >
      <p>Its chat stays in Archived.{automations ? ` ${automations}` : ""}</p>
    </ConfirmDialog>
  );
}

/** Asks before a removed agent's chat leaves Archived. Its messages stay. */
export function HideAgentChatDialog(props: { name: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <ConfirmDialog
      title={`Remove ${props.name}'s chat from the list?`}
      icon={Trash2}
      intent="danger"
      confirmLabel="Remove from list"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
      testId="hide-agent-chat-dialog"
      cancelTestId="hide-agent-chat-cancel"
      confirmTestId="hide-agent-chat-confirm"
    >
      <p>Its messages stay in this workspace.</p>
    </ConfirmDialog>
  );
}
