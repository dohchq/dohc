// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TypingRecoveryFailure } from "../../workspaces/outageTypingRecovery";
import { CHECKPOINT_FAILURE_MESSAGE, IMPORT_FAILURE_MESSAGE } from "../../workspaces/typingRecoveryWords";
import { useTypingRecoveryNotices } from "./useTypingRecoveryNotices";

const state = vi.hoisted(() => ({
  read: vi.fn<(input: {workspaceId: string; action: string}) => Promise<TypingRecoveryFailure[]>>(),
  listeners: new Set<(event: {workspaceId?: string}) => void>(),
}));
vi.mock("../bridge", () => ({bridge: () => ({
  typingRecovery: state.read,
  onWorkspaceActivity: (listener: (event: {workspaceId?: string}) => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
})}));
beforeEach(() => {state.read.mockReset().mockResolvedValue([]); state.listeners.clear();});
const failure: TypingRecoveryFailure = {kind: "checkpoint", path: "note.md", detail: "disk full"};
const activity = (workspaceId: string) => act(() => {for (const listener of state.listeners) listener({workspaceId});});

it("reports checkpoint failure on activity while engine status cannot answer", async () => {
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind}));
  await waitFor(() => expect(clearKind).toHaveBeenCalledWith("typing-checkpoint"));
  state.read.mockResolvedValue([failure]);
  activity("a");
  await waitFor(() => expect(reportShellFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: CHECKPOINT_FAILURE_MESSAGE, kind: "typing-checkpoint", retry: expect.any(Function),
  })));
  expect(state.read).toHaveBeenLastCalledWith({workspaceId: "a", action: "read"});
});

it("keeps one Notice per failure kind and retries through the main recovery operation", async () => {
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  state.read.mockResolvedValue([failure, {...failure, path: "other.md"}, {...failure, kind: "import"}]);
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind}));
  await waitFor(() => expect(reportShellFailure).toHaveBeenCalledTimes(2));
  expect(reportShellFailure.mock.calls[1]![0].message).toBe(IMPORT_FAILURE_MESSAGE);
  state.read.mockResolvedValue([]);
  act(() => {reportShellFailure.mock.calls[0]![0].retry();});
  await waitFor(() => expect(state.read).toHaveBeenLastCalledWith({workspaceId: "a", action: "retry"}));
  await waitFor(() => expect(clearKind).toHaveBeenCalledWith("typing-import"));
});

it("ignores another workspace's activity and a late reply from the previous workspace", async () => {
  let resolve!: (rows: TypingRecoveryFailure[]) => void;
  state.read.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  const hook = renderHook(({workspaceId}) => useTypingRecoveryNotices({workspaceId, ready: true, reportShellFailure, clearKind}), {initialProps: {workspaceId: "a"}});
  activity("b");
  expect(state.read).toHaveBeenCalledTimes(1);
  hook.rerender({workspaceId: "b"});
  await act(async () => {resolve([failure]);});
  expect(reportShellFailure).not.toHaveBeenCalled();
  hook.unmount();
  expect(state.listeners.size).toBe(0);
});

it("waits for workspace admission before reading recovery status", () => {
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: false, reportShellFailure: vi.fn(), clearKind: vi.fn()}));
  expect(state.read).not.toHaveBeenCalled();
  expect(state.listeners.size).toBe(0);
});
