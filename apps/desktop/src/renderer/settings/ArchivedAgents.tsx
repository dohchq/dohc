import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatChannelRecord } from "../../ipc/bridgeContract";
import { archivedChatsFor, hiddenChatsFor } from "../../settings/archivedChats";
import type { Agent, DesktopUserSettings } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { SecondaryButton } from "../ui/controls";
import { agentChatIdentity } from "../workbench/agentChat";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { useRequestSequence } from "../useRequestSequence";
import { HideAgentChatDialog } from "./agentDialogs";

type OnError = (message: string, cause?: unknown, retry?: () => Promise<void>) => void;
type OnNotice = (message: string, undo?: () => void) => void;

/**
 * Takes a removed agent's chat off Archived for this person, with Undo
 * putting it back. Its messages stay. Chats and Settings both use it.
 */
export async function hideAgentChat(input: {
  workspaceId: string; channelId: string; name: string; onError: OnError; onNotice?: OnNotice | undefined;
}): Promise<void> {
  const { workspaceId, channelId, name, onError, onNotice } = input;
  try {
    await bridge().setChatArchived({ workspaceId, channelId, state: "hidden" });
  } catch (cause) {
    onError(ipcErrorMessage(cause, `dohc could not remove ${name}'s chat from the list.`), cause, () => hideAgentChat(input));
    return;
  }
  onNotice?.(`Removed ${name}'s chat from the list.`, () => void bridge().setChatArchived({ workspaceId, channelId, state: "active" })
    .catch((cause: unknown) => onError(ipcErrorMessage(cause, `dohc could not bring back ${name}'s chat.`), cause)));
}

/**
 * This workspace's agent chats, or null until they are read. They are read
 * again on activity here, which is how a chat an agent's check starts arrives.
 */
export function useAgentChats(workspaceId: string, onError: OnError | undefined): readonly ChatChannelRecord[] | null {
  const [chats, setChats] = useState<{ workspaceId: string; channels: readonly ChatChannelRecord[] } | null>(null);
  const requests = useRequestSequence([workspaceId]);
  const report = useRef(onError);
  report.current = onError;
  // The workspace shown, or null once closed. Try again reads only for it.
  const shown = useRef<string | null>(workspaceId);
  const read = useCallback(async (): Promise<void> => {
    const token = requests.next();
    try {
      const { channels } = await bridge().listChatChannels({ workspaceId });
      if (requests.isCurrent(token)) setChats({ workspaceId, channels: channels.filter((channel) => channel.kind === "agent") });
    } catch (cause) {
      if (requests.isCurrent(token)) report.current?.(ipcErrorMessage(cause, "dohc could not read this workspace's agent chats."), cause, async () => {
        if (shown.current === workspaceId) await read();
      });
    }
  }, [requests, workspaceId]);
  useEffect(() => {
    shown.current = workspaceId;
    // A burst of activity reads once more after the read in flight, not once per event.
    let reading = false;
    let again = false;
    const refresh = () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      void read().finally(() => {
        reading = false;
        if (again && shown.current === workspaceId) {
          again = false;
          refresh();
        }
      });
    };
    refresh();
    const unsubscribe = bridge().onWorkspaceActivity((event) => {
      if (event.workspaceId === undefined || event.workspaceId === workspaceId) refresh();
    });
    return () => {
      shown.current = null;
      unsubscribe();
    };
  }, [read, workspaceId]);
  return chats?.workspaceId === workspaceId ? chats.channels : null;
}

/**
 * Which agents' chats sit in Archived here. `archived` holds agents still in
 * Settings; `removed` holds chats whose agent left, until Remove from list.
 * `held` says whether an agent id is still yours, or null while that is unknown.
 */
export function archivedAgentChats(
  workspaceId: string,
  settings: DesktopUserSettings,
  chats: readonly ChatChannelRecord[] | null,
  held: (agentId: string) => boolean | null,
): { archived: ReadonlyMap<string, ChatChannelRecord>; removed: readonly ChatChannelRecord[] } {
  const archivedIds = new Set(archivedChatsFor(settings, workspaceId));
  const hiddenIds = new Set(hiddenChatsFor(settings, workspaceId));
  const archived = new Map<string, ChatChannelRecord>();
  const removed: ChatChannelRecord[] = [];
  for (const chat of chats ?? []) {
    if (!chat.agentId) continue;
    if (Object.hasOwn(settings.agents, chat.agentId)) {
      if (archivedIds.has(chat.id)) archived.set(chat.agentId, chat);
    } else if (held(chat.agentId) === false && !hiddenIds.has(chat.id)) {
      removed.push(chat);
    }
  }
  return { archived, removed };
}

