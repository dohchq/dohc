// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudStatusResult } from "../../ipc/bridgeContract";
import { deferred } from "../../testing/deferred";
import { useCloudPresence } from "./useCloudPresence";

const bridgeMock = {
  cloudStatus: vi.fn<(payload: { workspaceId: string }) => Promise<CloudStatusResult>>(),
  onCloudSessionChanged: vi.fn<(listener: () => void) => () => void>(),
};
// What main says while the engine is still taking in a new workspace's files.
const stillUpdating = () => new Error(
  "Error invoking remote method 'desktop:cloud-status': DaemonRefusalError [OVERLOADED]: Workspace is still updating. Try again.",
);
const onStatusUnavailable = vi.fn<(retry: () => void) => void>();

vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

beforeEach(() => {
  vi.resetAllMocks();
  bridgeMock.cloudStatus.mockResolvedValue({ connected: false });
  bridgeMock.onCloudSessionChanged.mockReturnValue(() => undefined);
});

afterEach(cleanup);

// The capability a surface reads off this snapshot decides whether it offers
// an action main can run. It must answer for the workspace on screen.
it("answers for the workspace on screen, not the one the window just left", async () => {
  const pending = deferred<CloudStatusResult>();
  bridgeMock.cloudStatus.mockImplementation(async (payload) =>
    payload.workspaceId === "ws-synced"
      ? { connected: true, workspaceSynced: true }
      : await pending.promise,
  );

  const { result, rerender } = renderHook(
    ({ workspaceId }) => useCloudPresence(workspaceId, onStatusUnavailable, true),
    { initialProps: { workspaceId: "ws-synced" } },
  );
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));

  // The next workspace has not answered yet, and the previous answer is not
  // an answer about it — not even for the first render after the switch.
  rerender({ workspaceId: "ws-local" });
  expect(result.current.workspaceSynced).toBe(false);
});

it("drops a status that arrives after the workspace changed", async () => {
  const stale = deferred<CloudStatusResult>();
  bridgeMock.cloudStatus.mockImplementation(async (payload) =>
    payload.workspaceId === "ws-a"
      ? await stale.promise
      : { connected: true, workspaceSynced: false },
  );

  const { result, rerender } = renderHook(
    ({ workspaceId }) => useCloudPresence(workspaceId, onStatusUnavailable, true),
    { initialProps: { workspaceId: "ws-a" } },
  );
  rerender({ workspaceId: "ws-b" });
  await act(async () => {
    stale.resolve({ connected: true, workspaceSynced: true });
    await stale.promise;
  });

  expect(result.current.workspaceSynced).toBe(false);
});

// Turning sync on is a change this hook only learns by asking again, which is
// what the connection dialog does when it closes.
it("reports sync for this workspace after a refresh", async () => {
  bridgeMock.cloudStatus
    .mockResolvedValueOnce({ connected: true, workspaceSynced: false })
    .mockResolvedValue({ connected: true, workspaceSynced: true });

  const { result } = renderHook(() => useCloudPresence("ws-1", onStatusUnavailable, true));
  await waitFor(() => expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(1));
  expect(result.current.workspaceSynced).toBe(false);

  await act(async () => {
    result.current.refreshCloudStatus();
  });
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));
});

it("reports a failed read and retries the current workspace", async () => {
  bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("engine unavailable"))
    .mockResolvedValue({ connected: true, workspaceSynced: true });
  const { result } = renderHook(() => useCloudPresence("ws-1", onStatusUnavailable, true));
  await waitFor(() => expect(onStatusUnavailable).toHaveBeenCalledTimes(1));
  expect(result.current.workspaceSynced).toBe(false);
  await act(async () => onStatusUnavailable.mock.calls[0]![0]());
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));
  expect(bridgeMock.cloudStatus).toHaveBeenNthCalledWith(2, { workspaceId: "ws-1" });
});

// Busy is not broken: a workspace still taking in files keeps what the
// person saw, says nothing, and is read again on the next activity.
it("says nothing while the workspace is still updating, then reads again", async () => {
  bridgeMock.cloudStatus
    .mockResolvedValueOnce({ connected: true, workspaceSynced: true })
    .mockRejectedValueOnce(stillUpdating())
    .mockResolvedValue({ connected: true, workspaceSynced: false });
  const { result } = renderHook(() => useCloudPresence("ws-1", onStatusUnavailable, true));
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));

  await act(async () => result.current.refreshCloudStatus());
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  expect(onStatusUnavailable).not.toHaveBeenCalled();
  expect(result.current.workspaceSynced).toBe(true);
  expect(result.current.cloudStatusUnreadable).toBe(false);

  await act(async () => result.current.readCloudStatusAgainIfBusy());
  await waitFor(() => expect(result.current.workspaceSynced).toBe(false));
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(3);

  // Once answered, activity does not read the status again.
  await act(async () => result.current.readCloudStatusAgainIfBusy());
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(3);
  expect(onStatusUnavailable).not.toHaveBeenCalled();
});

