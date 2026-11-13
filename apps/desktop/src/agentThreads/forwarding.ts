import { createHash } from "node:crypto";
import type { ChatAgentReader, LinkedChatStore } from "@dohc/workspace-contracts/engine";
import { cliThreadId } from "@dohc/workspace-operations/chats";
import { forwardedMessageText } from "./forwardedText";

// Forwarding (CONTEXT.md, ADR 0016): dohc gives a person's message to the
// agent's own thread when that message wakes the agent. The messages are the
// agent's unread requests, read as `dohc chat inbox` reads them, so forwarding
// reaches an agent under the conditions that reach it today. A message is read
// once the tool took it, so what is unread is what still waits.
//
// An agent's read place in a chat thread is one point in time, as it is for
// `dohc chat show` and a reply. A message that reaches this computer later
// with an earlier time than one already forwarded in its chat thread is read
// already, and is not forwarded.

/** How dohc gives a message to a tool that holds agent threads. */
export interface AgentThreadTool {
  /**
   * Gives the thread one message, and settles once the tool took it. "line"
   * puts it behind the thread's work, and "steer" hands it over during that
   * work. `forwardId` names the message for its whole life, so the tool can
   * refuse to take it twice.
   */
  forward(input: {
    threadId: string;
    message: string;
    how: "line" | "steer";
    forwardId: string;
  }): Promise<void>;
}

/** An agent with a thread, as it serves one workspace. */
export interface ServedAgent {
  id: string;
  threadId: string;
  whileBusy: "line" | "steer";
  note: string | null;
  /** How the agent reads its requests in this workspace: as an agent dohc does not start. */
  reader: Extract<ChatAgentReader, { kind: "connected" }>;
}

export interface ForwardingDependencies {
  /** dohc's CLI as a shell runs it. */
  cli: string;
  /** The workspace's name and its agents that have a thread and are on. Null when this computer no longer has the workspace. */
  workspace(workspaceId: string): Promise<{ name: string; agents: ServedAgent[] } | null>;
  chats: Pick<LinkedChatStore, "listAgentRequestsPage" | "markThreadReadByAgent" | "getThread">;
  tool: AgentThreadTool;
  /**
   * What stopped an agent's messages in a workspace, and null once they reach
   * its thread again. `agentId` is null when dohc could not read the workspace.
   */
  onProblem(workspaceId: string, agentId: string | null, problem: unknown): void;
  /** How long to wait before each try after a failure. The last one repeats. */
  retryAfterMs?: readonly number[];
}

const RETRY_AFTER_MS = [5_000, 15_000, 60_000, 5 * 60_000] as const;
const PAGE = 50;

type Request = Awaited<ReturnType<LinkedChatStore["listAgentRequestsPage"]>>["requests"][number];

/**
 * The name one forwarded message keeps for its whole life. A tool keeps that
 * name only as long as it chooses: T3 Code keeps it for one sign-in.
 */
export function forwardIdOf(workspaceId: string, agentId: string, messageId: string): string {
  return `dohc-${createHash("sha256").update([workspaceId, agentId, messageId].join("\n")).digest("hex")}`;
}

