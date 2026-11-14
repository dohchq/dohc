import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import type { ForwardLedger, ForwardRow } from "./forwardLedger";
import { forwardIdOf } from "./forwarding";
import type { T3CodeThreadState } from "./t3Code";

// What an agent thread is doing with the last message dohc forwarded to it
// from each chat thread, for the line at the foot of the chat (ADR 0016): in
// line, working, waiting on the person in the tool, or finished with nothing
// posted. dohc asks the tool every few seconds while a message is in line or
// in work, and stops when none is. When work ends with no reply, dohc reminds
// the thread once, and records the reminder before it sends it.

export type AgentThreadLineState =
  /** The tool took the message, and other work is ahead of it. */
  | "in-line"
  | "working"
  /** The thread's own question or approval is open in the tool. */
  | "waiting-in-tool"
  /** The work ended, dohc reminded the thread once, and it posted nothing. */
  | "silent";

export interface AgentThreadLine {
  agentId: string;
  /** The chat thread the forwarded message is in. */
  chatThreadId: string;
  state: AgentThreadLineState;
  /** When this state began. */
  sinceMs: number;
}

export interface ThreadStatesDependencies {
  ledger: ForwardLedger;
  tool: {
    thread(threadId: string): Promise<T3CodeThreadState>;
    forward(input: {
      threadId: string;
      message: string;
      how: "line" | "steer";
      forwardId: string;
    }): Promise<{ runId: string | null } | void>;
  };
  chats: Pick<LinkedChatStore, "listMessagesPage">;
  /**
   * The reminder for a row, or null when its agent no longer serves the
   * workspace with that thread, so the row has nothing left to show.
   */
  reminder(row: ForwardRow): Promise<string | null>;
  /** A workspace's lines changed. */
  onChange(workspaceId: string): void;
  onError?(error: unknown): void;
  nowMs?: () => number;
  /** How long between two looks at the tool while a message is in line or in work. */
  pollMs?: number;
}

const POLL_MS = 4_000;
// After a look that failed, such as the tool not running, dohc waits longer.
const POLL_MS_AFTER_FAILURE = 30_000;
const PAGE = 200;
// The tool lists new work at once. Work it does not list yet counts as in
// line for this long, then as over.
const UNLISTED_MS = 10 * 60_000;

