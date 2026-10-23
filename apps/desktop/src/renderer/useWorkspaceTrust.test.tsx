// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTrustAnswer } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { useWorkspaceTrust } from "./useWorkspaceTrust";

const reads = new Map<string, ReturnType<typeof deferred<WorkspaceTrustAnswer>>>();
const listeners = new Set<(event: WorkspaceTrustAnswer) => void>();
const bridgeMock = {
  readWorkspaceTrust: vi.fn(({ workspaceId }: { workspaceId: string }) => {
    const read = deferred<WorkspaceTrustAnswer>();
    reads.set(workspaceId, read);
    return read.promise;
  }),
  requestWorkspaceTrust: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: true })),
  restrictWorkspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({ workspaceId, trusted: false })),
  onWorkspaceTrustChanged: vi.fn((listener: (event: WorkspaceTrustAnswer) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
};

beforeEach(() => { vi.stubGlobal("dohcDesktop", bridgeMock); });
afterEach(() => {
  cleanup();
  reads.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("useWorkspaceTrust", () => {
  it("never shows a slow answer for workspace A once the window shows workspace B", async () => {
    const hook = renderHook(({ id }) => useWorkspaceTrust(id, true), { initialProps: { id: "a" } });
    hook.rerender({ id: "b" });
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: true }); });
    expect(hook.result.current.trusted).toBeNull();
    await act(async () => { reads.get("b")!.resolve({ workspaceId: "b", trusted: false }); });
    expect(hook.result.current.trusted).toBe(false);
  });

  it("lets a change main announces win over an older read", async () => {
    const hook = renderHook(() => useWorkspaceTrust("a", true));
    act(() => { for (const listener of listeners) listener({ workspaceId: "a", trusted: true }); });
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: false }); });
    expect(hook.result.current.trusted).toBe(true);
  });

  it("asks main, and follows its answer", async () => {
    const hook = renderHook(() => useWorkspaceTrust("a", true));
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: false }); });
    await act(async () => { await hook.result.current.requestTrust(); });
    expect(bridgeMock.requestWorkspaceTrust).toHaveBeenCalledWith({ workspaceId: "a" });
    // After a send, the request says it is automatic, so main opens it once.
    await act(async () => { await hook.result.current.requestTrust(true); });
    expect(bridgeMock.requestWorkspaceTrust).toHaveBeenLastCalledWith({ workspaceId: "a", automatic: true });
    expect(hook.result.current.trusted).toBe(true);
    await act(async () => { await hook.result.current.restrict(); });
    await waitFor(() => expect(hook.result.current.trusted).toBe(false));
  });

  it("drops a slow Trust workspace reply for A once the window shows B, and is not busy for B", async () => {
    const reply = deferred<WorkspaceTrustAnswer>();
    bridgeMock.requestWorkspaceTrust.mockImplementationOnce(() => reply.promise);
    const hook = renderHook(({ id }) => useWorkspaceTrust(id, true), { initialProps: { id: "a" } });
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: false }); });
    let asked!: Promise<boolean>;
    act(() => { asked = hook.result.current.requestTrust(); });
    expect(hook.result.current.asking).toBe(true);
    hook.rerender({ id: "b" });
    expect(hook.result.current.asking).toBe(false);
    await act(async () => { reads.get("b")!.resolve({ workspaceId: "b", trusted: false }); });
    await act(async () => { reply.resolve({ workspaceId: "a", trusted: true }); await asked; });
    expect(hook.result.current.trusted).toBe(false);
    expect(hook.result.current.asking).toBe(false);
  });

  it("keeps a change main announced over an older action's reply", async () => {
    const reply = deferred<WorkspaceTrustAnswer>();
    bridgeMock.restrictWorkspace.mockImplementationOnce(() => reply.promise);
    const hook = renderHook(() => useWorkspaceTrust("a", true));
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: true }); });
    let restricting!: Promise<void>;
    act(() => { restricting = hook.result.current.restrict(); });
    // The person trusted the workspace again from another window.
    act(() => { for (const listener of listeners) listener({ workspaceId: "a", trusted: true }); });
    await act(async () => { reply.resolve({ workspaceId: "a", trusted: false }); await restricting; });
    expect(hook.result.current.trusted).toBe(true);
  });

  it("reports a failed read with a way to read again", async () => {
    const onReadError = vi.fn();
    const hook = renderHook(() => useWorkspaceTrust("a", true, onReadError));
    await act(async () => { reads.get("a")!.reject(new Error("busy")); });
    expect(hook.result.current).toMatchObject({ trusted: null, readFailed: true });
    expect(onReadError).toHaveBeenCalledWith(expect.any(Error), expect.any(Function));
    act(() => { onReadError.mock.calls[0]![1](); });
    await act(async () => { reads.get("a")!.resolve({ workspaceId: "a", trusted: true }); });
    expect(hook.result.current).toMatchObject({ trusted: true, readFailed: false });
  });

  it("reads nothing while disabled, as for a shared view", () => {
    const hook = renderHook(() => useWorkspaceTrust("a", false));
    expect(bridgeMock.readWorkspaceTrust).not.toHaveBeenCalled();
    expect(hook.result.current.trusted).toBeNull();
  });
});
