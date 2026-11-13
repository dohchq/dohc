import { classifyEngineFilePathForRead } from "@dohc/security-contract/engine-path-floor";
import { handleForName, normalizeHandle } from "@dohc/workspace-contracts/chat-mentions";
import { CHAT_WAKE_WAIT_MAX_MS, type ChatWakeCandidate, type ChatWakeView, type WaitingChatWake } from "@dohc/workspace-contracts/chat-wakes";
import type { ChatMessage, ChatThread } from "@dohc/workspace-contracts/engine";
import type { FileResolution } from "@dohc/workspace-engine-client/daemon";
import { ChatWakeAnswerError, ChatWakeMissingError, type ChatWakeClient, type ChatWakePageAnswer } from "./chatWakeClient";
import type { ChatWakeIntent, ChatWakeIntents } from "./chatWakeIntents";

// Runs this computer's share of an account's chat wakes for one credential
// lifetime. It reads the account's waiting wakes, claims one only after the
// message, its thread, its agent, and any decision it answers are here and
// still allow it, and records the trigger for that existing message and that
// one agent. The relay's first-winner claim is the only fence across
// computers, so nothing here takes over another computer's wake or starts a
// new generation.
//
// Order, each step saved before the next: claim-pending, claim, won, the
// local trigger, the dispatch scan, recorded, queued, removed. A restart
// finishes each saved intent from its phase; an intent of another account
// or another install waits in the file for its own lifetime. A save that
// failed can still have reached the file, so a phase read back is saved again
// before the step it allows. A step that fails after its intent is saved is
// tried again with backoff until it settles, with or without a resume.

/** The lifetime's account: its scope as chatShareSessionKey names it, its user, and this computer's install. */
export interface ChatWakeAccount {
  scope: string;
  userId: string;
  installId: string;
}

/** The local agent a candidate names, as this computer's settings have it now. */
export interface ChatWakeAgent {
  name: string;
  enabled: boolean;
  /** dohc has a way to start it. */
  launch: boolean;
  /** Dispatch admits it in this workspace now: not Restricted Mode, and trusted. */
  admitted: boolean;
}

export type ChatWakeThreadVisibility = "visible" | "hidden" | "missing" | "unknown";

export type ChatWakeMessage = Pick<ChatMessage, "id" | "workspaceId" | "threadId" | "author" | "authorUserId" | "origin">;

export interface ChatWakeDecision {
  messageId: string;
  state: "open" | "resolved";
  resolvedByMessageId?: string;
}

/** One workspace, bound to its physical attachment and held open for background work until released. */
export interface ChatWakeWorkspace {
  /** Still the attachment it was opened on, synced under this account. */
  current(): boolean;
  /** Asks for a pull. A finished pull calls the consumer's resume. */
  requestSync(): void;
  /** Null while the message has not synced here. */
  message(threadId: string, messageId: string): Promise<ChatWakeMessage | null>;
  threadVisibility(threadId: string): Promise<ChatWakeThreadVisibility>;
  decisions(threadId: string): Promise<readonly ChatWakeDecision[]>;
  /** Null when this computer has no agent with this ID. */
  agent(agentId: string): Promise<ChatWakeAgent | null>;
  /** True when it queued a request, false when the same one was already there. Both mean the trigger exists. */
  recordTrigger(input: { triggerMessageId: string; threadId: string; agentId: string }): Promise<boolean>;
  /** Arranges the dispatch scan that starts a recorded trigger. */
  dispatch(): void;
  release(): Promise<void>;
}

/**
 * A saved wake this computer can't finish by itself. dropped: the relay no longer lists a claim this computer
 * may have sent, so nothing ran here. parked: it won, and its workspace is no longer this account's synced
 * workspace here, or the attachment it was held on retired. unconfirmed: its trigger is recorded, and the relay
 * keeps answering that it has no such wake.
 */
export type ChatWakeStuck = "dropped" | "parked" | "unconfirmed";

/** How many times in a row a confirmation may answer 404 before this lifetime stops asking. */
export const CHAT_WAKE_CONFIRM_MISSES = 5;

