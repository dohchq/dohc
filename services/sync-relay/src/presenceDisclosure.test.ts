import { expect, it, vi } from "vitest";
import { createPresenceProjection, type PreparedPresenceSnapshot } from "./presenceDisclosure";

it("coalesces account lookups and refreshes positive and missing labels after 30 seconds", async () => {
  let now = 0;
  let release!: (label: string | null) => void;
  const lookup = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
  );
  const project = createPresenceProjection(lookup, () => now);
  const snapshot = {
    version: 1,
    peers: [
      {
        userId: "owner",
        clientId: "owner-device",
        sessionId: "session",
        state: {},
        updatedAtMs: 0,
      },
    ],
  };
  const prepared: PreparedPresenceSnapshot = {
    peers: [{ peer: snapshot.peers[0]!, isOwner: true, state: {} }],
    chatAttribution: false,
  };
  const input = {
    scopeKey: "scope",
    viewerUserId: "owner",
    viewerClientId: "owner-device",
    viewerIsOwner: true,
    prepare: () => prepared,
  };
  const first = project(snapshot, input);
  const second = project(snapshot, {
    ...input,
    viewerUserId: "recipient",
    viewerIsOwner: false,
  });
  expect(lookup).toHaveBeenCalledTimes(1);
  release("Owner");
  expect((await first).peers[0]!.displayName).toBe("Owner");
  expect((await second).peers[0]!.displayName).toBe("Owner");
  now = 29_999;
  await project(snapshot, input);
  expect(lookup).toHaveBeenCalledTimes(1);
  now = 30_000;
  const missing = project(snapshot, input);
  expect(lookup).toHaveBeenCalledTimes(2);
  release(null);
  expect((await missing).peers[0]!.displayName).toBeNull();
  await project(snapshot, input);
  expect(lookup).toHaveBeenCalledTimes(2);
  now = 60_000;
  const renamed = project(snapshot, input);
  expect(lookup).toHaveBeenCalledTimes(3);
  release("Renamed");
  expect((await renamed).peers[0]!.displayName).toBe("Renamed");
});