const keyOf = (row: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId">) =>
  [row.workspaceId, row.agentId, row.chatThreadId].join("\n");

export function createThreadStates(dependencies: ThreadStatesDependencies) {
  const { ledger, chats } = dependencies;
  const nowMs = dependencies.nowMs ?? Date.now;
  const pollMs = dependencies.pollMs ?? POLL_MS;
  const rows = new Map<string, ForwardRow>();
  const lines = new Map<string, AgentThreadLine>();
  // The last message order read in each row's chat thread, so a reply is looked for once.
  const read = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | null = null;
  let again = false;

  const loaded = ledger.list().then(
    (saved) => {
      for (const row of saved) rows.set(keyOf(row), row);
    },
    (error: unknown) => dependencies.onError?.(error),
  );

  const drop = (row: ForwardRow) => {
    const key = keyOf(row);
    if (rows.get(key) !== row) return;
    rows.delete(key);
    lines.delete(key);
    read.delete(key);
  };

  /** Whether the agent posted in the chat thread after the message went. */
  async function replied(row: ForwardRow): Promise<boolean> {
    const key = keyOf(row);
    let after = read.get(key) ?? row.afterOrder;
    for (;;) {
      const page = await chats.listMessagesPage({
        workspaceId: row.workspaceId,
        threadId: row.chatThreadId,
        ...(after < 0 ? {} : { afterMessageOrder: after }),
        limit: PAGE,
      });
      if (page.messages.some((message) => message.authorAgentId === row.agentId)) return true;
      after += page.messages.length;
      read.set(key, after);
      if (page.nextAfterMessageOrder === null || page.messages.length === 0) return false;
    }
  }

  const save = async (row: ForwardRow) => {
    rows.set(keyOf(row), row);
    await ledger.put(row);
  };

  /** The line for a row from what its thread is doing, reminding it when its work ended in silence. */
  async function lineOf(
    row: ForwardRow,
    thread: T3CodeThreadState,
  ): Promise<AgentThreadLine | null> {
    const key = keyOf(row);
    const line = (state: AgentThreadLineState, sinceMs: number): AgentThreadLine => {
      const before = lines.get(key);
      // A state that goes on keeps the time it began.
      return before?.state === state
        ? before
        : { agentId: row.agentId, chatThreadId: row.chatThreadId, state, sinceMs };
    };
    // A reminder recorded and never confirmed may have gone, so none follows it.
    if (row.reminder.state === "recorded") return line("silent", nowMs());
    const reminded = row.reminder.state === "sent" ? row.reminder : null;
    const runId = reminded ? reminded.runId : row.runId;
    const sentAtMs = reminded ? reminded.atMs : row.forwardedAtMs;
    const run = runId === null ? undefined : thread.runs.find((entry) => entry.id === runId);
    // Work the tool gave no id for is over when the thread is doing nothing.
    // Work it does not list is not listed yet when nothing listed is newer,
    // and is over when newer work pushed it off the list.
    const unlisted =
      runId !== null &&
      nowMs() - sentAtMs < UNLISTED_MS &&
      !thread.runs.some((entry) => entry.requestedAtMs >= sentAtMs);
    const phase = run
      ? run.state
      : unlisted
        ? "in-line"
        : runId === null && thread.working
          ? "working"
          : "ended";
    if (phase === "in-line") return line("in-line", run?.requestedAtMs ?? row.forwardedAtMs);
    if (phase === "working")
      return thread.waitingOnPerson
        ? line("waiting-in-tool", nowMs())
        : line("working", run?.startedAtMs ?? run?.requestedAtMs ?? row.forwardedAtMs);
    if (row.reminder.state === "sent") return line("silent", run?.endedAtMs ?? nowMs());

    const message = await dependencies.reminder(row);
    if (message === null) {
      drop(row);
      await ledger.remove(row);
      return null;
    }
    const recorded: ForwardRow = { ...row, reminder: { state: "recorded" } };
    await save(recorded);
    const sent = await dependencies.tool.forward({
      threadId: row.toolThreadId,
      message,
      how: "line",
      forwardId: `remind-${forwardIdOf(row.workspaceId, row.agentId, row.messageId)}`,
    });
    await save({
      ...recorded,
      reminder: { state: "sent", runId: sent?.runId ?? null, atMs: nowMs() },
    });
    return line("in-line", nowMs());
  }

  /** Looks once at every row: drops the answered ones, and asks each tool thread what it is doing. */
  async function look(): Promise<boolean> {
    await loaded;
    let failed = false;
    const threads = new Map<string, Promise<T3CodeThreadState>>();
    const changed = new Set<string>();
    for (const row of [...rows.values()]) {
      if (stopped) return false;
      const key = keyOf(row);
      const before = lines.get(key);
      try {
        if (await replied(row)) {
          drop(row);
          await ledger.remove(row);
        } else {
          let thread = threads.get(row.toolThreadId);
          if (!thread) {
            thread = dependencies.tool.thread(row.toolThreadId);
            thread.catch(() => undefined);
            threads.set(row.toolThreadId, thread);
          }
          const current = rows.get(key);
          const next = current ? await lineOf(current, await thread) : null;
          if (next) lines.set(key, next);
        }
      } catch (error) {
        failed = true;
        dependencies.onError?.(error);
      }
      if (lines.get(key) !== before) changed.add(row.workspaceId);
    }
    for (const workspaceId of changed) dependencies.onChange(workspaceId);
    return failed;
  }

  /** Whether any row still waits on the tool, so dohc must look again. */
  const unsettled = () =>
    [...rows.keys()].some((key) => {
      const state = lines.get(key)?.state;
      return state === undefined || state !== "silent";
    });

  function check(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (checking) {
      again = true;
      return checking;
    }
    clearTimeout(timer);
    timer = undefined;
    checking = (async () => {
      let failed = false;
      try {
        do {
          again = false;
          failed = await look();
        } while (again && !stopped);
      } finally {
        checking = null;
      }
      if (stopped || !unsettled()) return;
      timer = setTimeout(() => void check(), failed ? POLL_MS_AFTER_FAILURE : pollMs);
      timer.unref?.();
    })();
    return checking;
  }

  return {
    /** The tool took a message. Its line shows from now, in place of an older one for that agent and chat thread. */
    async forwarded(row: Omit<ForwardRow, "reminder">): Promise<void> {
      await loaded;
      const next: ForwardRow = { ...row, reminder: { state: "none" } };
      const key = keyOf(next);
      lines.delete(key);
      read.delete(key);
      await save(next);
      void check();
    },
    /** Looks now. Call it when a chat write lands, so a reply takes the line away at once. */
    check,
    /** The lines of a workspace's chats, as of the last look. */
    lines(workspaceId: string): AgentThreadLine[] {
      return [...rows.entries()].flatMap(([key, row]) => {
        const line = lines.get(key);
        return row.workspaceId === workspaceId && line ? [line] : [];
      });
    },
    /** Forgets every row that matches, such as a workspace's when it leaves this computer or an agent's when it is removed. */
    async forget(match: (row: ForwardRow) => boolean): Promise<void> {
      await loaded;
      const changed = new Set<string>();
      for (const row of [...rows.values()]) {
        if (!match(row)) continue;
        drop(row);
        changed.add(row.workspaceId);
      }
      await ledger.removeWhere(match);
      for (const workspaceId of changed) dependencies.onChange(workspaceId);
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
