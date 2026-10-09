// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TypingRecoveryFailure } from "../../workspaces/outageTypingRecovery";
import { INVALID_AUTHOR_MESSAGE, AUTHOR_REFUSED_MESSAGE, DRAWING_UNAVAILABLE_MESSAGE, CHECKPOINT_FAILURE_MESSAGE, IMPORT_FAILURE_MESSAGE } from "../../workspaces/typingRecoveryWords";
import { useTypingRecoveryNotices } from "./useTypingRecoveryNotices";

const state = vi.hoisted(() => ({
  read: vi.fn<(input: {workspaceId: string; action: string}) => Promise<{failures: TypingRecoveryFailure[]; outcome?: "copied" | "discarded" | "missing"}>>(),
  listeners: new Set<(event: {workspaceId?: string}) => void>(),
}));
vi.mock("../bridge", () => ({bridge: () => ({
  typingRecovery: state.read,
  onWorkspaceActivity: (listener: (event: {workspaceId?: string}) => void) => {
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  },
})}));
afterEach(cleanup);
beforeEach(() => {state.read.mockReset().mockResolvedValue({failures: []}); state.listeners.clear();});
const failure: TypingRecoveryFailure = {kind: "checkpoint", path: "note.md", detail: "disk full"};
const activity = (workspaceId: string) => act(() => {for (const listener of state.listeners) listener({workspaceId});});

it("reports checkpoint failure on activity while engine status cannot answer", async () => {
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}));
  await waitFor(() => expect(clearKind).toHaveBeenCalledWith("typing-checkpoint"));
  state.read.mockResolvedValue({failures: [failure]});
  activity("a");
  await waitFor(() => expect(reportShellFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    message: CHECKPOINT_FAILURE_MESSAGE, kind: "typing-checkpoint", retry: expect.any(Function),
  })));
  expect(state.read).toHaveBeenLastCalledWith({workspaceId: "a", action: "read"});
});

it("keeps one Notice per failure kind and retries through the main recovery operation", async () => {
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  state.read.mockResolvedValue({failures: [failure, {...failure, path: "other.md"}, {...failure, kind: "import"}]});
  renderHook(() => useTypingRecoveryNotices({workspaceId: "a", ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}));
  await waitFor(() => expect(reportShellFailure).toHaveBeenCalledTimes(2));
  expect(reportShellFailure.mock.calls[1]![0].message).toBe(IMPORT_FAILURE_MESSAGE);
  state.read.mockResolvedValue({failures: []});
  act(() => {reportShellFailure.mock.calls[0]![0].retry();});
  await waitFor(() => expect(state.read).toHaveBeenLastCalledWith({workspaceId: "a", action: "retry"}));
  await waitFor(() => expect(clearKind).toHaveBeenCalledWith("typing-import"));
});

it("ignores another workspace's activity and a late reply from the previous workspace", async () => {
  let resolve!: (reply: {failures: TypingRecoveryFailure[]}) => void;
  state.read.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
  const reportShellFailure = vi.fn();
  const clearKind = vi.fn();
  const hook = renderHook(({workspaceId}) => useTypingRecoveryNotices({workspaceId, ready: true, reportShellFailure, clearKind, clearIdentity: vi.fn()}), {initialProps: {workspaceId: "a"}});
  activity("b");
  expect(state.read).toHaveBeenCalledTimes(1);
  hook.rerender({workspaceId: "b"});
  await act(async () => {resolve({failures: [failure]});});
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
 state.read.mockResolvedValue({failures:[{kind:"import",path:"note.md",detail:"remote-human-author",reason:"author-refused",retryable:false}]});const reportShellFailure=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity:vi.fn()}));await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledOnce());
 expect(reportShellFailure.mock.calls[0]![0]).toMatchObject({message:AUTHOR_REFUSED_MESSAGE});expect(reportShellFailure.mock.calls[0]![0]).not.toHaveProperty("retry");
});
it("warns truthfully that drawing outage edits cannot be kept",async()=>{
 state.read.mockResolvedValue({failures:[{kind:"checkpoint",path:"drawing.excalidraw",detail:"Error: dohc cannot keep drawing changes while it reconnects.",reason:"drawing-unavailable",retryable:true}]});const reportShellFailure=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity:vi.fn()}));await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledOnce());expect(reportShellFailure.mock.calls[0]![0]).toMatchObject({message:DRAWING_UNAVAILABLE_MESSAGE,retry:expect.any(Function),details:[["File","drawing.excalidraw"]]});
});

