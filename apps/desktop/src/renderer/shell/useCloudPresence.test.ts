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
    ({ workspaceId }) => useCloudPresence(workspaceId),
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
    ({ workspaceId }) => useCloudPresence(workspaceId),
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

  const { result } = renderHook(() => useCloudPresence("ws-1"));
  await waitFor(() => expect(bridgeMock.cloudStatus).toHaveBeenCalledTimes(1));
  expect(result.current.workspaceSynced).toBe(false);

  await act(async () => {
    result.current.refreshCloudStatus();
  });
  await waitFor(() => expect(result.current.workspaceSynced).toBe(true));
});
