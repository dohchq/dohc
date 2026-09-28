import { useCallback, useMemo } from "react";
import { agentIsSetUp, agentRequestText, type AgentRequest, type AskAgent } from "../askAgent";
import { bridge } from "../bridge";
import { useRequestSequence } from "../useRequestSequence";
import type { AgentSetupSummary, ChatsNav } from "../workbench/ChatsView";

/**
 * Hands a job to the person's agent: opens the agent's chat with a request
 * that names the file, for the person to finish and send. dohc runs nothing
 * itself. Undefined while chats are off or the agent's setup is unknown.
 */
export function useAskAgent(input: {
  workspaceId: string;
  agentSetup: AgentSetupSummary | null;
  chatsAvailable: boolean;
  // False when the chat keeps a reply the person has not sent.
  openChat: (nav: ChatsNav, prefill: string) => boolean;
  onOpenChat: () => void;
  onSetUp: () => void;
  reportShellError: (message: string, error: unknown, retry: () => void) => void;
}): AskAgent | undefined {
  const { workspaceId, openChat, onOpenChat, onSetUp, reportShellError } = input;
  const requests = useRequestSequence([workspaceId]);
  const ask = useCallback(
    async function ask(request: AgentRequest): Promise<void> {
      const token = requests.next();
      const retry = () => void ask(request);
      try {
        const [settingsFile, { channels }] = await Promise.all([
          bridge().getUserSettingsFilePath(),
          bridge().listChatChannels({ workspaceId }),
        ]);
        if (!requests.isCurrent(token)) return;
        const channel = channels.find((entry) => entry.kind === "agent");
        if (!channel) {
          const message =
            "dohc could not find your agent's chat. Check your agent in Settings, then try again.";
          reportShellError(message, new Error(message), retry);
          return;
        }
        onOpenChat();
        if (!openChat({ level: "channel", channel }, agentRequestText(request, { settingsFile, workspaceId }))) {
          const message = "Your agent's chat has a reply you have not sent. Send or clear it, then try again.";
          reportShellError(message, new Error(message), retry);
        }
      } catch (error) {
        if (requests.isCurrent(token)) reportShellError("dohc could not open your agent's chat.", error, retry);
      }
    },
    [onOpenChat, openChat, reportShellError, requests, workspaceId],
  );
  const ready = input.agentSetup ? agentIsSetUp(input.agentSetup) : null;
  return useMemo(
    () =>
      input.chatsAvailable && ready !== null
        ? { ready, ask: (request: AgentRequest) => void ask(request), setUp: onSetUp }
        : undefined,
    [ask, input.chatsAvailable, onSetUp, ready],
  );
}
