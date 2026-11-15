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
import type { LocalMark } from "./types";

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

export function useLocalActions(writes: ConversationWrites, blocked: boolean): LocalActions {
  const [problems, setProblems] = useState<ReadonlyMap<string, string>>(new Map());
  const setProblem = useCallback((operationId: string, text: string | null) => {
    setProblems((previous) => {
      if (text === null && !previous.has(operationId)) return previous;
      const next = new Map(previous);
      if (text === null) next.delete(operationId);
      else next.set(operationId, text);
      return next;
    });
  }, []);

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
    (key: string, target: DiscardTarget, warn: boolean) => {
      void (async () => {
        const chosen = await confirm({
          title: chatWords.discardTitle,
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
      discardUnreadable: (handle: string) =>
        confirmDiscard(handle, { kind: "unreadable", handle }, true),
      copy: (mark: LocalMark) => copyText(mark.body),
    }),
    [blocked, problems, send, confirmDiscard],
  );
}
