// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunStateEvent } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useAgentRunActive } from "./agentRunState";

function stubDesktop() {
  const listeners = new Set<(event: AgentRunStateEvent) => void>();
  const reads = new Map<string, ReturnType<typeof deferred<AgentRunStateEvent>>>();
  const desktop = {
    readAgentRunState: vi.fn(({ workspaceId }: { workspaceId: string }) => {
      const read = deferred<AgentRunStateEvent>();
      reads.set(workspaceId, read);
      return read.promise;
    }),
    onAgentRunState: vi.fn((listener: (event: AgentRunStateEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  vi.stubGlobal("dohcDesktop", desktop);
  return {
    desktop,
    listeners,
    answer: async (event: AgentRunStateEvent) => {
      await act(async () => {
        reads.get(event.workspaceId)!.resolve(event);
        await Promise.resolve();
      });
    },
    push: (event: AgentRunStateEvent) => act(() => {
      for (const listener of [...listeners]) listener(event);
    }),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("reads once, then changes only on pushes, with no timer", async () => {
  vi.useFakeTimers();
  const { desktop, answer, push } = stubDesktop();
  const { result } = renderHook(() => useAgentRunActive("ws-a", vi.fn()));
  await answer({ workspaceId: "ws-a", revision: 0, active: false });
  expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);

  push({ workspaceId: "ws-a", revision: 1, active: true });
  expect(result.current).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  expect(result.current).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(desktop.readAgentRunState).toHaveBeenCalledExactlyOnceWith({ workspaceId: "ws-a" });
});

it("drops older revisions and other workspaces", async () => {
  const { answer, push } = stubDesktop();
  const { result } = renderHook(() => useAgentRunActive("ws-a", vi.fn()));
  // A push that lands before the first read's answer outranks it.
  push({ workspaceId: "ws-a", revision: 4, active: true });
  await answer({ workspaceId: "ws-a", revision: 3, active: false });
  expect(result.current).toBe(true);
  push({ workspaceId: "ws-a", revision: 4, active: false });
  push({ workspaceId: "ws-b", revision: 9, active: false });
  expect(result.current).toBe(true);
  push({ workspaceId: "ws-a", revision: 5, active: false });
  expect(result.current).toBe(false);
});

it("never paints a slow answer for the last workspace", async () => {
  const { listeners, answer } = stubDesktop();
  const { result, rerender } = renderHook(
    ({ workspaceId }: { workspaceId: string }) => useAgentRunActive(workspaceId, vi.fn()),
    { initialProps: { workspaceId: "ws-a" } },
  );
  rerender({ workspaceId: "ws-b" });
  await answer({ workspaceId: "ws-b", revision: 0, active: false });
  await answer({ workspaceId: "ws-a", revision: 7, active: true });
  expect(result.current).toBe(false);
  expect(listeners.size).toBe(1);
});

it("reports a failed read with a retry while the workspace shows, and not after", async () => {
  const { desktop, answer } = stubDesktop();
  const failure = new Error("main refused");
  desktop.readAgentRunState.mockRejectedValueOnce(failure);
  const onReadError = vi.fn();
  const { result, unmount } = renderHook(() => useAgentRunActive("ws-a", onReadError));
  await vi.waitFor(() => expect(onReadError).toHaveBeenCalledOnce());
  const [cause, retry] = onReadError.mock.calls[0] as [unknown, () => void];
  expect(cause).toBe(failure);
  act(() => retry());
  await answer({ workspaceId: "ws-a", revision: 2, active: true });
  expect(result.current).toBe(true);

  unmount();
  retry();
  expect(desktop.readAgentRunState).toHaveBeenCalledTimes(2);
  expect(onReadError).toHaveBeenCalledOnce();
});
