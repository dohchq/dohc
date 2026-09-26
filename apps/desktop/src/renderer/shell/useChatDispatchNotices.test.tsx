// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatDispatchUnavailableEvent } from "../../ipc/bridgeContract";
import { useChatDispatchNotices } from "./useChatDispatchNotices";
import { useShellError } from "./useShellError";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reports unavailable dispatch through shell Notices, replacing the row and retaining it when the toast closes", () => {
  const listeners: Array<(event: ChatDispatchUnavailableEvent) => void> = [];
  const unsubscribe = vi.fn();
  vi.stubGlobal("dohcDesktop", {
    onChatDispatchUnavailable: (listener: (event: ChatDispatchUnavailableEvent) => void) => {
      listeners.push(listener);
      return unsubscribe;
    },
  });
  const { result, rerender, unmount } = renderHook(({ workspaceId }) => {
    const errors = useShellError(workspaceId);
    useChatDispatchNotices(workspaceId, errors.reportShellFailure);
    return errors;
  }, { initialProps: { workspaceId: "ws-a" } });
  const emit = (reason: ChatDispatchUnavailableEvent["reason"]) =>
    listeners[0]!({ workspaceId: "ws-a", reason });

  act(() => emit("disabled"));
  expect(result.current.shellErrors).toHaveLength(1);
  expect(result.current.shellErrors[0]).toMatchObject({
    kind: "chat-no-runner", seen: false, retry: null,
    message: "No agent could take this request. Agent dispatch is off. Set up agent dispatch in Settings → Agents & MCP.",
  });
  act(() => result.current.hideShellError(result.current.shellErrors[0]!.id));
  expect(result.current.shellErrors[0]?.seen).toBe(true);
  act(() => emit("unconfigured"));
  expect(result.current.shellErrors).toHaveLength(1);
  expect(result.current.shellErrors[0]).toMatchObject({
    seen: false,
    message: "No agent could take this request. No agent runner is configured. Set up agent dispatch in Settings → Agents & MCP.",
  });
  act(() => result.current.dismissShellError(result.current.shellErrors[0]!.id));
  expect(result.current.shellErrors).toEqual([]);

  rerender({ workspaceId: "ws-b" });
  expect(unsubscribe).toHaveBeenCalledOnce();
  act(() => {
    emit("disabled");
    listeners[1]!({ workspaceId: "ws-a", reason: "disabled" });
  });
  expect(result.current.shellErrors).toEqual([]);
  act(() => listeners[1]!({ workspaceId: "ws-b", reason: "disabled" }));
  expect(result.current.shellErrors).toHaveLength(1);
  unmount();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
});
