import { normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import {
  agentHandle,
  type Agent,
  type AgentSettings,
  type AgentWithThread,
} from "../settings/userSettings";

// The changes a person makes to the thread an agent has and the workspaces it
// forwards from. Each runs after the one before it, and saves from the
// settings file as it is then, so two windows cannot write over each other
// and a thread is never told about workspaces it will not get.

/** What reaches the chats and the tool. */
export interface AgentThreadSteps {
  /** Marks read, without forwarding, what the agent has unread in the workspace. */
  setAside(workspaceId: string, agent: AgentWithThread): Promise<void>;
  /** Tells the agent's thread that it now gets this workspace's messages. */
  tellOfWorkspace(workspaceId: string, agent: AgentWithThread): Promise<void>;
  /** Introduces dohc to the thread `agent` names. */
  change(workspaceId: string, agent: AgentWithThread): Promise<void>;
}

export interface AgentThreadChangesDependencies {
  /** The agents as dohc last read them. A save may be newer than this. */
  agents(): Promise<Agent[]>;
  /**
   * Changes one agent from the settings file as it is then. `change` throws
   * to refuse, and answers the agent it was given when nothing changes.
   * `before` runs first, in the same turn of the settings queue, with the
   * agent as it is in effect. Nothing comes into effect between it and the
   * write.
   */
  changeAgent(
    agentId: string,
    change: (agent: AgentSettings) => AgentSettings,
    before?: (inEffect: AgentSettings) => Promise<void>,
  ): Promise<unknown>;
  threads: AgentThreadSteps;
}

/** One change a window asked for. `assertCurrent` throws once the window shows another workspace. */
interface Asked {
  workspaceId: string;
  agentId: string;
  assertCurrent(): void;
}

export interface AgentThreadChanges {
  /** Turns the workspace on or off for the agent's thread, and saves the agent with it. */
  setWorkspace(input: Asked & { on: boolean }): Promise<void>;
  /** Points the agent at another thread, and saves the agent with it. */
  changeThread(input: Asked & { threadId: string }): Promise<void>;
}

export function createAgentThreadChanges(
  dependencies: AgentThreadChangesDependencies,
): AgentThreadChanges {
  const { changeAgent, threads } = dependencies;
  let changed: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = changed.then(work, work);
    changed = done.catch(() => undefined);
    return done;
  };
  const serves = (agent: AgentSettings, workspaceId: string) =>
    agent.workspaces?.includes(workspaceId) ?? false;
  // The handle is how dohc finds the messages that wait for an agent. Case
  // and the form of an accent do not tell two handles apart.
  const handleOf = (name: string) => normalizeHandle(agentHandle(name));

  return {
    setWorkspace: ({ workspaceId, agentId, on, assertCurrent }) =>
      inTurn(async () => {
        // The call may have waited behind another change.
        assertCurrent();
        if (!on) {
          await changeAgent(agentId, (agent) => {
            assertCurrent();
            return serves(agent, workspaceId)
              ? {
                  ...agent,
                  workspaces: (agent.workspaces ?? []).filter((id) => id !== workspaceId),
                }
              : agent;
          });
          return;
        }
        const agent = (await dependencies.agents()).find(({ id }) => id === agentId);
        if (!agent?.thread) throw new Error("This agent has no thread.");
        if (serves(agent, workspaceId)) {
          // Already on, as when another window turned it on first. Nothing is
          // set aside a second time. The file is asked, because what dohc
          // last read may be older than an edit made in the file.
          let onInFile = false;
          await changeAgent(agentId, (current) => {
            onInFile = serves(current, workspaceId);
            return current;
          });
          if (onInFile) return;
          throw new Error(
            `The settings file changed while dohc turned this workspace on for ${agent.name}. Try again.`,
          );
        }
        const told = { ...agent, thread: agent.thread };
        // What the agent has unread is set aside only while the workspace is
        // off for it. Once it is on, by this change or by an edit in the
        // file, a message there is one the agent is to get. The settings
        // queue holds what is in effect still while dohc reads.
        const setAside = async (inEffect: AgentSettings) => {
          assertCurrent();
          if (!serves(inEffect, workspaceId)) await threads.setAside(workspaceId, told);
        };
        await changeAgent(agentId, (current) => current, setAside);
        await threads.tellOfWorkspace(workspaceId, told);
        // T3 Code can take seconds to answer. What was written meanwhile came
        // before the workspace was on, and is set aside in the turn that
        // saves it. A message written in the moment between that read and the
        // save is forwarded.
        await changeAgent(
          agentId,
          (current) => {
            assertCurrent();
            // The thread dohc told is the one that gets the workspace, and the
            // messages it set aside are the ones the agent would have got.
            if (current.thread?.id !== told.thread.id)
              throw new Error(
                `${agent.name} was connected to another thread while dohc told its thread about this workspace. Try again.`,
              );
            if (handleOf(current.name) !== handleOf(agent.name))
              throw new Error(
                `${agent.name} was renamed while dohc told its thread about this workspace. Try again.`,
              );
            return serves(current, workspaceId)
              ? current
              : { ...current, workspaces: [...(current.workspaces ?? []), workspaceId] };
          },
          setAside,
        );
      }),

    changeThread: ({ workspaceId, agentId, threadId, assertCurrent }) =>
      inTurn(async () => {
        assertCurrent();
        const agents = await dependencies.agents();
        const agent = agents.find(({ id }) => id === agentId);
        if (!agent?.thread || !serves(agent, workspaceId))
          throw new Error("This agent has no thread for this workspace.");
        const left = agent.thread.id;
        if (left === threadId)
          throw new Error(`${agent.name} is already connected to this thread.`);
        // One thread is one agent (ADR 0016).
        const connected = agents.find((other) => other.thread?.id === threadId);
        if (connected) throw new Error(`${connected.name} is already connected to this thread.`);
        // The introduction says which workspaces the thread gets, from the
        // agent as it is saved now. No workspace is turned on or off for it
        // until this change is saved.
        await threads.change(workspaceId, {
          ...agent,
          thread: { ...agent.thread, id: threadId },
        });
        await changeAgent(agentId, (current) => {
          assertCurrent();
          if (current.thread?.id !== left)
            throw new Error(`${agent.name} was connected to another thread meanwhile. Try again.`);
          return { ...current, thread: { ...current.thread, id: threadId } };
        });
      }),
  };
}
