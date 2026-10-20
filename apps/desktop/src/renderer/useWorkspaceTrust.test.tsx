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
    expect(hook.result.current.trusted).toBe(true);
    await act(async () => { await hook.result.current.restrict(); });
    await waitFor(() => expect(hook.result.current.trusted).toBe(false));
  });

  it("reads nothing while disabled, as for a shared view", () => {
    const hook = renderHook(() => useWorkspaceTrust("a", false));
    expect(bridgeMock.readWorkspaceTrust).not.toHaveBeenCalled();
    expect(hook.result.current.trusted).toBeNull();
  });
});
