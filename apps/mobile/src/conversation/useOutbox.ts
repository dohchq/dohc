import { chatWords } from "@dohc/interface-words/notices";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";
import { confirm } from "../confirm";
import { copyText } from "../copy";
import type { DiscardTarget, OutboxState } from "../server/outbox";
import {
  createConversationWrites,
  type ConversationWrites,
  type WriteOutbox,
} from "./conversationWrites";
import { answerWrite, type AnswerPlace } from "./decisionAnswers";
import type { OutboxScope } from "./outboxMessages";
import { nextReaction } from "./reactions";
import type { LocalMark, Message } from "./types";

const never = () => () => undefined;
const nothing = () => null;

/** The outbox's state, following each change, or null without an outbox. */
export function useOutboxState(outbox: WriteOutbox | null): OutboxState | null {
  return useSyncExternalStore<OutboxState | null>(
    outbox?.subscribe ?? never,
    outbox?.state ?? nothing,
  );
}

/**
 * A conversation's write controller, made again when its outbox, gate or scope changes. `isCurrent` must say whether
 * the screen still shows the account and workspace it was made for.
 */
export function useConversationWrites(
  outbox: WriteOutbox | null,
  enabled: boolean,
  isCurrent: () => boolean,
): ConversationWrites {
  return useMemo(
    () => createConversationWrites({ outbox, enabled, isCurrent }),
    [outbox, enabled, isCurrent],
  );
}

/** What a message only this phone has offers: Send on a withheld one, Copy, and Discard. */
export interface LocalActions {
  /** Every action waits, as while a Sign out's delete is owed. */
  readonly blocked: boolean;
  /** A failed Send or Discard, by operation, shown under its message. */
  readonly problems: ReadonlyMap<string, string>;
  send(mark: LocalMark): void;
  discard(mark: LocalMark): void;
  /** Discards a reaction this phone keeps, asking first as for a message. */
  discardReaction(mark: LocalMark): void;
  /** Discards a record that can't be read, by its handle from the outbox's state. */
  discardUnreadable(handle: string): void;
  copy(mark: LocalMark): void;
}

/** A settled message won't send. One a request may have reached, unsettled, may still send after Discard. */
const maySend = (mark: LocalMark) =>
  mark.attempted &&
  (mark.state.kind === "sending" ||
    mark.state.kind === "stalled" ||
    mark.state.kind === "withheld");

/** Failures shown in place, by key, with a setter that clears one with null. */
function useProblems() {
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const setProblem = useCallback((key: string, text: string | null) => {
    setProblems((previous) => {
      if (text === null && !previous.has(key)) return previous;
      const next = new Map(previous);
      if (text === null) next.delete(key);
      else next.set(key, text);
      return next;
    });
  }, []);
  return [problems, setProblem] as const;
}

export function useLocalActions(writes: ConversationWrites, blocked: boolean): LocalActions {
  const [problems, setProblem] = useProblems();

  const send = useCallback(
    (mark: LocalMark) => {
      setProblem(mark.operationId, null);
      void writes.retry(mark.operationId).then((outcome) => {
        if (outcome.kind !== "not-kept") return;
        setProblem(mark.operationId, chatWords.notKept);
        AccessibilityInfo.announceForAccessibility(chatWords.notKept);
      });
    },
    [writes, setProblem],
  );

  // Discard asks first. It warns that a message may still send when a request may have reached the server unsettled,
  // and for a record that can't be read, whose state can't be known.
  const confirmDiscard = useCallback(
    (key: string, target: DiscardTarget, warn: boolean, title: string = chatWords.discardTitle) => {
      void (async () => {
        const chosen = await confirm({
          title,
          ...(warn ? { message: chatWords.maySend } : {}),
          confirm: chatWords.discard,
          destructive: true,
        });
        if (!chosen) return;
        setProblem(key, null);
        const outcome = await writes.discard(target);
        const text =
          outcome.kind === "failed"
            ? chatWords.discardFailed
            : outcome.kind === "may-send"
              ? chatWords.discardNotKept
              : null;
        if (text === null) return;
        setProblem(key, text);
        AccessibilityInfo.announceForAccessibility(text);
      })();
    },
    [writes, setProblem],
  );

  return useMemo(
    () => ({
      blocked,
      problems,
      send,
      discard: (mark: LocalMark) =>
        confirmDiscard(
          mark.operationId,
          { kind: "record", operationId: mark.operationId },
          maySend(mark),
        ),
      discardReaction: (mark: LocalMark) =>
        confirmDiscard(
          mark.operationId,
          { kind: "record", operationId: mark.operationId },
          maySend(mark),
          chatWords.discardReactionTitle,
        ),
      discardUnreadable: (handle: string) =>
        confirmDiscard(handle, { kind: "unreadable", handle }, true),
      copy: (mark: LocalMark) => copyText(mark.body),
    }),
    [blocked, problems, send, confirmDiscard],
  );
}

/** Reactions to a conversation's messages, and a failure to keep one, shown under its message. */
export interface ReactActions {
  /**
   * Taps `emoji` on a message the server has: it asks for the state the tap should end in, from what shows. A message
   * whose reaction isn't settled takes none.
   */
  react(message: Message, emoji: string): void;
  /** By message. */
  readonly problems: ReadonlyMap<string, string>;
}

/** `scope`: the account and workspace the reactions are in, or null while no workspace is open. */
export function useReact(
  writes: ConversationWrites,
  scope: (OutboxScope & { readonly workspaceId: string }) | null,
): ReactActions {
  const [problems, setProblem] = useProblems();
  const react = useCallback(
    (message: Message, emoji: string) => {
      const { threadId } = message;
      if (scope === null || !threadId || message.local || message.reactionsBusy) return;
      setProblem(message.id, null);
      void writes
        .react(
          scope,
          { messageId: message.id, threadId },
          emoji,
          nextReaction(message.reactions, emoji),
        )
        .then((outcome) => {
          if (outcome.kind !== "not-kept") return;
          setProblem(message.id, chatWords.reactionNotKept);
          AccessibilityInfo.announceForAccessibility(chatWords.reactionNotKept);
        });
    },
    [writes, scope, setProblem],
  );
  return useMemo(() => ({ react, problems }), [react, problems]);
}

/** A question's or poll's answers, as a message's card offers them. */
export interface AnswerActions {
  /** Every answer waits, as while a Sign out's delete is owed. */
  readonly blocked: boolean;
  /** A choice the outbox couldn't keep, by question, shown under its card. */
  readonly problems: ReadonlyMap<string, string>;
  /** Sends a poll's choice as its answer. */
  choose(message: Message, option: string): void;
  /** Starts a reply that answers a question without choices, in the composer. */
  answer(message: Message): void;
}

/** Sends a poll's choice through the conversation's writes, in `workspaceId`, or nothing while no workspace is open. */
export function useChoose(writes: ConversationWrites, workspaceId: string | null) {
  const [problems, setProblem] = useProblems();
  const choose = useCallback(
    (place: AnswerPlace, questionId: string, option: string) => {
      const write = answerWrite(place, questionId, option, option);
      if (workspaceId === null || write === null) return;
      setProblem(questionId, null);
      void writes.submit(workspaceId, write).then((outcome) => {
        if (outcome.kind !== "not-kept") return;
        setProblem(questionId, chatWords.notKept);
        AccessibilityInfo.announceForAccessibility(chatWords.notKept);
      });
    },
    [writes, workspaceId, setProblem],
  );
  return useMemo(() => ({ choose, problems }), [choose, problems]);
}
