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
    listChatChannels: async () => ({ channels: [AGENT_DM, GROUP] }),
    listChannelThreads: async ({ channelId, lane }: { channelId: string; lane: "posts" | "chat" }) =>
      ({ threads: [WAKE_POST, GROUP_CHAT].filter((thread) => thread.channelId === channelId && thread.lane === lane) }),
  });
  const trust = vi.fn();
  const openChat = vi.fn();
  const mount = (workspaceId = "a", ready = true) => renderHook((props) => {
    const errors = useShellError(props.workspaceId);
    useChatDispatchNotices(props.workspaceId, props.ready, errors.reportShellFailure, errors.clearKind, trust, openChat);
    return errors;
  }, { initialProps: { workspaceId, ready } });
  return { store, register, dismiss, mount, listeners, removed, trust, openChat };
}
const AGENT_DM = {
  id: "agent-dm", name: "My agent", slug: "my-agent", kind: "agent" as const,
  createdAtMs: 1, updatedAtMs: 1, threadCount: 1, unreadCount: 0,
};
const WAKE_POST = {
  id: "wake", channelId: AGENT_DM.id, lane: "posts" as const, title: "", createdAtMs: 2, updatedAtMs: 2,
  messageCount: 11, lastReadSequence: 11, unreadCount: 0,
};
const GROUP = { ...AGENT_DM, id: "group", name: "Planning", slug: "planning", kind: "channel" as const };
const GROUP_CHAT = { ...WAKE_POST, id: "group-chat", channelId: GROUP.id, lane: "chat" as const };
const notice = (reason: ChatDispatchNotice["reason"], message: string = `Agent dispatch notice: ${reason}.`) => ({ reason, threadId: "thread", message });

it("replays background notices, replaces each reason, and clears dismissed rows across windows", async () => {
  const h = setup();
  h.store.report("a", notice("no-runner"));
  h.store.report("a", notice("budget-paused"));
  const first = h.mount();
  const second = h.mount();
  await act(async () => {});
  expect(first.result.current.shellErrors).toHaveLength(2);
  expect(first.result.current.shellErrors.find((item) => item.kind === "chat-no-runner"))
    .toMatchObject({ title: "No agent could take this request" });
  expect(first.result.current.shellErrors.find((item) => item.kind === "chat-no-runner")?.tone).toBeUndefined();
  const row = first.result.current.shellErrors[0]!;
  act(() => first.result.current.hideShellError(row.id));
  expect(first.result.current.shellErrors[0]?.seen).toBe(true);
  expect(h.dismiss).not.toHaveBeenCalled();
  act(() => h.store.report("a", notice("no-runner", "Dispatch is off.")));
  expect(first.result.current.shellErrors).toHaveLength(2);
  const replacement = first.result.current.shellErrors.find((item) => item.kind === "chat-no-runner")!;
  expect(replacement).toMatchObject({ message: "Dispatch is off.", seen: false });
  await act(async () => first.result.current.dismissShellError(replacement.id));
  expect(h.dismiss).toHaveBeenCalledOnce();
  expect(first.result.current.shellErrors).toHaveLength(1);
  expect(second.result.current.shellErrors).toHaveLength(1);
  first.unmount(); second.unmount();
  const reopened = h.mount();
  await act(async () => {});
  expect(reopened.result.current.shellErrors).toHaveLength(1);
});

it("waits for workspace admission and ignores late registration, events, and errors after switching", async () => {
  const h = setup();
  const pending = Promise.withResolvers<ChatDispatchNoticesEvent>();
  h.register.mockReturnValueOnce(pending.promise);
  const hook = h.mount("a", false);
  expect(h.register).not.toHaveBeenCalled();
  hook.rerender({ workspaceId: "a", ready: true });
  expect(h.register).toHaveBeenCalledWith({ workspaceId: "a" });
  act(() => h.store.report("a", notice("no-runner")));
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

it("clears forgotten workspace rows in every subscribed window", async () => {
  const h = setup();
  h.store.report("a", notice("no-runner"));
  const first = h.mount();
  const second = h.mount();
  await act(async () => {});
  act(() => h.store.clearWorkspace("a"));
  expect(first.result.current.shellErrors).toEqual([]);
  expect(second.result.current.shellErrors).toEqual([]);
});

it("shows a held request as a warning that opens the trust dialog, and takes it back once trusted", async () => {
  const h = setup();
  h.store.report("a", notice("restricted", "In Restricted Mode, dohc does not start agents in this workspace."));
  const hook = h.mount();
  await act(async () => {});
  const row = hook.result.current.shellErrors[0]!;
  expect(row).toMatchObject({ tone: "warning", kind: "chat-restricted", action: { label: "Trust workspace" } });
  act(() => row.action!.run());
  expect(h.trust).toHaveBeenCalledOnce();
  // The row stays while the person may still choose Stay in Restricted Mode.
  expect(hook.result.current.shellErrors).toHaveLength(1);
  act(() => h.store.clear("a", "restricted"));
  expect(hook.result.current.shellErrors).toEqual([]);
});

it("does not open the trust dialog from a row left by another workspace", async () => {
  const h = setup();
  h.store.report("a", notice("restricted"));
  const hook = h.mount();
  await act(async () => {});
  const row = hook.result.current.shellErrors[0]!;
  hook.rerender({ workspaceId: "b", ready: true });
  act(() => row.action!.run());
  expect(h.trust).not.toHaveBeenCalled();
});

it.each([
  ["a paused post", AGENT_DM, WAKE_POST, '"Nova"'],
  ["a group's paused conversation", GROUP, GROUP_CHAT, "#Planning"],
])("opens %s itself, where Resume is", async (_case, channel, thread, place) => {
  const h = setup();
  h.store.report("a", {
    reason: "budget-paused", threadId: thread.id, channelId: channel.id,
    message: `Your agent ran 10 times in 10 minutes in ${place}. Choose Resume there to continue.`,
  });
  const hook = h.mount();
  await act(async () => {});
  const [paused] = hook.result.current.shellErrors;
  expect(paused).toMatchObject({ title: "Agent replies paused", tone: "warning" });
  expect(paused?.action?.label).toBe("Open");
  await act(async () => paused?.action?.run());
  expect(h.openChat).toHaveBeenCalledWith({ level: "thread", channel, thread });
});