it("keeps a still-updating answer workspace A asked for out of workspace B", async () => {
  const slow = deferred<CloudStatusResult>();
  bridgeMock.cloudStatus.mockImplementation(async (payload) =>
    payload.workspaceId === "ws-a"
      ? await slow.promise
      : { connected: true, workspaceSynced: true },
  );
  const { result, rerender } = renderHook(
    ({ workspaceId }) => useCloudPresence(workspaceId, onStatusUnavailable, true),
    { initialProps: { workspaceId: "ws-a" } },
  );
  rerender({ workspaceId: "ws-b" });
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));
  await act(async () => slow.reject(stillUpdating()));

  await act(async () => result.current.readCloudStatusAgainIfBusy());
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(2);
  expect(result.current.workspaceSynced).toBe(true);
  expect(onStatusUnavailable).not.toHaveBeenCalled();
});

// About tells a status still being read from one that could not be read.
it("says the status could not be read until a read answers, for this workspace only", async () => {
  bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("engine unavailable"))
    .mockResolvedValue({ connected: true, workspaceSynced: true });
  const { result, rerender } = renderHook(
    ({ workspaceId }) => useCloudPresence(workspaceId, onStatusUnavailable, true),
    { initialProps: { workspaceId: "ws-1" } },
  );
  expect(result.current.cloudStatusUnreadable).toBe(false);
  await waitFor(() => expect(result.current.cloudStatusUnreadable).toBe(true));
  await act(async () => onStatusUnavailable.mock.calls[0]![0]());
  await waitFor(() => expect(result.current.cloudStatus).not.toBeNull());
  expect(result.current.cloudStatusUnreadable).toBe(false);
  rerender({ workspaceId: "ws-2" });
  expect(result.current.cloudStatusUnreadable).toBe(false);
});

it("does not report a confirmed unsynced workspace as unavailable", async () => {
  bridgeMock.cloudStatus.mockResolvedValue({ connected: true, workspaceSynced: false });
  renderHook(() => useCloudPresence("ws-1", onStatusUnavailable, true));
  await act(async () => {});
  expect(onStatusUnavailable).not.toHaveBeenCalled();
});

it("ignores stale failures and retires retry actions on workspace switch", async () => {
  const pending = deferred<CloudStatusResult>();
  bridgeMock.cloudStatus.mockRejectedValueOnce(new Error("old failure"))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue({ connected: true, workspaceSynced: true });
  const { rerender } = renderHook(
    ({ workspaceId }) => useCloudPresence(workspaceId, onStatusUnavailable, true),
    { initialProps: { workspaceId: "ws-a" } },
  );
  await waitFor(() => expect(onStatusUnavailable).toHaveBeenCalledTimes(1));
  const retry = onStatusUnavailable.mock.calls[0]![0];
  rerender({ workspaceId: "ws-b" });
  rerender({ workspaceId: "ws-c" });
  await act(async () => pending.reject(new Error("late failure")));
  retry();
  expect(onStatusUnavailable).toHaveBeenCalledTimes(1);
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(3);
});

it("retires a failure's retry after unmount", async () => {
  bridgeMock.cloudStatus.mockRejectedValue(new Error("offline"));
  const { unmount } = renderHook(() => useCloudPresence("ws-1", onStatusUnavailable, true));
  await waitFor(() => expect(onStatusUnavailable).toHaveBeenCalledTimes(1));
  const retry = onStatusUnavailable.mock.calls[0]![0];
  unmount();
  retry();
  expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(1);
});

it("does not read cloud status before workspace admission", async () => {
  const { result, rerender } = renderHook(
    ({ ready }) => useCloudPresence("workspace", onStatusUnavailable, ready),
    { initialProps: { ready: false } },
  );
  expect(bridgeMock.cloudStatus).not.toHaveBeenCalled();
  result.current.refreshCloudStatus();
  expect(bridgeMock.cloudStatus).not.toHaveBeenCalled();
  await act(async () => { rerender({ ready: true }); });
  expect(bridgeMock.cloudStatus).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace" });
});
