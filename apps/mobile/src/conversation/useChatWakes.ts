import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAccount } from "../account/AccountProvider";
import type { WakeTarget } from "../server/chatWakes";
import type { WakeView } from "./chatWakeState";

const noSubscribe = () => () => undefined;

/**
 * A conversation's wakes in the open workspace, wanted only while `visible` and its content read shows it. `content`
 * is that read's value: a new one reads the wakes again, since the messages they cover may have changed. Returns the
 * last wakes read, or null before any, and Try again.
 */
export function useChatWakes(
  target: WakeTarget | null,
  threads: ReadonlySet<string> | null,
  visible: boolean,
  content: unknown,
): { readonly view: WakeView | null; retry(): void } {
  const { wakes, data } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  useEffect(() => {
    if (!wakes || workspaceId === null || target === null || threads === null || !visible) return;
    return wakes.want(workspaceId, target, threads);
  }, [wakes, workspaceId, target, threads, visible, content]);
  const view = useSyncExternalStore(wakes?.subscribe ?? noSubscribe, () =>
    wakes && workspaceId !== null && target !== null ? wakes.view(workspaceId, target) : null,
  );
  const retry = useCallback(() => {
    if (wakes && workspaceId !== null) wakes.refresh(workspaceId);
  }, [wakes, workspaceId]);
  return { view, retry };
}