const ROW = "flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0";

/**
 * Settings › Agents › Archived: agents whose chat is archived here, which
 * open their page, unarchive, or remove, and removed agents' chats, which
 * leave the list.
 */
export function ArchivedAgents(props: {
  workspaceId: string;
  agents: readonly { agent: Agent; chat: ChatChannelRecord }[];
  removed: readonly ChatChannelRecord[];
  onOpen: (agentId: string) => void;
  onRemove: (agent: Agent) => void;
  onError: OnError;
  onNotice?: OnNotice | undefined;
}) {
  const { workspaceId, onError } = props;
  const [hiding, setHiding] = useState<{ workspaceId: string; chat: ChatChannelRecord; name: string } | null>(null);
  if (hiding && hiding.workspaceId !== workspaceId) setHiding(null);
  if (props.agents.length === 0 && props.removed.length === 0) return null;
  const unarchive = (agent: Agent, chat: ChatChannelRecord) => {
    void bridge().setChatArchived({ workspaceId, channelId: chat.id, state: "active" }).catch((cause: unknown) =>
      onError(ipcErrorMessage(cause, `dohc could not unarchive ${agent.name}.`), cause, async () => unarchive(agent, chat)));
  };
  return (
    <section data-testid="agents-archived" aria-labelledby="agents-archived-title">
      <h4 id="agents-archived-title" className="m-0 mb-1.5 mt-5 text-[12px] font-medium text-subtle">Archived</h4>
      <div className="rounded-lg border border-line bg-panel">
        {props.agents.map(({ agent, chat }) => (
          <div key={agent.id} data-testid="agent-row-archived" data-agent-id={agent.id} className={ROW}>
            <button type="button" aria-label={agent.name} onClick={() => props.onOpen(agent.id)}
              className="-my-1 -ml-1 flex min-w-0 flex-1 items-center gap-3 rounded-md py-1 pl-1 text-left hover:bg-hover">
              <ChatAvatar name={agent.name} kind="agent" presentation={agentChatIdentity(chat, [agent]).presentation} size="row" className="opacity-50" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted">{agent.name}</span>
              <ChevronRight size={16} aria-hidden className="shrink-0 text-subtle" />
            </button>
            <SecondaryButton data-testid="agent-unarchive" size="row" aria-label={`Unarchive ${agent.name}`} onClick={() => unarchive(agent, chat)}>
              Unarchive
            </SecondaryButton>
            <SecondaryButton data-testid="agent-archived-remove" size="row" className="text-danger" aria-label={`Remove ${agent.name}…`}
              onClick={() => props.onRemove(agent)}>
              Remove…
            </SecondaryButton>
          </div>
        ))}
        {props.removed.map((chat) => {
          const { label, presentation } = agentChatIdentity(chat, []);
          return (
            <div key={chat.id} data-testid="agent-row-removed" data-agent-id={chat.agentId} className={ROW}>
              <ChatAvatar name={label} kind="agent" presentation={presentation} size="row" className="opacity-50" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-muted">{label}</span>
                <span className="m-0 mt-0.5 block text-[12px] text-muted">Removed</span>
              </span>
              <SecondaryButton data-testid="agent-hide-chat" size="row" className="text-danger" aria-label={`Remove ${label}'s chat from the list…`}
                onClick={() => setHiding({ workspaceId, chat, name: label })}>
                Remove from list…
              </SecondaryButton>
            </div>
          );
        })}
      </div>
      {hiding && props.removed.some((chat) => chat.id === hiding.chat.id) ? (
        <HideAgentChatDialog
          name={hiding.name}
          onCancel={() => setHiding(null)}
          onConfirm={() => {
            setHiding(null);
            void hideAgentChat({ workspaceId, channelId: hiding.chat.id, name: hiding.name, onError, onNotice: props.onNotice });
          }}
        />
      ) : null}
    </section>
  );
}