export interface ChatWakeConsumerDeps {
  account: ChatWakeAccount;
  /** The credential lifetime this consumer runs for is still the current one. */
  isCurrent(): boolean;
  /** Bound to that lifetime's relay connection. */
  client: ChatWakeClient;
  intents: ChatWakeIntents;
  /**
   * The registered physical workspace with this account's active remote, opened for background work. Null when
   * this account no longer syncs it here; a failure that can pass, such as an engine still starting, throws.
   */
  openWorkspace(workspaceId: string): Promise<ChatWakeWorkspace | null>;
  /** Resolves after `ms`, or when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** How long to wait after `failures` failed reads in a row. */
  backoffMs(failures: number): number;
  nowMs(): number;
  holdMs?: number;
  onError(error: unknown): void;
  onStuck(intent: ChatWakeIntent, reason: ChatWakeStuck): void;
}

export interface ChatWakeConsumer {
  /** Starts the one wake read of this lifetime, after finishing the intents it saved. */
  start(): void;
  /**
   * Something a deferred wake waits for may have arrived: a pull, a settings,
   * trust, or reach change. Finishes saved intents and checks deferred wakes
   * again. Calls before that pass starts share it.
   */
  resume(): Promise<void>;
  /** Admits nothing more, and settles after the step in progress. */
  stop(): Promise<void>;
}

type Verdict = "ready" | "defer" | "reject";
type WakeFacts = Pick<ChatWakeView, "wakeId" | "workspaceId" | "threadId" | "messageId" | "generation" | "prerequisiteMessageId">
  & { candidate: ChatWakeCandidate };

/** Whether the agent still has the name its candidate matched: the mentioned handle, or the shown name it answered. */
export function chatWakeAgentMatches(name: string, matched: ChatWakeCandidate["matched"]): boolean {
  return "handle" in matched ? normalizeHandle(handleForName(name)) === matched.handle : name === matched.displayName;
}

/**
 * Whether a thread reads as the server's filtered reads would: hidden when
 * its hint or its file's current path is a secret or ignored file. On a
 * deleted file, the hints of every thread on that file count too, as the
 * server's do; the thread stays visible by its own hint. With no hint, or no
 * answer for where its file is, it is unknown. The server also keeps a
 * deleted file's last path, which this computer doesn't have, so a deleted
 * file with no hint here defers rather than claims.
 */
export function chatWakeThreadVisibility(
  thread: Pick<ChatThread, "linkedFile"> | null,
  placement: FileResolution | undefined,
  platform: NodeJS.Platform,
  /** On a deleted file: the hints of the threads on it. */
  fileHints: readonly string[] = [],
): ChatWakeThreadVisibility {
  if (thread === null) return "missing";
  const linked = thread.linkedFile;
  if (linked === undefined) return "visible";
  const hidden = (path: string) => classifyEngineFilePathForRead(path, platform).kind !== "tracked";
  if (linked.pathHint !== undefined && hidden(linked.pathHint)) return "hidden";
  if (placement?.status === "found") return hidden(placement.path) ? "hidden" : "visible";
  if (placement?.status === "absent" && fileHints.some(hidden)) return "hidden";
  if (placement?.status === "absent" && linked.pathHint !== undefined) return "visible";
  return "unknown";
}

const sameWake = (intent: ChatWakeIntent, wake: ChatWakeView) =>
  wake.wakeId === intent.wakeId && wake.workspaceId === intent.workspaceId && wake.threadId === intent.threadId &&
  wake.messageId === intent.messageId && wake.generation === intent.generation &&
  wake.prerequisiteMessageId === intent.prerequisiteMessageId;

