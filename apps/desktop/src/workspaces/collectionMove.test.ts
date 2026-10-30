import { expect, it, vi } from "vitest";
import { collectionPlace, finishedTransfer, type FinishedTransfer } from "./collectionMove";
import type { DatasetTransferStatus } from "./localDatasetTransfer";

const transfer = <State extends DatasetTransferStatus["state"]>(state: State) =>
  ({ state, targetOrigin: "https://sync.example.test" }) as DatasetTransferStatus & { state: State };

it("says where a Collection is, and asks what the server runs only for one with automations", async () => {
  const runs = vi.fn(async () => "off" as const);
  const counts = (automations: number) => async () => ({ automations, scheduledAutomations: 0 });
  await expect(collectionPlace({ transfer: transfer("imported"), relayUrl: null, automations: counts(0), runs })).resolves.toEqual({ kind: "server", host: "sync.example.test" });
  await expect(collectionPlace({ transfer: null, relayUrl: null, automations: counts(2), runs })).resolves.toEqual({ kind: "here", server: null });
  await expect(collectionPlace({ transfer: null, relayUrl: "https://sync.example.test/", automations: counts(0), runs }))
    .resolves.toEqual({ kind: "here", server: { host: "sync.example.test", runs: null, automations: 0, scheduledAutomations: 0 } });
  expect(runs).not.toHaveBeenCalled();
  await expect(collectionPlace({ transfer: null, relayUrl: "https://sync.example.test/", automations: counts(2), runs }))
    .resolves.toEqual({ kind: "here", server: { host: "sync.example.test", runs: "off", automations: 2, scheduledAutomations: 0 } });
});

// A transfer record that reads `before` until the move ends, then `after`.
function moving(before: DatasetTransferStatus | null, options: { after?: FinishedTransfer; inFlight?: Promise<DatasetTransferStatus>; relayUrl?: string } = {}) {
  let current = before;
  const local = {
    transferStatus: vi.fn(() => current),
    transferInFlight: vi.fn(() => options.inFlight?.then(value => { current = options.after ?? null; return value; }) ?? null),
    transferToShared: vi.fn(async (input: { targetOrigin: string }) => { current = options.after ?? null; return { ...options.after!, targetOrigin: input.targetOrigin }; }),
  };
  const server = vi.fn(async () => ({ credentials: { serverUrl: "https://account.example.test", relayUrl: options.relayUrl ?? "https://sync.example.test", token: "t", userId: "u", email: "u@example.test" }, credentialGeneration: 1 }));
  const finish = () => finishedTransfer({ local, workspaceId: "w", datasetId: "d", server, currentCredentialGeneration: () => 1,
    relayStream: async () => { throw Error("Nothing streams in this test."); }, signal: new AbortController().signal });
  return { local, server, finish };
}

it("reads a Collection's transfer record as it is when no move is unfinished", async () => {
  const here = moving(null);
  await expect(here.finish()).resolves.toBeNull();
  const moved = moving(transfer("imported"));
  await expect(moved.finish()).resolves.toMatchObject({ state: "imported" });
  for (const { local, server } of [here, moved]) {
    expect(server).not.toHaveBeenCalled();
    expect(local.transferToShared).not.toHaveBeenCalled();
  }
});

it("waits for the move this app is running instead of refusing the read", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const { local, server, finish } = moving(transfer("ready"), { after: transfer("imported"), inFlight: new Promise(resolve => { end = resolve; }) });
  const read = finish();
  let settled = false;
  void read.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  end(transfer("imported"));
  await expect(read).resolves.toMatchObject({ state: "imported" });
  expect(server).not.toHaveBeenCalled();
  expect(local.transferToShared).not.toHaveBeenCalled();
});

it("fails a read with the move's own error when the move this app is running fails", async () => {
  const { finish } = moving(transfer("ready"), { inFlight: Promise.reject(Error("The server stopped answering.")) });
  await expect(finish()).rejects.toThrow("The server stopped answering.");
});

it("resumes a move that stopped partway to the same server", async () => {
  const { local, finish } = moving(transfer("ready"), { after: transfer("imported") });
  await expect(finish()).resolves.toMatchObject({ state: "imported" });
  expect(local.transferToShared).toHaveBeenCalledWith(expect.objectContaining({ datasetId: "d", targetOrigin: "https://sync.example.test" }));
});

it("keeps refusing a move to a server this workspace no longer uses, and names that server", async () => {
  const { local, finish } = moving(transfer("ready"), { after: transfer("imported"), relayUrl: "https://other.example.test" });
  await expect(finish()).rejects.toThrow("This Collection is moving to sync.example.test. Sign in to sync.example.test to finish the move.");
  expect(local.transferToShared).not.toHaveBeenCalled();
});
