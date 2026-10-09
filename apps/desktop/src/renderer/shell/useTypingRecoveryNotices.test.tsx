// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { TypingRecoveryFailure } from "../../workspaces/outageTypingRecovery";
import { INVALID_AUTHOR_MESSAGE, AUTHOR_REFUSED_MESSAGE, DRAWING_UNAVAILABLE_MESSAGE, CHECKPOINT_FAILURE_MESSAGE, IMPORT_FAILURE_MESSAGE } from "../../workspaces/typingRecoveryWords";
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
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}));
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
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}));
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
  const hook = renderHook(({workspaceId}) => useTypingRecoveryNotices({workspaceId, ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}), {initialProps: {workspaceId: "a"}});
  activity("b");
  expect(state.read).toHaveBeenCalledTimes(1);
  hook.rerender({workspaceId: "b"});
  await act(async () => {resolve([failure]);});
  expect(reportShellFailure).not.toHaveBeenCalled();
  hook.unmount();
  expect(state.listeners.size).toBe(0);
});

it("waits for workspace admission before reading recovery status", () => {
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: false, reportShellFailure: vi.fn(), clearKind: vi.fn(),clearIdentity:vi.fn()}));
  expect(state.read).not.toHaveBeenCalled();
  expect(state.listeners.size).toBe(0);
});

it("names a refused author and omits retry for a permanent refusal",async()=>{
 state.read.mockResolvedValue([{kind:"import",path:"note.md",detail:"remote-human-author",reason:"author-refused",retryable:false}]);const reportShellFailure=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity:vi.fn()}));await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledOnce());
 expect(reportShellFailure.mock.calls[0]![0]).toMatchObject({message:AUTHOR_REFUSED_MESSAGE});expect(reportShellFailure.mock.calls[0]![0]).not.toHaveProperty("retry");
});
it("warns truthfully that drawing outage edits cannot be kept",async()=>{
 state.read.mockResolvedValue([{kind:"checkpoint",path:"drawing.excalidraw",detail:"unsupported",reason:"drawing-unavailable",retryable:true}]);const reportShellFailure=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity:vi.fn()}));await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledOnce());expect(reportShellFailure.mock.calls[0]![0]).toMatchObject({message:DRAWING_UNAVAILABLE_MESSAGE,retry:expect.any(Function)});
});

it("offers each refused copy independently and removes only the copied record", async()=>{
 const one={kind:"import" as const,path:"note.md",detail:"invalid-author",reason:"invalid-author" as const,retryable:false,checkpointId:"one"};
 const two={...one,checkpointId:"two"};state.read.mockResolvedValue([one,two]);const reportShellFailure=vi.fn();const clearIdentity=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity}));
 await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledTimes(2));
 const row=reportShellFailure.mock.calls[0]![0];expect(row).toMatchObject({message:INVALID_AUTHOR_MESSAGE,identity:"typing-import:one",action:{label:"Copy your typing"}});expect(row.retry).toBeUndefined();
 state.read.mockResolvedValue([two]);act(()=>row.action.run());
 await waitFor(()=>expect(state.read).toHaveBeenCalledWith({workspaceId:"a",action:"copy",checkpointId:"one"}));
 await waitFor(()=>expect(clearIdentity).toHaveBeenCalledWith("typing-import:one"));
 expect(clearIdentity).not.toHaveBeenCalledWith("typing-import:two");
});
it("dismisses a refused checkpoint through main and ignores an action after a workspace switch",async()=>{
 state.read.mockResolvedValue([{kind:"import",path:"note.md",detail:"missing",checkpointId:"one",retryable:false}]);const reportShellFailure=vi.fn();
 const hook=renderHook(({workspaceId})=>useTypingRecoveryNotices({workspaceId,ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity:vi.fn()}),{initialProps:{workspaceId:"a"}});
 await waitFor(()=>expect(reportShellFailure).toHaveBeenCalled());const row=reportShellFailure.mock.calls[0]![0];act(()=>row.onDismiss());
 await waitFor(()=>expect(state.read).toHaveBeenCalledWith({workspaceId:"a",action:"dismiss",checkpointId:"one"}));hook.rerender({workspaceId:"b"});state.read.mockClear();act(()=>row.action.run());expect(state.read).not.toHaveBeenCalled();
});