export function createChatWakeConsumer(deps: ChatWakeConsumerDeps): ChatWakeConsumer {
  const { account } = deps;
  const holdMs = deps.holdMs ?? CHAT_WAKE_WAIT_MAX_MS;
  const abort = new AbortController();
  let stopped = false;
  const live = () => !stopped && deps.isCurrent();

  // Every step that reads or changes intents, a workspace, or a claim runs here, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  };

  // Waiting wakes that may become claimable, kept so the read's cursor can move past them.
  const deferred = new Map<string, WaitingChatWake>();
  // Waiting wakes this computer will never claim in this lifetime.
  const rejected = new Set<string>();
  // Confirmations answered 404 in a row, and the recorded wakes this lifetime stopped confirming.
  const misses = new Map<string, number>();
  const unconfirmed = new Set<string>();

  const ours = (intent: ChatWakeIntent) =>
    intent.account === account.scope && intent.userId === account.userId && intent.installId === account.installId;
  const savedWakeIds = async () => new Set((await deps.intents.list()).filter(ours).map((intent) => intent.wakeId));

  async function opened<T>(workspaceId: string, work: (workspace: ChatWakeWorkspace) => Promise<T>): Promise<T | null> {
    const workspace = await deps.openWorkspace(workspaceId);
    if (workspace === null) return null;
    try { return await work(workspace); }
    finally { await workspace.release(); }
  }

  async function admit(workspace: ChatWakeWorkspace, wake: WakeFacts): Promise<Verdict> {
    if (wake.candidate.installId !== account.installId) return "reject";
    if (!workspace.current()) return "defer";
    const message = await workspace.message(wake.threadId, wake.messageId);
    if (message === null) {
      workspace.requestSync();
      return "defer";
    }
    if (message.id !== wake.messageId || message.threadId !== wake.threadId || message.workspaceId !== wake.workspaceId ||
      message.author.kind !== "human" || message.authorUserId !== account.userId || message.origin === "cli") return "reject";
    const visibility = await workspace.threadVisibility(wake.threadId);
    if (visibility === "hidden" || visibility === "missing") return "reject";
    if (visibility === "unknown") return "defer";
    if (wake.prerequisiteMessageId !== null) {
      const decision = (await workspace.decisions(wake.threadId)).find((row) => row.messageId === wake.prerequisiteMessageId);
      if (decision === undefined || decision.state !== "resolved") {
        workspace.requestSync();
        return "defer";
      }
      if (decision.resolvedByMessageId !== wake.messageId) return "reject";
    }
    // The agent is read last, and `record` awaits nothing between this read and its enqueue,
    // so a rename or pause during an earlier read is seen here.
    const agent = await workspace.agent(wake.candidate.agentId);
    if (agent === null || !chatWakeAgentMatches(agent.name, wake.candidate.matched)) return "reject";
    if (!agent.enabled || !agent.launch || !agent.admitted) return "defer";
    return workspace.current() ? "ready" : "defer";
  }

  // Claims a saved claim-pending intent. The won intent, or null when there is nothing more to do now.
  async function claim(intent: ChatWakeIntent): Promise<ChatWakeIntent | null> {
    if (!live()) return null;
    let answer: { won: boolean; wake: ChatWakeView };
    try { answer = await deps.client.claimWake(intent.wakeId, intent.installId, abort.signal); }
    catch (error) {
      // Nothing was recorded here, so nothing runs. A claim that did commit ends unconfirmed on the server.
      // A 404 means the account was deleted, the workspace changed owner, this computer is no longer a
      // candidate, or the row is gone. None of these comes back, so it is not retried.
      if (error instanceof ChatWakeMissingError) {
        await deps.intents.remove(intent);
        deps.onStuck(intent, "dropped");
        return null;
      }
      throw error;
    }
    const { won, wake } = answer;
    if (!sameWake(intent, wake)) throw new ChatWakeAnswerError("Wake claim");
    if (won && (wake.state === "claimed" || wake.state === "unconfirmed")) {
      const winning: ChatWakeIntent = { ...intent, phase: "won" };
      await deps.intents.save(winning);
      return winning;
    }
    // Won and queued: this computer recorded and confirmed it before. Lost, held, or unclaimed: nothing to run.
    if ((won && wake.state === "queued") || (!won && wake.state !== "waiting")) {
      await deps.intents.remove(intent);
      return null;
    }
    throw new ChatWakeAnswerError("Wake claim");
  }

  // Records the won intent's trigger once the account, workspace, and agent still allow it. The recorded intent, or null.
  async function record(intent: ChatWakeIntent, workspace: ChatWakeWorkspace): Promise<ChatWakeIntent | null> {
    if (!live()) return null;
    const verdict = await admit(workspace, intent);
    if (!live()) return null;
    if (verdict === "defer") {
      // Its attachment retired or stopped syncing under this account, as when it retires during the claim. The
      // trigger can't be recorded anywhere else, so it waits for its workspace to come back. A paused or switched
      // off agent defers with its attachment current, and isn't parked.
      if (!workspace.current()) deps.onStuck(intent, "parked");
      return null;
    }
    if (verdict === "reject") {
      // Never another agent, and never a new claim: the server lets the claim end unconfirmed.
      await deps.intents.remove(intent);
      return null;
    }
    await workspace.recordTrigger({ triggerMessageId: intent.messageId, threadId: intent.threadId, agentId: intent.candidate.agentId });
    // The trigger is durable now, so its scan is arranged whether or not the recorded phase saves.
    if (!stopped) workspace.dispatch();
    const recorded: ChatWakeIntent = { ...intent, phase: "recorded" };
    await deps.intents.save(recorded);
    return recorded;
  }

  async function confirm(intent: ChatWakeIntent): Promise<void> {
    if (!live() || unconfirmed.has(intent.wakeId)) return;
    // A missing wake keeps the intent: the trigger was recorded, and that is never undone here. After
    // CHAT_WAKE_CONFIRM_MISSES answers in a row, this lifetime stops asking and reports it instead.
    let wake: ChatWakeView;
    try { wake = await deps.client.confirmQueued(intent.wakeId, intent.installId, abort.signal); }
    catch (error) {
      if (!(error instanceof ChatWakeMissingError)) throw error;
      const missed = (misses.get(intent.wakeId) ?? 0) + 1;
      misses.set(intent.wakeId, missed);
      if (missed < CHAT_WAKE_CONFIRM_MISSES) throw error;
      unconfirmed.add(intent.wakeId);
      deps.onStuck(intent, "unconfirmed");
      return;
    }
    misses.delete(intent.wakeId);
    if (!sameWake(intent, wake) || wake.state !== "queued") throw new ChatWakeAnswerError("Wake confirmation");
    await deps.intents.remove(intent);
  }

  // One saved intent, as far as it can go now. `held` is a workspace the caller already opened.
  async function settle(intent: ChatWakeIntent, held?: ChatWakeWorkspace): Promise<void> {
    let next: ChatWakeIntent | null = intent;
    if (next.phase === "claim-pending") next = await claim(next);
    if (next?.phase === "won") {
      const won = next;
      if (held) next = await record(won, held);
      else {
        const result = await opened(won.workspaceId, async (workspace) => ({ next: await record(won, workspace) }));
        // No workspace to open: parked, as in `record`.
        if (result === null) deps.onStuck(won, "parked");
        next = result?.next ?? null;
      }
    }
    if (next?.phase === "recorded") await confirm(next);
  }

  // Saved intents that failed a step and are owed another try. One loop retries them with backoff.
  let owed = false;
  let retrying: Promise<void> | null = null;
  function owe(): void {
    owed = true;
    if (retrying !== null || !live()) return;
    retrying = (async () => {
      for (let failures = 1; owed && live(); failures += 1) {
        await deps.sleep(deps.backoffMs(failures), abort.signal);
        if (!live()) break;
        owed = false;
        await serial(again).catch((error: unknown) => {
          // A pass that failed before reaching each intent, such as a failed list, still owes them all.
          deps.onError(error);
          owed = true;
        });
      }
    })().catch(deps.onError).finally(() => {
      retrying = null;
      // Owed by a step that failed after the loop's last check.
      if (owed) owe();
    });
  }

  async function recover(): Promise<void> {
    for (const intent of (await deps.intents.list()).filter(ours)) {
      if (!live()) return;
      if (unconfirmed.has(intent.wakeId)) continue;
      try {
        if (intent.phase === "claim-pending") {
          // It may be a claim this computer cancelled when its attachment retired, with a removal that failed.
          // Claim only from a current attachment, and hold it through the recording.
          await opened(intent.workspaceId, async (workspace) => {
            if (!workspace.current()) return;
            await deps.intents.save(intent);
            if (!workspace.current()) return;
            await settle(intent, workspace);
          });
        } else {
          await deps.intents.save(intent);
          await settle(intent);
        }
      } catch (error) {
        deps.onError(error);
        owe();
      }
    }
  }

  async function consider(row: WaitingChatWake): Promise<void> {
    deferred.delete(row.wakeId);
    let outcome: Verdict | null = null;
    // Saved: the wake is its intent's to finish. Saving: a failed save may or may not have reached the file,
    // so the row stays deferred and recovery is owed; a pass skips the row if its intent is there.
    let stage = "admit" as "admit" | "saving" | "saved";
    try {
      outcome = await opened(row.workspaceId, async (workspace): Promise<Verdict> => {
        const verdict = await admit(workspace, row);
        if (verdict !== "ready" || !live()) return verdict === "reject" ? "reject" : "defer";
        const intent: ChatWakeIntent = {
          account: account.scope, userId: account.userId, installId: account.installId,
          wakeId: row.wakeId, generation: row.generation, workspaceId: row.workspaceId, threadId: row.threadId,
          messageId: row.messageId, prerequisiteMessageId: row.prerequisiteMessageId, candidate: row.candidate,
          phase: "claim-pending",
        };
        stage = "saving";
        await deps.intents.save(intent);
        // The attachment can retire while the save waits on disk. No claim was sent, so the intent goes.
        if (!workspace.current()) {
          await deps.intents.remove(intent);
          stage = "admit";
          return "defer";
        }
        stage = "saved";
        await settle(intent, workspace);
        return "ready";
      });
    } catch (error) {
      deps.onError(error);
      if (stage !== "admit") owe();
    }
    if (outcome === "reject") rejected.add(row.wakeId);
    else if (stage !== "saved") deferred.set(row.wakeId, row);
  }

  // Accounts for every row of a page, or throws before any when the saved intents can't be read.
  async function take(page: ChatWakePageAnswer): Promise<boolean> {
    const saved = await savedWakeIds();
    for (const row of page.wakes) {
      if (!live()) return false;
      if (!saved.has(row.wakeId) && !rejected.has(row.wakeId)) await consider(row);
    }
    return true;
  }

  async function reconsider(): Promise<void> {
    const saved = await savedWakeIds();
    for (const row of [...deferred.values()]) {
      if (!live()) return;
      if (saved.has(row.wakeId)) deferred.delete(row.wakeId);
      else await consider(row);
    }
  }

  async function again(): Promise<void> {
    if (!live()) return;
    await recover();
    await reconsider();
  }

  // A pass that fails before reaching each intent, such as a failed list, owes them all.
  function passFailed(error: unknown): void {
    deps.onError(error);
    owe();
  }

  async function read(): Promise<void> {
    await serial(recover).catch(passFailed);
    // The feed lists only waiting wakes that changed after `since`; a restart starts again from 0.
    let since = 0;
    let failures = 0;
    while (live()) {
      try {
        const startedAtMs = deps.nowMs();
        const page = await deps.client.waitWakes({ installId: account.installId, since, holdMs }, abort.signal);
        if (page.wakes.length === 0 && page.cursor === since && deps.nowMs() - startedAtMs < holdMs / 2) {
          throw new Error("The server answered a wake read early without a change.");
        }
        if (!(await serial(() => take(page)))) continue;
        since = page.cursor;
        failures = 0;
      } catch (error) {
        if (!live()) break;
        deps.onError(error);
        failures += 1;
        await deps.sleep(deps.backoffMs(failures), abort.signal);
      }
    }
  }

  let running: Promise<void> | null = null;
  let pass: Promise<void> | null = null;
  return {
    start() {
      if (!stopped) running ??= read().catch(deps.onError);
    },
    resume() {
      if (stopped) return Promise.resolve();
      return pass ??= serial(async () => {
        pass = null;
        await again();
      }).catch(passFailed);
    },
    async stop() {
      stopped = true;
      abort.abort();
      await running;
      await retrying;
      await queue;
    },
  };
}