it("copies each refused record without clearing its row or discarding it", async()=>{
 const one={kind:"import" as const,path:"note.md",detail:"invalid-author",reason:"invalid-author" as const,retryable:false,checkpointId:"one"};
 const two={...one,checkpointId:"two"};state.read.mockResolvedValue({failures:[one,two]});const reportShellFailure=vi.fn();const clearIdentity=vi.fn();
 renderHook(()=>useTypingRecoveryNotices({workspaceId:"a",ready:true,reportShellFailure,clearKind:vi.fn(),clearIdentity}));
 await waitFor(()=>expect(reportShellFailure).toHaveBeenCalledTimes(2));
 const row=reportShellFailure.mock.calls[0]![0];expect(row).toMatchObject({message:INVALID_AUTHOR_MESSAGE,identity:"typing-import:one",action:{label:"Copy your typing"}});expect(row.retry).toBeUndefined();
 act(()=>row.action.run());
 await waitFor(()=>expect(state.read).toHaveBeenCalledWith({workspaceId:"a",action:"copy",checkpointId:"one"}));
 expect(clearIdentity).not.toHaveBeenCalled();
 expect(state.read.mock.calls.some(([input])=>input.action === "discard")).toBe(false);
});
it("dismisses only the row and shows the kept copy again on a later mount",async()=>{
 const input={workspaceId:"a",ready:true,reportShellFailure:vi.fn(),clearKind:vi.fn(),clearIdentity:vi.fn()};
 state.read.mockResolvedValue({failures:[{kind:"import",path:"note.md",detail:"missing",checkpointId:"one",retryable:false}]});
 const hook=renderHook(()=>useTypingRecoveryNotices(input));
 await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledOnce());const row=input.reportShellFailure.mock.calls[0]![0];state.read.mockClear();act(()=>row.onDismiss());
 expect(state.read).not.toHaveBeenCalled();activity("a");await waitFor(()=>expect(state.read).toHaveBeenCalledOnce());expect(input.reportShellFailure).toHaveBeenCalledOnce();
 hook.unmount();renderHook(()=>useTypingRecoveryNotices(input));await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledTimes(2));
});

const refused: TypingRecoveryFailure = {kind:"import",path:"note.md",detail:"invalid-author",reason:"invalid-author",retryable:false,checkpointId:"one"};
function Harness(props: Parameters<typeof useTypingRecoveryNotices>[0]) {return useTypingRecoveryNotices(props);}
const options=()=>({workspaceId:"a",ready:true,reportShellFailure:vi.fn(),clearKind:vi.fn(),clearIdentity:vi.fn()});
it("asks once before Discard, keeps the copy on Cancel, and cancels on a workspace switch",async()=>{
 const input=options();state.read.mockResolvedValue({failures:[refused]});const user=userEvent.setup();const view=render(<Harness {...input}/>);
 await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledOnce());const ask=input.reportShellFailure.mock.calls[0]![0].action.additional[0].run;
 act(ask);expect(screen.getByRole("dialog").textContent).toContain("This cannot be undone.");expect(state.read.mock.calls.some(([call])=>call.action === "discard")).toBe(false);
 await user.click(screen.getByTestId("typing-discard-cancel"));expect(screen.queryByRole("dialog")).toBeNull();
 act(ask);await user.click(screen.getByTestId("typing-discard-confirm"));await waitFor(()=>expect(state.read).toHaveBeenCalledWith({workspaceId:"a",action:"discard",checkpointId:"one"}));
 act(ask);view.rerender(<Harness {...input} workspaceId="b"/>);expect(screen.queryByRole("dialog")).toBeNull();state.read.mockClear();act(ask);expect(state.read).not.toHaveBeenCalled();expect(screen.queryByRole("dialog")).toBeNull();
});
it("reports an already-missing copy truthfully and clears its old row",async()=>{
 const input=options();state.read.mockResolvedValue({failures:[refused]});renderHook(()=>useTypingRecoveryNotices(input));await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledOnce());const row=input.reportShellFailure.mock.calls[0]![0];
 state.read.mockResolvedValue({failures:[],outcome:"missing"});act(()=>row.action.run());await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledWith({message:"This kept copy is no longer on this computer."}));expect(input.clearIdentity).toHaveBeenCalledWith("typing-import:one");
});
it.each(["copy","discard"] as const)("reports a failed %s with the matching words",async action=>{
 const input=options();state.read.mockResolvedValue({failures:[refused]});const user=userEvent.setup();render(<Harness {...input}/>);await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledOnce());const row=input.reportShellFailure.mock.calls[0]![0];state.read.mockRejectedValueOnce(Error("action failed"));
 if(action === "copy")act(()=>row.action.run());else{act(()=>row.action.additional[0].run());await user.click(screen.getByTestId("typing-discard-confirm"));}
 await waitFor(()=>expect(input.reportShellFailure).toHaveBeenCalledWith(expect.objectContaining({message:`dohc could not ${action} your typing.`})));
});
