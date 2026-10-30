import { expect, it, vi } from "vitest";
import { collectionPlace } from "./collectionMove";
import type { DatasetTransferStatus } from "./localDatasetTransfer";

const transfer = (state: DatasetTransferStatus["state"]) => ({ state, targetOrigin: "https://sync.example.test" }) as DatasetTransferStatus;

it("says where a Collection is, and asks what the server runs only for one with automations", async () => {
  const runs = vi.fn(async () => "off" as const);
  const counts = (automations: number) => async () => ({ automations, scheduledAutomations: 0 });
  await expect(collectionPlace({ transfer: transfer("ready"), relayUrl: "https://sync.example.test", automations: counts(0), runs }))
    .rejects.toThrow("This Collection is transferring. Wait for the transfer to finish, then retry.");
  await expect(collectionPlace({ transfer: transfer("imported"), relayUrl: null, automations: counts(0), runs })).resolves.toEqual({ kind: "server", host: "sync.example.test" });
  await expect(collectionPlace({ transfer: null, relayUrl: null, automations: counts(2), runs })).resolves.toEqual({ kind: "here", server: null });
  await expect(collectionPlace({ transfer: null, relayUrl: "https://sync.example.test/", automations: counts(0), runs }))
    .resolves.toEqual({ kind: "here", server: { host: "sync.example.test", runs: null, automations: 0, scheduledAutomations: 0 } });
  expect(runs).not.toHaveBeenCalled();
  await expect(collectionPlace({ transfer: null, relayUrl: "https://sync.example.test/", automations: counts(2), runs }))
    .resolves.toEqual({ kind: "here", server: { host: "sync.example.test", runs: "off", automations: 2, scheduledAutomations: 0 } });
});