export function createForwarding(dependencies: ForwardingDependencies) {
  const { chats } = dependencies;
  const retryAfterMs = dependencies.retryAfterMs ?? RETRY_AFTER_MS;
  // A workspace's messages go out one at a time. A wake during that work runs it once more.
  const working = new Map<string, { again: boolean; done: Promise<void> }>();
  const retries = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  const stuck = new Set<string>();
  let stopped = false;

  const report = (workspaceId: string, agentId: string | null, problem: unknown) => {
    const key = `${workspaceId}\n${agentId ?? ""}`;
    if (problem === null) {
      if (!stuck.delete(key)) return;
    } else stuck.add(key);
    // A reporter that fails must not stop the next agent's messages or the next try.
    try {
      dependencies.onProblem(workspaceId, agentId, problem);
    } catch {}
  };

  const markRead = (workspaceId: string, agent: ServedAgent, request: Request) =>
    chats.markThreadReadByAgent({
      workspaceId,
      reader: agent.reader,
      threadId: request.threadId,
      upTo: { createdAtMs: request.createdAtMs, messageId: request.messageId },
    });

  /**
   * Walks the agent's unread requests, oldest first. A later page starts after
   * the last request met. False when `visit` ended the walk early.
   */
  async function eachUnread(
    workspaceId: string,
    agent: ServedAgent,
    visit: (request: Request) => Promise<boolean>,
  ): Promise<boolean> {
    let after: { createdAtMs: number; messageId: string } | undefined;
    for (;;) {
      const page = await chats.listAgentRequestsPage({
        workspaceId,
        reader: agent.reader,
        ...(after === undefined ? {} : { after }),
        limit: PAGE,
      });
      for (const request of page.requests) {
        if (!(await visit(request))) return false;
        after = { createdAtMs: request.createdAtMs, messageId: request.messageId };
      }
      if (!page.more || page.requests.length === 0) return true;
    }
  }

  /** False when the pass ended before the message went out. */
  async function forwardOne(
    workspace: { id: string; name: string },
    agent: ServedAgent,
    request: Request,
    live: () => boolean,
  ): Promise<boolean> {
    if (!live()) return false;
    const { thread } = await chats.getThread({
      workspaceId: workspace.id,
      threadId: request.threadId,
    });
    const { channel } = request;
    // The pass ended while it read the thread: nothing new goes out.
    if (!live()) return false;
    await dependencies.tool.forward({
      threadId: agent.threadId,
      how: agent.whileBusy,
      forwardId: forwardIdOf(workspace.id, agent.id, request.messageId),
      message: forwardedMessageText({
        cli: dependencies.cli,
        workspace,
        agentId: agent.id,
        place:
          channel === null
            ? { kind: "file" }
            : channel.kind === "agent"
              ? { kind: "own" }
              : { kind: "group", name: channel.name },
        thread: { id: cliThreadId(request.threadId), title: thread.title },
        author: request.author.displayName,
        body: request.body,
        note: agent.note,
      }),
    });
    // The tool took it. A failure from here leaves it unread, and the next
    // try sends it under the same id.
    await markRead(workspace.id, agent, request);
    return true;
  }

  /**
   * Forwards what each agent has unread, while `live` holds. False when
   * something stopped an agent's messages.
   */
  async function forwardUnread(workspaceId: string, live: () => boolean): Promise<boolean> {
    let workspace: Awaited<ReturnType<ForwardingDependencies["workspace"]>>;
    try {
      workspace = await dependencies.workspace(workspaceId);
    } catch (error) {
      report(workspaceId, null, error);
      return false;
    }
    report(workspaceId, null, null);
    if (!workspace) return true;
    let reached = true;
    for (const agent of workspace.agents) {
      try {
        const walked = await eachUnread(workspaceId, agent, (request) =>
          forwardOne({ id: workspaceId, name: workspace.name }, agent, request, live),
        );
        if (!walked) return reached;
        report(workspaceId, agent.id, null);
      } catch (error) {
        reached = false;
        report(workspaceId, agent.id, error);
      }
    }
    return reached;
  }

  /** Settles when the work it started, or joined, ends. */
  function wake(workspaceId: string): Promise<void> {
    if (stopped) return Promise.resolve();
    const current = working.get(workspaceId);
    if (current) {
      current.again = true;
      return current.done;
    }
    clearTimeout(retries.get(workspaceId)?.timer);
    const work = { again: false, done: Promise.resolve() };
    working.set(workspaceId, work);
    // A wake ends the pass at its next message, and the next pass reads the
    // agents again. So an agent turned off, or pointed at another thread,
    // gets nothing more from a pass that started before the change.
    const live = () => !stopped && !work.again;
    work.done = (async () => {
      let reached = false;
      try {
        do {
          work.again = false;
          reached = await forwardUnread(workspaceId, live);
        } while (work.again && !stopped);
      } finally {
        working.delete(workspaceId);
      }
      if (stopped) return;
      if (reached) {
        retries.delete(workspaceId);
        return;
      }
      const attempt = retries.get(workspaceId)?.attempt ?? 0;
      const timer = setTimeout(
        () => void wake(workspaceId),
        retryAfterMs[Math.min(attempt, retryAfterMs.length - 1)],
      );
      timer.unref?.();
      retries.set(workspaceId, { attempt: attempt + 1, timer });
    })();
    return work.done;
  }

  return {
    /** Forwards what the workspace's agents have unread. Call it when a chat write lands and when an agent's settings change. */
    wake,
    /**
     * Marks the unread requests it meets as read without forwarding them. A
     * request that arrives after its last page stays unread, and is forwarded
     * once the agent is on. Call it before the agent is on, so no wake
     * forwards for the agent while it runs.
     */
    async setAside(workspaceId: string, agent: ServedAgent): Promise<void> {
      const last = new Map<string, Request>();
      await eachUnread(workspaceId, agent, async (request) => {
        last.set(request.threadId, request);
        return true;
      });
      for (const request of last.values()) await markRead(workspaceId, agent, request);
    },
    stop(): void {
      stopped = true;
      for (const { timer } of retries.values()) clearTimeout(timer);
      retries.clear();
    },
  };
}
