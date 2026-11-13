import { randomUUID } from "node:crypto";
import {
  agentHandle,
  forwardingAgents,
  type AgentWithThread,
  type DesktopUserSettings,
} from "../settings/userSettings";
import { subscribeChatWrites } from "../workspaces/chatWriteSignals";
import { introductionText, type CliForThread } from "./forwardedText";
import { T3CodeError } from "./t3Code";
import { createForwarding, type ForwardingDependencies, type ServedAgent } from "./forwarding";
import type { T3CodeConnection } from "./t3CodeConnection";

// What the desktop does with agents that have a thread: it forwards each
// open workspace's messages to them when a chat write lands and when their
// settings change, and it connects a thread a person picks.

/** What forwarding needs to know about a workspace on this computer. */
export interface AgentThreadsWorkspace {
  name: string;
  /** The accounts this computer's person posts as there. */
  requesters: string[];
  /** Whether a post with no account is theirs. */
  unattributedCounts: boolean;
}

export interface AgentThreadsDependencies {
  /** dohc's CLI as a thread runs it. */
  cli: CliForThread;
  t3Code: T3CodeConnection;
  chats: ForwardingDependencies["chats"];
  readSettings(): Promise<Pick<DesktopUserSettings, "agents">>;
  /** Null when this computer no longer has the workspace. */
  workspace(workspaceId: string): AgentThreadsWorkspace | null;
  onProblem: ForwardingDependencies["onProblem"];
}

function served(
  agent: Pick<AgentWithThread, "id" | "name" | "thread" | "whileBusy" | "note">,
  workspace: AgentThreadsWorkspace,
): ServedAgent | null {
  // An agent whose name gives no handle cannot be named in chat or post as itself.
  const handle = agentHandle(agent.name);
  if (!handle) return null;
  return {
    id: agent.id,
    threadId: agent.thread.id,
    whileBusy: agent.whileBusy ?? "line",
    note: agent.note ?? null,
    reader: {
      kind: "connected",
      agentId: agent.id,
      handle,
      requesters: workspace.requesters,
      unattributedCounts: workspace.unattributedCounts,
    },
  };
}

/**
 * Why an agent's messages wait, for Notices. `name` is null when dohc could
 * not read which agents the workspace has.
 */
export function forwardProblemWords(name: string | null, problem: unknown): string {
  const waits =
    name === null ? "Messages for your agents are waiting." : `Messages for ${name} are waiting.`;
  const why =
    problem instanceof T3CodeError
      ? problem.message
      : "dohc could not give them to the agent's thread.";
  // What needs the person says so. For the rest, dohc tries again by itself.
  const next =
    problem instanceof T3CodeError &&
    (problem.problem === "not-allowed" || problem.problem === "needs-more-access")
      ? "Open the agent in Settings to allow dohc."
      : "dohc tries again by itself.";
  return `${waits} ${why} ${next}`;
}

export function createAgentThreads(dependencies: AgentThreadsDependencies) {
  const forwarding = createForwarding({
    cli: dependencies.cli,
    tool: dependencies.t3Code,
    chats: dependencies.chats,
    onProblem: dependencies.onProblem,
    workspace: async (workspaceId) => {
      const workspace = dependencies.workspace(workspaceId);
      if (!workspace) return null;
      const settings = await dependencies.readSettings();
      return {
        name: workspace.name,
        agents: forwardingAgents(settings, workspaceId).flatMap(
          (agent) => served(agent, workspace) ?? [],
        ),
      };
    },
  });
  const watched = new Map<string, () => void>();
  // Whether any agent had a thread when dohc last looked. Null before the first look.
  let hadThreadAgent: boolean | null = null;
  // dohc drops its sign-in when the last agent that needs it is removed
  // (ADR 0016). At the first look nothing was there before, so a sign-in no
  // agent needs is dropped then too. A drop that fails is tried at the next change.
  async function keepOrDropSignIn(): Promise<void> {
    const { agents } = await dependencies.readSettings();
    const has = Object.values(agents).some((agent) => agent.thread !== undefined);
    if (!has && hadThreadAgent !== false) await dependencies.t3Code.forget();
    hadThreadAgent = has;
  }

  return {
    /** Forwards this workspace's messages from now on. Call it when the workspace opens. */
    watch(workspaceId: string): void {
      if (!watched.has(workspaceId))
        watched.set(
          workspaceId,
          subscribeChatWrites(workspaceId, () => void forwarding.wake(workspaceId)),
        );
      if (hadThreadAgent === null) void keepOrDropSignIn().catch(() => undefined);
      void forwarding.wake(workspaceId);
    },
    /** Stops forwarding a workspace's messages. Call it when the workspace leaves this computer. */
    unwatch(workspaceId: string): void {
      watched.get(workspaceId)?.();
      watched.delete(workspaceId);
      forwarding.leave(workspaceId);
    },
    /** Tries a workspace's waiting messages again now. */
    retry(workspaceId: string): void {
      if (watched.has(workspaceId)) void forwarding.wake(workspaceId);
    },
    /** Call it after settings are saved, so work that started before the change stops. */
    settingsChanged(): void {
      void keepOrDropSignIn().catch(() => undefined);
      for (const workspaceId of watched.keys()) void forwarding.wake(workspaceId, true);
    },
    /**
     * Readies a thread to serve a workspace as an agent, before the agent is
     * saved as on: sets aside what the agent has unread there, then tells the
     * thread what dohc will send it. Rejects when T3 Code does not take the
     * introduction, so nothing is saved for a thread dohc cannot message.
     */
    async connect(
      workspaceId: string,
      agent: Pick<AgentWithThread, "id" | "name" | "thread" | "whileBusy" | "note">,
    ): Promise<void> {
      const workspace = dependencies.workspace(workspaceId);
      if (!workspace) throw new Error("This computer no longer has this workspace.");
      const reaching = served(agent, workspace);
      if (!reaching) throw new Error("Give this agent a name with a letter or digit.");
      await forwarding.setAside(workspaceId, reaching);
      await dependencies.t3Code.forward({
        threadId: reaching.threadId,
        how: "line",
        message: introductionText({ cli: dependencies.cli, agentName: agent.name }),
        // One introduction for each time a person connects this thread as this agent.
        forwardId: `dohc-intro-${randomUUID()}`,
      });
    },
    stop(): void {
      forwarding.stop();
      for (const unsubscribe of watched.values()) unsubscribe();
      watched.clear();
    },
  };
}
