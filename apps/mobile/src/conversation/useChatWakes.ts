import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAccount } from "../account/AccountProvider";
import type { WakeTarget } from "../server/chatWakes";
import { screenWant, type WakeRetry, type WakeView } from "./chatWakeState";
import { useShowing } from "./useVisible";
import { confirmTryElsewhere } from "./wakeRetryAlert";

const noSubscribe = () => () => undefined;
const NO_RETRIES: ReadonlyMap<string, WakeRetry> = new Map();

/**
 * A conversation's wakes in the open workspace, wanted only while `visible` and its content read shows it. `content`
 * is that read's value: a new one reads the wakes again, since the messages they cover may have changed, and keeps a
 * Try again on its way. Returns the last wakes read, or null before any, Try again of the read, and its lines' Try
 * again. `writable` says, when called, whether writes are unblocked for the screen's activation; a line's Try again
 * acts only while it does and the screen still shows the conversation it was pressed in.
 */
export function useChatWakes(
  target: WakeTarget | null,
  threads: ReadonlySet<string> | null,
  visible: boolean,
  content: unknown,
  writable: (() => boolean) | null = null,
): {
  readonly view: WakeView | null;
  retry(): void;
  readonly retries: ReadonlyMap<string, WakeRetry>;
  retryWake(wake: PhoneChatWake): void;
} {
  const { wakes, data } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  const joined = data?.joined === true;
  const [held] = useState(screenWant);
  useEffect(() => {
    if (!wakes || workspaceId === null || joined || target === null || threads === null || !visible)
      held.release();
    else held.want(wakes, workspaceId, target, threads);
  }, [held, wakes, workspaceId, joined, target, threads, visible, content]);
  useEffect(() => () => held.release(), [held]);
  const view = useSyncExternalStore(wakes?.subscribe ?? noSubscribe, () =>
    wakes && workspaceId !== null && target !== null ? wakes.view(workspaceId, target) : null,
  );
  const retries = useSyncExternalStore(wakes?.subscribe ?? noSubscribe, () =>
    wakes && workspaceId !== null && target !== null
      ? wakes.retries(workspaceId, target)
      : NO_RETRIES,
  );
  const retry = useCallback(() => {
    if (wakes && workspaceId !== null) wakes.refresh(workspaceId);
  }, [wakes, workspaceId]);
  const showing = useShowing(visible);
  const retryWake = useCallback(
    (wake: PhoneChatWake) => {
      if (!wakes || workspaceId === null || target === null || !writable) return;
      const shown = showing();
      void wakes.retry(workspaceId, target, wake, {
        allowed: () => shown() && writable(),
        confirm: confirmTryElsewhere,
      });
    },
    [wakes, workspaceId, target, writable, showing],
  );
  return { view, retry, retries, retryWake };
}
