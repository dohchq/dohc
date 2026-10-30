import { expect, it, vi } from "vitest";
import { CollectionMoveUnfinishedError } from "../ipc/errorWords";
import { collectionPlace, finishedTransfer, moveCollectionToServer, type FinishedTransfer } from "./collectionMove";
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
function moving(before: DatasetTransferStatus | null, options: { after?: FinishedTransfer; inFlight?: Promise<DatasetTransferStatus>; relayUrl?: string; noSession?: Error } = {}) {
  let current = before;
  const local = {
    transferStatus: vi.fn(() => current),
    transferInFlight: vi.fn(() => options.inFlight?.then(value => { current = options.after ?? null; return value; }) ?? null),
    transferToShared: vi.fn(async (input: { targetOrigin: string }) => { current = options.after ?? null; return { ...options.after!, targetOrigin: input.targetOrigin }; }),
  };
  const server = vi.fn(async () => {
    if (options.noSession) throw options.noSession;
    return { credentials: { serverUrl: "https://account.example.test", relayUrl: options.relayUrl ?? "https://sync.example.test", token: "t", userId: "u", email: "u@example.test" }, credentialGeneration: 1 };
  });
  const finish = (signal = new AbortController().signal) => finishedTransfer({ local, workspaceId: "w", datasetId: "d", server, currentCredentialGeneration: () => 1,
    relayStream: async () => { throw Error("Nothing streams in this test."); }, signal });
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

it("waits for the move this app is running while it prepares its archive, before its transfer record exists", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const { finish } = moving(null, { after: transfer("imported"), inFlight: new Promise(resolve => { end = resolve; }) });
  const read = finish();
  end(transfer("imported"));
  await expect(read).resolves.toMatchObject({ state: "imported" });
});

it("reads the Collection on this computer when the move this app is running stops before its transfer record exists", async () => {
  const { finish } = moving(null, { inFlight: Promise.reject(Error("The Collection changed while it was being exported. Retry this transfer.")) });
  await expect(finish()).resolves.toBeNull();
});

it("stops waiting when the read is cancelled, and leaves the move running", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const move = new Promise<DatasetTransferStatus>(resolve => { end = resolve; });
  const { finish } = moving(transfer("ready"), { after: transfer("imported"), inFlight: move });
  const reader = new AbortController();
  const read = finish(reader.signal);
  reader.abort(Error("The read was cancelled."));
  await expect(read).rejects.toThrow("The read was cancelled.");
  end(transfer("imported"));
  await expect(move).resolves.toMatchObject({ state: "imported" });
});

const unfinished = "This Collection didn't finish moving to sync.example.test. Its records are kept on this computer.";

it("fails a read that waited for the move this app is running with the server's name, marked as waited, when the move stops", async () => {
  const stopped = Error("The server stopped answering.");
  const { finish } = moving(transfer("ready"), { inFlight: Promise.reject(stopped) });
  const failure = await finish().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CollectionMoveUnfinishedError);
  expect(failure).toMatchObject({ message: unfinished, code: "waited", cause: stopped });
});

it("names the server, unmarked, when a move that a read resumed stops again", async () => {
  const stopped = Error("Sharing failed (502).");
  const { local, finish } = moving(transfer("ready"));
  local.transferToShared.mockRejectedValueOnce(stopped);
  const failure = await finish().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CollectionMoveUnfinishedError);
  expect(failure).toMatchObject({ message: unfinished, cause: stopped });
  expect((failure as CollectionMoveUnfinishedError).code).toBeUndefined();
});

it("names the server when a move stops after its transfer record exists, and keeps the move's own error before that", async () => {
  const stopped = Error("Sharing failed (502).");
  let status: DatasetTransferStatus | null = null;
  const local = { transferStatus: () => status, transferToShared: vi.fn(async () => { throw stopped; }) };
  const move = () => moveCollectionToServer({ local, workspaceId: "w", datasetId: "d", credentialGeneration: 1, currentCredentialGeneration: () => 1,
    credentials: { serverUrl: "https://account.example.test", relayUrl: "https://sync.example.test", token: "t", userId: "u", email: "u@example.test" },
    relayStream: async () => { throw Error("Nothing streams in this test."); }, signal: new AbortController().signal });
  await expect(move()).rejects.toBe(stopped);
  status = transfer("ready");
  const failure = await move().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CollectionMoveUnfinishedError);
  expect(failure).toMatchObject({ message: unfinished, cause: stopped });
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

it("names the server a move is going to when this workspace has no session for it", async () => {
  const { local, finish } = moving(transfer("ready"), { after: transfer("imported"), noSession: Error("Sync this workspace before sharing.") });
  await expect(finish()).rejects.toThrow("This Collection is moving to sync.example.test. Sign in to sync.example.test to finish the move.");
  expect(local.transferToShared).not.toHaveBeenCalled();
});

it("waits for the move another read resumed while this one asked for the session, instead of resuming it again", async () => {
  let inFlight: Promise<DatasetTransferStatus> | null = null, stop!: (error: Error) => void, session!: () => void;
  const answered = new Promise<void>(resolve => { session = resolve; });
  const local = {
    transferStatus: () => transfer("ready"),
    transferInFlight: () => inFlight,
    transferToShared: vi.fn(() => {
      const task = new Promise<DatasetTransferStatus>((_resolve, reject) => { stop = reject; });
      inFlight = task;
      return task.finally(() => { inFlight = null; });
    }),
  };
  const server = async () => {
    await answered;
    return { credentials: { serverUrl: "https://account.example.test", relayUrl: "https://sync.example.test", token: "t", userId: "u", email: "u@example.test" }, credentialGeneration: 1 };
  };
  const read = () => finishedTransfer({ local, workspaceId: "w", datasetId: "d", server, currentCredentialGeneration: () => 1,
    relayStream: async () => { throw Error("Nothing streams in this test."); }, signal: new AbortController().signal });
  const first = read(), second = read();
  session();
  await vi.waitFor(() => expect(local.transferToShared).toHaveBeenCalled());
  expect(local.transferToShared).toHaveBeenCalledTimes(1);
  const stopped = Error("The server stopped answering.");
  stop(stopped);
  // The read that ran the move reports its stop. The read that only waited says so.
  await expect(first).rejects.toMatchObject({ name: "CollectionMoveUnfinishedError", code: undefined, cause: stopped });
  await expect(second).rejects.toMatchObject({ name: "CollectionMoveUnfinishedError", code: "waited", cause: stopped });
  expect(local.transferToShared).toHaveBeenCalledTimes(1);
});
