import { randomUUID } from "node:crypto";
import {
  agentHandle,
  forwardingAgents,
  type AgentWithThread,
  type DesktopUserSettings,
} from "../settings/userSettings";
import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import { cliThreadId } from "@dohc/workspace-operations/chats";
import { subscribeChatWrites } from "../workspaces/chatWriteSignals";
import { introductionText, quoted, reminderText, type CliForThread } from "./forwardedText";
import type { ForwardLedger } from "./forwardLedger";
import { T3CodeError } from "./t3Code";
import { createForwarding, type ForwardingDependencies, type ServedAgent } from "./forwarding";
import type { T3CodeConnection } from "./t3CodeConnection";
import { createThreadStates, type AgentThreadLine } from "./threadStates";

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
  chats: ForwardingDependencies["chats"] & Pick<LinkedChatStore, "listMessagesPage">;
  /** Where the forwarded messages that wait for an answer are kept. */
  ledger: ForwardLedger;
  /** A workspace's lines changed: what each agent thread is doing with its last message. */
  onLines(workspaceId: string): void;
  onError?(error: unknown): void;
  nowMs?: () => number;
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
  const nowMs = dependencies.nowMs ?? Date.now;
  /** The workspace's name and the agents dohc forwards its messages to. Null when this computer no longer has it. */
  const serving = async (workspaceId: string) => {
    const workspace = dependencies.workspace(workspaceId);
    if (!workspace) return null;
    const settings = await dependencies.readSettings();
    return {
      name: workspace.name,
      agents: forwardingAgents(settings, workspaceId).flatMap(
        (agent) => served(agent, workspace) ?? [],
      ),
    };
  };
  const states = createThreadStates({
    ledger: dependencies.ledger,
    tool: dependencies.t3Code,
    chats: dependencies.chats,
    // Only for an agent that still serves the workspace with the same thread.
    reminder: async (row) => {
      const agents = (await serving(row.workspaceId))?.agents ?? [];
      if (!agents.some((agent) => agent.id === row.agentId && agent.threadId === row.toolThreadId))
        return null;
      const { thread } = await dependencies.chats.getThread({
        workspaceId: row.workspaceId,
        threadId: row.chatThreadId,
      });
      return reminderText({
        cli: dependencies.cli,
        workspace: { id: row.workspaceId },
        agentId: row.agentId,
        thread: { id: cliThreadId(row.chatThreadId), title: thread.title },
      });
    },
    onChange: dependencies.onLines,
    onError: dependencies.onError,
    nowMs,
  });
  const forwarding = createForwarding({
    cli: dependencies.cli,
    tool: dependencies.t3Code,
    chats: dependencies.chats,
    onProblem: dependencies.onProblem,
    workspace: serving,
    onForwarded: (forwarded) =>
      states.forwarded({
        workspaceId: forwarded.workspaceId,
        agentId: forwarded.agent.id,
        chatThreadId: forwarded.chatThreadId,
        toolThreadId: forwarded.agent.threadId,
        messageId: forwarded.messageId,
        afterOrder: forwarded.afterOrder,
        forwardedAtMs: nowMs(),
        runId: forwarded.runId,
      }),
  });
  // A line is for an agent dohc forwards to. One that was turned off, removed,
  // or pointed at another thread has none.
  const dropLinesNoAgentHas = async () => {
    const settings = await dependencies.readSettings();
    await states.forget(
      (row) =>
        !forwardingAgents(settings, row.workspaceId).some(
          (agent) => agent.id === row.agentId && agent.thread.id === row.toolThreadId,
        ),
    );
  };
  const watched = new Map<string, () => void>();
  // Whether any agent had a thread when dohc last looked. Null before the first look.
  let hadThreadAgent: boolean | null = null;
  // dohc drops its sign-in when the last agent that needs it is removed
  // (ADR 0016). At the first look nothing was there before, so a sign-in no
  // agent needs is dropped then too. A drop that fails is tried at the next
  // change. One look runs at a time, in order, so an older look cannot
  // overwrite what a newer one saw.
  let looking: Promise<void> = Promise.resolve();
  const keepOrDropSignIn = (): void => {
    looking = looking
      .then(async () => {
        const { agents } = await dependencies.readSettings();
        const has = Object.values(agents).some((agent) => agent.thread !== undefined);
        if (!has && hadThreadAgent !== false) await dependencies.t3Code.forget();
        hadThreadAgent = has;
      })
      .catch(() => undefined);
  };

  return {
    /** Forwards this workspace's messages from now on. Call it when the workspace opens. */
    watch(workspaceId: string): void {
      if (!watched.has(workspaceId))
        watched.set(
          workspaceId,
          subscribeChatWrites(workspaceId, () => {
            void forwarding.wake(workspaceId);
            // A reply takes its line away at once.
            void states.check(workspaceId);
          }),
        );
      if (hadThreadAgent === null) keepOrDropSignIn();
      void forwarding.wake(workspaceId);
      void states.check(workspaceId);
    },
    /** What each agent thread is doing with the last message forwarded from each of the workspace's chat threads. */
    lines: (workspaceId: string): AgentThreadLine[] => states.lines(workspaceId),
    /** Asks the tool now what a workspace's agent threads are doing, as after the person answered a thread's question. */
    look(workspaceId: string): void {
      void states.check(workspaceId);
    },
    /** Stops forwarding a workspace's messages. Call it when the workspace leaves this computer. */
    unwatch(workspaceId: string): void {
      watched.get(workspaceId)?.();
      watched.delete(workspaceId);
      forwarding.leave(workspaceId);
      void states
        .forget((row) => row.workspaceId === workspaceId)
        .catch((error: unknown) => dependencies.onError?.(error));
    },
    /** Tries a workspace's waiting messages again now. */
    retry(workspaceId: string): void {
      if (watched.has(workspaceId)) void forwarding.wake(workspaceId);
    },
    /** Call it after settings are saved, so work that started before the change stops. */
    settingsChanged(): void {
      keepOrDropSignIn();
      void dropLinesNoAgentHas().catch((error: unknown) => dependencies.onError?.(error));
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
      // The thread replies with a command that names dohc's program. Without
      // one it could not reply, so dohc connects nothing.
      if (dependencies.cli.program === null) {
        const { refused } = dependencies.cli;
        throw new Error(
          refused === undefined
            ? "dohc can't connect a thread, because it can't find its own program."
            : `dohc can't connect a thread from where it is installed. The path of its folder has ${quoted(refused)}, which a command can't carry safely. Install dohc in a folder whose path has none.`,
        );
      }
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
      states.stop();
      forwarding.stop();
      for (const unsubscribe of watched.values()) unsubscribe();
      watched.clear();
    },
  };
}
