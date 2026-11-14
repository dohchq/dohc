import type { LinkedChatStore } from "@dohc/workspace-contracts/engine";
import { MAX_FORWARD_ROWS, type ForwardLedger, type ForwardRow } from "./forwardLedger";
import { forwardIdOf } from "./forwarding";
import { T3CodeError, type T3CodeRun, type T3CodeThreadState } from "./t3Code";

// What an agent thread is doing with the last message dohc forwarded to it
// from each chat thread, for the line at the foot of the chat (ADR 0016): in
// line, working, waiting on the person in the tool, or finished with nothing
// posted. dohc asks the tool every few seconds while a message is in line or
// in work, and stops when none is. When work ends with no reply, dohc reminds
// the thread once, and records the reminder before it sends it.
//
// A row is the one for its agent and chat thread only while the map holds
// that same object. Everything that waits, on the chat store, the tool, or
// the ledger, checks that again before it changes anything, so work that
// began for a row which was since replaced or forgotten changes nothing.

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
  /** When the message went to the thread, so a chat can tell its newest line. */
  forwardedAtMs: number;
}

export interface ThreadStatesDependencies {
  ledger: ForwardLedger;
  tool: {
    thread(threadId: string): Promise<T3CodeThreadState>;
    /** Where one run stands, asked by its id. The tool lists only a thread's newest runs. */
    run(threadId: string, runId: string): Promise<T3CodeRun["state"]>;
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
  /** How many rows are kept. The ledger keeps as many. */
  maxRows?: number;
}

const POLL_MS = 4_000;
// After a look that failed, such as the tool not running, dohc waits longer.
const POLL_MS_AFTER_FAILURE = 30_000;
const PAGE = 200;

const keyOf = (row: Pick<ForwardRow, "workspaceId" | "agentId" | "chatThreadId">) =>
  [row.workspaceId, row.agentId, row.chatThreadId].join("\n");

type Phase = { phase: "in-line" | "working" | "ended"; run?: T3CodeRun };

export function createThreadStates(dependencies: ThreadStatesDependencies) {
  const { ledger, chats } = dependencies;
  const nowMs = dependencies.nowMs ?? Date.now;
  const pollMs = dependencies.pollMs ?? POLL_MS;
  const maxRows = dependencies.maxRows ?? MAX_FORWARD_ROWS;
  // The rows in the order they last changed, oldest first.
  const rows = new Map<string, ForwardRow>();
  const lines = new Map<string, AgentThreadLine>();
  // The last message order read in each row's chat thread, so a reply is looked for once.
  const read = new Map<string, number>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking: Promise<void> | null = null;
  // What a look that is asked for during another must cover: every workspace, or these.
  let wantsAll = false;
  const wants = new Set<string>();
  let wantsPoll = false;

  const isCurrent = (row: ForwardRow) => !stopped && rows.get(keyOf(row)) === row;
  const failed = (error: unknown) => {
    try {
      dependencies.onError?.(error);
    } catch {}
  };

  // The ledger's reads and writes, in the order they were asked for. A message
  // forwarded before the saved rows were read is taken in after them, so it
  // meets the row it may already have.
  let writes: Promise<void> = ledger.list().then((saved) => {
    for (const row of saved.slice(-maxRows)) rows.set(keyOf(row), row);
  }, failed);
  const loaded = writes;
  const write = (work: () => Promise<void>): Promise<void> => {
    const done = writes.then(work);
    writes = done.catch(failed);
    return done;
  };

  /** Forgets a row while it is still the one for its agent and chat thread. */
  const drop = (row: ForwardRow): boolean => {
    if (rows.get(keyOf(row)) !== row) return false;
    const key = keyOf(row);
    rows.delete(key);
    lines.delete(key);
    read.delete(key);
    void write(() => ledger.remove(row)).catch(() => undefined);
    return true;
  };

  /** Puts `next` in place of `was` while `was` is still current. The promise settles when it is saved. */
  const replace = (was: ForwardRow, next: ForwardRow): Promise<void> | null => {
    if (!isCurrent(was)) return null;
    const key = keyOf(next);
    rows.delete(key);
    rows.set(key, next);
    return write(() => ledger.put(next));
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
      if (!isCurrent(row)) return false;
      if (page.messages.some((message) => message.authorAgentId === row.agentId)) return true;
      after += page.messages.length;
      read.set(key, after);
      if (page.nextAfterMessageOrder === null || page.messages.length === 0) return false;
    }
  }

