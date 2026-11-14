import {
  CHAT_WAKE_WAIT_MAX_MS,
  ChatRunnersReply,
  ChatWakeClaimReply,
  ChatWakePage,
  ChatWakeQueuedReply,
  type ChatRunnerDeclaration,
  type ChatWakeView,
  type WaitingChatWake,
} from "@dohc/workspace-contracts/chat-wakes";
import type { SyncRelayConnection } from "@dohc/workspace-contracts/relay";
import { relayRequest } from "../workspaces/relayRequest";

// The relay routes a signed-in computer uses to wake its chat agents. Every
// answer is checked before anyone acts on it. A 401 is RelayUnauthorizedError,
// from relayRequest. A claim or confirmation that times out, or answers in a
// shape this build does not read, has an unknown outcome: the caller keeps
// what it saved and asks again.

/** How long a wake read may take past its hold. */
const WAIT_MARGIN_MS = 15_000;
/** How long a claim, a confirmation, or a roster replacement may take. */
export const CHAT_WAKE_MUTATION_MS = 10_000;

/** No such wake for this account and computer, or this computer did not win it. Not proof that an earlier claim never happened. */
export class ChatWakeMissingError extends Error {
  constructor() {
    super("The server has no such wake for this computer.");
    this.name = "ChatWakeMissingError";
  }
}

/** The server holds as many wake reads as it can, or this sign-in asks faster than it answers. */
export class ChatWakeBusyError extends Error {
  constructor() {
    super("The server is busy. dohc asks again shortly.");
    this.name = "ChatWakeBusyError";
  }
}

/** An answer that is not the server's shape, or not about what was asked. Its outcome is unknown. */
export class ChatWakeAnswerError extends Error {
  constructor(what: string) {
    super(`The server's answer to ${what} could not be read.`);
    this.name = "ChatWakeAnswerError";
  }
}

export interface ChatWakePageAnswer {
  cursor: number;
  wakes: WaitingChatWake[];
}

export interface ChatWakeClient {
  replaceRunners(
    workspaceId: string,
    declaration: ChatRunnerDeclaration,
    signal: AbortSignal,
  ): Promise<void>;
  /** Waits up to `holdMs` for a waiting wake listing `installId` that changed after `since`. */
  waitWakes(
    input: { installId: string; since: number; holdMs: number },
    signal: AbortSignal,
  ): Promise<ChatWakePageAnswer>;
  claimWake(
    wakeId: string,
    installId: string,
    signal: AbortSignal,
  ): Promise<{ won: boolean; wake: ChatWakeView }>;
  confirmQueued(wakeId: string, installId: string, signal: AbortSignal): Promise<ChatWakeView>;
}

export function createChatWakeClient(input: {
  relay: SyncRelayConnection;
  /** A signal that aborts after `ms`. Tests pass one they control. */
  timeout?: (ms: number) => AbortSignal;
}): ChatWakeClient {
  const timeout = input.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  const request = async (path: string, init: RequestInit, label: string): Promise<unknown> => {
    const response = await relayRequest({
      relay: input.relay,
      path,
      init,
      errors: { 404: () => new ChatWakeMissingError(), 503: () => new ChatWakeBusyError() },
      label,
    });
    try {
      return await response.json();
    } catch (error) {
      // A read the deadline or the caller cut short is that abort, not a bad answer.
      if (init.signal?.aborted) throw error;
      throw new ChatWakeAnswerError(label);
    }
  };
  const post = (path: string, body: unknown, signal: AbortSignal, label: string) =>
    request(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, timeout(CHAT_WAKE_MUTATION_MS)]),
      },
      label,
    );
  const wakePath = (wakeId: string, action: "claim" | "queued") =>
    `/sync/wakes/${encodeURIComponent(wakeId)}/${action}`;

  return {
    async replaceRunners(workspaceId, declaration, signal) {
      const answer = ChatRunnersReply.safeParse(
        await request(
          `/sync/workspaces/${encodeURIComponent(workspaceId)}/runners`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(declaration),
            signal: AbortSignal.any([signal, timeout(CHAT_WAKE_MUTATION_MS)]),
          },
          "Runner declaration",
        ),
      );
      if (
        !answer.success ||
        answer.data.workspaceId !== workspaceId ||
        answer.data.installId !== declaration.installId ||
        answer.data.runners !== declaration.runners.length
      )
        throw new ChatWakeAnswerError("Runner declaration");
    },

    async waitWakes({ installId, since, holdMs }, signal) {
      const hold = Math.min(Math.max(0, Math.floor(holdMs)), CHAT_WAKE_WAIT_MAX_MS);
      const query = new URLSearchParams({ installId, since: String(since), wait: String(hold) });
      const answer = ChatWakePage.safeParse(
        await request(
          `/sync/wakes?${query.toString()}`,
          {
            signal: AbortSignal.any([signal, timeout(hold + WAIT_MARGIN_MS)]),
          },
          "Wake read",
        ),
      );
      if (
        !answer.success ||
        answer.data.wakes.some((wake) => wake.candidate.installId !== installId)
      ) {
        throw new ChatWakeAnswerError("Wake read");
      }
      return { cursor: answer.data.cursor, wakes: answer.data.wakes };
    },

    async claimWake(wakeId, installId, signal) {
      const answer = ChatWakeClaimReply.safeParse(
        await post(wakePath(wakeId, "claim"), { installId }, signal, "Wake claim"),
      );
      if (!answer.success || answer.data.wake.wakeId !== wakeId)
        throw new ChatWakeAnswerError("Wake claim");
      return { won: answer.data.won, wake: answer.data.wake };
    },

    async confirmQueued(wakeId, installId, signal) {
      const answer = ChatWakeQueuedReply.safeParse(
        await post(wakePath(wakeId, "queued"), { installId }, signal, "Wake confirmation"),
      );
      if (!answer.success || answer.data.wake.wakeId !== wakeId)
        throw new ChatWakeAnswerError("Wake confirmation");
      return answer.data.wake;
    },
  };
}
