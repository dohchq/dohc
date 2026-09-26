// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatDispatchNotice, ChatDispatchNoticesEvent } from "../../ipc/bridgeContract";
import { createChatDispatchNotices } from "../../agents/chatDispatchNotices";
import { useChatDispatchNotices } from "./useChatDispatchNotices";
import { useShellError } from "./useShellError";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const listeners = new Set<(event: ChatDispatchNoticesEvent) => void>();
  const removed: Array<(event: ChatDispatchNoticesEvent) => void> = [];
  const store = createChatDispatchNotices((event) => { for (const listener of listeners) listener(event); });
  const register = vi.fn(async ({ workspaceId }: { workspaceId: string }) => store.register(workspaceId));
  const dismiss = vi.fn(async ({ workspaceId, id }: { workspaceId: string; id: string }) => store.dismiss(workspaceId, id));
  vi.stubGlobal("dohcDesktop", {
    onChatDispatchNotices: (listener: (event: ChatDispatchNoticesEvent) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); removed.push(listener); };
    },
    registerChatDispatchNotices: register, dismissChatDispatchNotice: dismiss,
  });
  const mount = (workspaceId = "a", ready = true) => renderHook((props) => {
    const errors = useShellError(props.workspaceId);
    useChatDispatchNotices(props.workspaceId, props.ready, errors.reportShellFailure, errors.clearKind);
    return errors;
  }, { initialProps: { workspaceId, ready } });
  return { store, register, dismiss, mount, listeners, removed };
}
const notice = (reason: ChatDispatchNotice["reason"], message: string = `Agent dispatch notice: ${reason}.`) => ({ reason, threadId: "thread", message });

it("replays background notices, replaces each reason, and clears dismissed rows across windows", async () => {
  const h = setup();
  h.store.report("a", notice("no-runner"));
  h.store.report("a", { ...notice("run-failed"), runId: "run", logPath: "C:/logs/run.log" });
  h.store.report("a", notice("budget-paused"));
  const first = h.mount();
  const second = h.mount();
  await act(async () => {});
  expect(first.result.current.shellErrors).toHaveLength(3);
  expect(first.result.current.shellErrors[1]?.details).toContainEqual(["Log", "C:/logs/run.log"]);
  const row = first.result.current.shellErrors[0]!;
  act(() => first.result.current.hideShellError(row.id));
  expect(first.result.current.shellErrors[0]?.seen).toBe(true);
  expect(h.dismiss).not.toHaveBeenCalled();
  act(() => h.store.report("a", notice("no-runner", "Dispatch is off.")));
  expect(first.result.current.shellErrors).toHaveLength(3);
  const replacement = first.result.current.shellErrors.find((item) => item.kind === "chat-no-runner")!;
  expect(replacement).toMatchObject({ message: "Dispatch is off.", seen: false });
  await act(async () => first.result.current.dismissShellError(replacement.id));
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(first.result.current.shellErrors).toHaveLength(2);
  expect(second.result.current.shellErrors).toHaveLength(2);
  first.unmount(); second.unmount();
  const reopened = h.mount();
  await act(async () => {});
  expect(reopened.result.current.shellErrors).toHaveLength(2);
});

it("waits for workspace admission and ignores late registration, events, and errors after switching", async () => {
  const h = setup();
  const pending = Promise.withResolvers<ChatDispatchNoticesEvent>();
  h.register.mockReturnValueOnce(pending.promise);
  const hook = h.mount("a", false);
  expect(h.register).not.toHaveBeenCalled();
  hook.rerender({ workspaceId: "a", ready: true });
  expect(h.register).toHaveBeenCalledWith({ workspaceId: "a" });
  act(() => h.store.report("a", notice("run-failed")));
  const old = h.store.register("a");
  hook.rerender({ workspaceId: "b", ready: true });
  await act(async () => { pending.resolve(old); });
  act(() => { h.removed[0]!(old); for (const listener of h.listeners) listener(old); });
  expect(hook.result.current.shellErrors).toEqual([]);
  act(() => h.store.report("b", notice("budget-paused")));
  expect(hook.result.current.shellErrors).toHaveLength(1);
  hook.unmount();
  act(() => h.removed.at(-1)!(h.store.register("b")));
});

it("does not let a late registration restore a replaced or dismissed notice", async () => {
  const h = setup();
  h.store.report("a", notice("no-runner"));
  const stale = h.store.register("a");
  const pending = Promise.withResolvers<ChatDispatchNoticesEvent>();
  h.register.mockReturnValueOnce(pending.promise);
  const hook = h.mount();
  act(() => h.store.report("a", notice("no-runner", "New notice.")));
  await act(async () => hook.result.current.dismissShellError(hook.result.current.shellErrors[0]!.id));
  await act(async () => pending.resolve(stale));
  expect(hook.result.current.shellErrors).toEqual([]);
});

it("does not show registration errors from an abandoned workspace", async () => {
  const h = setup();
  const pending = Promise.withResolvers<ChatDispatchNoticesEvent>();
  h.register.mockReturnValueOnce(pending.promise);
  const hook = h.mount();
  hook.rerender({ workspaceId: "b", ready: true });
  await act(async () => pending.reject(new Error("Old workspace closed")));
  expect(hook.result.current.shellErrors).toEqual([]);
});