  /** Where the work a message started stands. */
  async function phaseOf(
    toolThreadId: string,
    runId: string | null,
    thread: T3CodeThreadState,
  ): Promise<Phase> {
    // Work the tool gave no id for is over when the thread is doing nothing.
    if (runId === null) return { phase: thread.working ? "working" : "ended" };
    const run = thread.runs.find((entry) => entry.id === runId);
    if (run) return { phase: run.state, run };
    if (runId === thread.activeRunId) return { phase: "working" };
    // The tool lists only a thread's newest work, and a person can put work
    // waiting there in another order, so what it lists says nothing of this
    // run. dohc asks for the run itself.
    return { phase: await dependencies.tool.run(toolThreadId, runId) };
  }

  /** Sets the row's line. A state that goes on keeps the time it began. */
  function show(
    row: ForwardRow,
    state: AgentThreadLineState,
    sentAtMs: number,
    toolMs: number,
  ): void {
    if (!isCurrent(row)) return;
    const key = keyOf(row);
    const before = lines.get(key);
    if (before?.state === state) return;
    const now = nowMs();
    // The tool's time for a state is when it began, unless the line was in
    // another state since then, as work that waited on the person and went on.
    const sinceMs =
      before && toolMs <= before.sinceMs ? now : Math.min(now, Math.max(toolMs, sentAtMs));
    lines.set(key, {
      agentId: row.agentId,
      chatThreadId: row.chatThreadId,
      state,
      sinceMs,
      forwardedAtMs: row.forwardedAtMs,
    });
  }

  /** Sets a row's line from what its thread is doing, and reminds the thread when its work ended in silence. */
  async function follow(row: ForwardRow, thread: T3CodeThreadState): Promise<void> {
    const { reminder } = row;
    if (reminder.state === "recorded") {
      // dohc stopped between recording the reminder and learning whether the
      // tool took it. None follows it. The line goes by the work the thread
      // has had since, which the reminder's work is part of if it went.
      const since = thread.runs.filter((entry) => entry.requestedAtMs >= reminder.atMs);
      if (since.some((entry) => entry.state === "working") || thread.working)
        return thread.waitingOnPerson
          ? show(row, "waiting-in-tool", reminder.atMs, nowMs())
          : show(row, "working", reminder.atMs, reminder.atMs);
      if (since.some((entry) => entry.state === "in-line"))
        return show(row, "in-line", reminder.atMs, reminder.atMs);
      return show(row, "silent", reminder.atMs, nowMs());
    }
    const sentAtMs = reminder.state === "sent" ? reminder.atMs : row.forwardedAtMs;
    const { phase, run } = await phaseOf(
      row.toolThreadId,
      reminder.state === "sent" ? reminder.runId : row.runId,
      thread,
    );
    if (phase === "in-line") return show(row, "in-line", sentAtMs, run?.requestedAtMs ?? sentAtMs);
    if (phase === "working")
      return thread.waitingOnPerson
        ? show(row, "waiting-in-tool", sentAtMs, nowMs())
        : show(row, "working", sentAtMs, run?.startedAtMs ?? sentAtMs);
    if (reminder.state === "sent") return show(row, "silent", sentAtMs, run?.endedAtMs ?? nowMs());

    const message = await dependencies.reminder(row);
    if (!isCurrent(row)) return;
    if (message === null) {
      drop(row);
      return;
    }
    const recorded: ForwardRow = { ...row, reminder: { state: "recorded", atMs: nowMs() } };
    // Recorded, and saved, before it goes.
    try {
      await replace(row, recorded);
    } catch (error) {
      // Not saved, so not sent. The row is as it was, and the next look tries again.
      if (isCurrent(recorded)) rows.set(keyOf(row), row);
      throw error;
    }
    if (!isCurrent(recorded)) return;
    const sent = await dependencies.tool.forward({
      threadId: row.toolThreadId,
      message,
      how: "line",
      forwardId: `remind-${forwardIdOf(row.workspaceId, row.agentId, row.messageId)}`,
    });
    const at = nowMs();
    const reminded: ForwardRow = {
      ...recorded,
      reminder: { state: "sent", runId: sent?.runId ?? null, atMs: at },
    };
    const saved = replace(recorded, reminded);
    show(reminded, "in-line", at, at);
    await saved;
  }

