import type { PhoneChatWake } from "@dohc/workspace-contracts/chat-wakes";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useAccount } from "../account/AccountProvider";
import type { WakeTarget } from "../server/chatWakes";
import type { WakeRetry, WakeView } from "./chatWakeState";
import { confirmTryElsewhere } from "./wakeRetryAlert";

const noSubscribe = () => () => undefined;
const NO_RETRIES: ReadonlyMap<string, WakeRetry> = new Map();

/**
 * A conversation's wakes in the open workspace, wanted only while `visible` and its content read shows it. `content`
 * is that read's value: a new one reads the wakes again, since the messages they cover may have changed. Returns the
 * last wakes read, or null before any, Try again of the read, and its lines' Try again. A line's Try again sends only
 * while the screen is visible and `writable`, as they are when each step runs.
 */
export function useChatWakes(
  target: WakeTarget | null,
  threads: ReadonlySet<string> | null,
  visible: boolean,
  content: unknown,
  writable = false,
): {
  readonly view: WakeView | null;
  retry(): void;
  readonly retries: ReadonlyMap<string, WakeRetry>;
  retryWake(wake: PhoneChatWake): void;
} {
  const { wakes, data } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  useEffect(() => {
    if (!wakes || workspaceId === null || target === null || threads === null || !visible) return;
    return wakes.want(workspaceId, target, threads);
  }, [wakes, workspaceId, target, threads, visible, content]);
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
  // What the screen shows now, for a step that runs after an alert or an answer.
  const now = useRef({ visible, writable });
  useEffect(() => {
    now.current = { visible, writable };
  }, [visible, writable]);
  const retryWake = useCallback(
    (wake: PhoneChatWake) => {
      if (!wakes || workspaceId === null || target === null) return;
      wakes.retry(workspaceId, target, wake, {
        allowed: () => now.current.visible && now.current.writable,
        confirm: confirmTryElsewhere,
      });
    },
    [wakes, workspaceId, target],
  );
  return { view, retry, retries, retryWake };
}