  /**
   * Looks once: drops the answered rows, and asks each tool thread what it is
   * doing. A row whose line is settled is looked at for a reply only, and
   * only when its workspace's chat changed.
   */
  async function look(scope: { all: boolean; workspaces: ReadonlySet<string> }): Promise<boolean> {
    await loaded;
    let anyFailed = false;
    const threads = new Map<string, Promise<T3CodeThreadState>>();
    const changed = new Set<string>();
    for (const first of [...rows.values()]) {
      if (stopped) return false;
      if (!isCurrent(first)) continue;
      const key = keyOf(first);
      const before = lines.get(key);
      const settled = before?.state === "silent";
      const chatChanged = scope.all || scope.workspaces.has(first.workspaceId);
      try {
        if ((chatChanged || !settled) && (await replied(first))) {
          drop(first);
        } else if (!settled && isCurrent(first)) {
          let thread = threads.get(first.toolThreadId);
          if (!thread) {
            thread = dependencies.tool.thread(first.toolThreadId);
            thread.catch(() => undefined);
            threads.set(first.toolThreadId, thread);
          }
          const state = await thread;
          if (isCurrent(first)) await follow(first, state);
        }
      } catch (error) {
        if (error instanceof T3CodeError && error.problem === "thread-gone") {
          // The thread is gone from the tool: nothing is in line or in work there.
          for (const row of [...rows.values()])
            if (row.toolThreadId === first.toolThreadId && drop(row)) changed.add(row.workspaceId);
        } else {
          anyFailed = true;
          failed(error);
        }
      }
      if (lines.get(key) !== before) changed.add(first.workspaceId);
    }
    for (const workspaceId of changed) {
      try {
        dependencies.onChange(workspaceId);
      } catch (error) {
        failed(error);
      }
    }
    return anyFailed;
  }

  /** Whether any row still waits on the tool, so dohc must look again. */
  const unsettled = () => [...rows.keys()].some((key) => lines.get(key)?.state !== "silent");

  function run(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (checking) return checking;
    clearTimeout(timer);
    timer = undefined;
    checking = (async () => {
      let anyFailed = false;
      try {
        while ((wantsAll || wantsPoll || wants.size > 0) && !stopped) {
          const scope = { all: wantsAll, workspaces: new Set(wants) };
          wantsAll = false;
          wantsPoll = false;
          wants.clear();
          anyFailed = await look(scope);
        }
      } finally {
        checking = null;
      }
      if (stopped || !unsettled()) return;
      timer = setTimeout(
        () => {
          wantsPoll = true;
          void run();
        },
        anyFailed ? POLL_MS_AFTER_FAILURE : pollMs,
      );
      timer.unref?.();
    })();
    return checking;
  }

  const changedNow = (workspaceId: string) => {
    try {
      dependencies.onChange(workspaceId);
    } catch (error) {
      failed(error);
    }
  };

  return {
    /**
     * The tool took a message. Its line shows from now, in place of an older
     * one for that agent and chat thread. A message reported again, as when
     * it could not be marked read and went a second time, keeps its row, so
     * a reminder already recorded for it is not sent again. Nothing here
     * waits: the row is taken in, and saved, behind the caller, once the
     * saved rows are read.
     */
    forwarded(row: Omit<ForwardRow, "reminder">): void {
      void loaded.then(() => {
        if (stopped) return;
        const key = keyOf(row);
        if (rows.get(key)?.messageId === row.messageId) return;
        const next: ForwardRow = { ...row, reminder: { state: "none" } };
        const shown = lines.delete(key);
        read.delete(key);
        rows.delete(key);
        rows.set(key, next);
        void write(() => ledger.put(next)).catch(() => undefined);
        // More rows than the ledger keeps: the oldest give way.
        const gone = new Set<string>(shown ? [row.workspaceId] : []);
        for (const oldest of rows.values()) {
          if (rows.size <= maxRows) break;
          if (drop(oldest)) gone.add(oldest.workspaceId);
        }
        for (const workspaceId of gone) changedNow(workspaceId);
        wantsPoll = true;
        void run();
      });
    },
    /**
     * Looks now. Call it with a workspace when one of its chats changed, so a
     * reply takes its line away at once, and with none to look at every row.
     */
    check(workspaceId?: string): Promise<void> {
      if (workspaceId === undefined) wantsAll = true;
      else wants.add(workspaceId);
      return run();
    },
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
      for (const row of [...rows.values()])
        if (match(row) && drop(row)) changed.add(row.workspaceId);
      for (const workspaceId of changed) changedNow(workspaceId);
      await writes;
    },
    stop(): void {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
