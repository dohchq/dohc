import { expect, it, vi } from "vitest";
import { CollectionMoveUnfinishedError } from "../ipc/errorWords";
import {
  collectionPlace,
  createAttachmentCollectionsSendUp,
  createCollectionsSendUp,
  finishedTransfer,
  movedTransfer,
  moveCollectionToServer,
  type FinishedTransfer,
} from "./collectionMove";
import type { DatasetTransferStatus } from "./localDatasetTransfer";

const transfer = <State extends DatasetTransferStatus["state"]>(state: State) =>
  ({ state, targetOrigin: "https://sync.example.test" }) as DatasetTransferStatus & {
    state: State;
  };

it("says a Collection is on the server its finished move reached, and otherwise here", () => {
  expect(collectionPlace(transfer("imported"))).toEqual({
    kind: "server",
    host: "sync.example.test",
  });
  expect(collectionPlace(null)).toEqual({ kind: "here" });
});

function moving(
  before: DatasetTransferStatus | null,
  options: {
    after?: FinishedTransfer;
    inFlight?: Promise<DatasetTransferStatus>;
    relayUrl?: string;
    noSession?: Error;
  } = {},
) {
  let current = before;
  const local = {
    transferStatus: vi.fn(() => current),
    transferInFlight: vi.fn(
      () =>
        options.inFlight?.then((value) => {
          current = options.after ?? null;
          return value;
        }) ?? null,
    ),
    transferToShared: vi.fn(async (input: { targetOrigin: string }) => {
      current = options.after ?? null;
      return { ...options.after!, targetOrigin: input.targetOrigin };
    }),
  };
  const server = vi.fn(async () => {
    if (options.noSession) throw options.noSession;
    return {
      credentials: {
        serverUrl: "https://account.example.test",
        relayUrl: options.relayUrl ?? "https://sync.example.test",
        token: "t",
        userId: "u",
        email: "u@example.test",
      },
      credentialGeneration: 1,
    };
  });
  const read = (signal: AbortSignal) => ({
    local,
    workspaceId: "w",
    datasetId: "d",
    server,
    currentCredentialGeneration: () => 1,
    relayStream: async () => {
      throw Error("Nothing streams in this test.");
    },
    signal,
  });
  const finish = (signal = new AbortController().signal) => finishedTransfer(read(signal));
  const moved = () => movedTransfer(read(new AbortController().signal));
  return { local, server, finish, moved };
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

it("reads a Collection whose move hasn't finished from this computer in the background, without waiting for the move or resuming it", async () => {
  const stopped = moving(transfer("ready"), { after: transfer("imported") });
  await expect(stopped.moved()).resolves.toBeNull();
  const running = moving(transfer("ready"), {
    after: transfer("imported"),
    inFlight: new Promise(() => undefined),
  });
  await expect(running.moved()).resolves.toBeNull();
  const finished = moving(transfer("imported"));
  await expect(finished.moved()).resolves.toMatchObject({ state: "imported" });
  for (const { local, server } of [stopped, running, finished]) {
    expect(server).not.toHaveBeenCalled();
    expect(local.transferToShared).not.toHaveBeenCalled();
  }
});

it("waits for the move this app is running instead of refusing the read", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const { local, server, finish } = moving(transfer("ready"), {
    after: transfer("imported"),
    inFlight: new Promise((resolve) => {
      end = resolve;
    }),
  });
  const read = finish();
  let settled = false;
  void read.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  end(transfer("imported"));
  await expect(read).resolves.toMatchObject({ state: "imported" });
  expect(server).not.toHaveBeenCalled();
  expect(local.transferToShared).not.toHaveBeenCalled();
});

it("waits for the move this app is running while it prepares its archive, before its transfer record exists", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const { finish } = moving(null, {
    after: transfer("imported"),
    inFlight: new Promise((resolve) => {
      end = resolve;
    }),
  });
  const read = finish();
  end(transfer("imported"));
  await expect(read).resolves.toMatchObject({ state: "imported" });
});

it("reads the Collection on this computer when the move this app is running stops before its transfer record exists", async () => {
  const { finish } = moving(null, {
    inFlight: Promise.reject(
      Error("The Collection changed while it was being exported. Retry this transfer."),
    ),
  });
  await expect(finish()).resolves.toBeNull();
});

it("stops waiting when the read is cancelled, and leaves the move running", async () => {
  let end!: (value: DatasetTransferStatus) => void;
  const move = new Promise<DatasetTransferStatus>((resolve) => {
    end = resolve;
  });
  const { finish } = moving(transfer("ready"), { after: transfer("imported"), inFlight: move });
  const reader = new AbortController();
  const read = finish(reader.signal);
  reader.abort(Error("The read was cancelled."));
  await expect(read).rejects.toThrow("The read was cancelled.");
  end(transfer("imported"));
  await expect(move).resolves.toMatchObject({ state: "imported" });
});

const unfinished =
  "This Collection did not finish moving to sync.example.test. Its records are kept on this computer.";

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
  const local = {
    transferStatus: () => status,
    transferToShared: vi.fn(async () => {
      throw stopped;
    }),
  };
  const move = () =>
    moveCollectionToServer({
      local,
      workspaceId: "w",
      datasetId: "d",
      credentialGeneration: 1,
      currentCredentialGeneration: () => 1,
      credentials: {
        serverUrl: "https://account.example.test",
        relayUrl: "https://sync.example.test",
        token: "t",
        userId: "u",
        email: "u@example.test",
      },
      relayStream: async () => {
        throw Error("Nothing streams in this test.");
      },
      signal: new AbortController().signal,
    });
  await expect(move()).rejects.toBe(stopped);
  status = transfer("ready");
  const failure = await move().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(CollectionMoveUnfinishedError);
  expect(failure).toMatchObject({ message: unfinished, cause: stopped });
});

it("resumes a move that stopped partway to the same server", async () => {
  const { local, finish } = moving(transfer("ready"), { after: transfer("imported") });
  await expect(finish()).resolves.toMatchObject({ state: "imported" });
  expect(local.transferToShared).toHaveBeenCalledWith(
    expect.objectContaining({ datasetId: "d", targetOrigin: "https://sync.example.test" }),
  );
});

it("keeps refusing a move to a server this workspace no longer uses, and names that server", async () => {
  const { local, finish } = moving(transfer("ready"), {
    after: transfer("imported"),
    relayUrl: "https://other.example.test",
  });
  await expect(finish()).rejects.toThrow(
    "This Collection is moving to sync.example.test. Sign in to sync.example.test to finish the move.",
  );
  expect(local.transferToShared).not.toHaveBeenCalled();
});

it("names the server a move is going to when this workspace has no session for it", async () => {
  const { local, finish } = moving(transfer("ready"), {
    after: transfer("imported"),
    noSession: Error("Sync this workspace before sharing."),
  });
  await expect(finish()).rejects.toThrow(
    "This Collection is moving to sync.example.test. Sign in to sync.example.test to finish the move.",
  );
  expect(local.transferToShared).not.toHaveBeenCalled();
});

it("waits for the move another read resumed while this one asked for the session, instead of resuming it again", async () => {
  let inFlight: Promise<DatasetTransferStatus> | null = null,
    stop!: (error: Error) => void,
    session!: () => void;
  const answered = new Promise<void>((resolve) => {
    session = resolve;
  });
  const local = {
    transferStatus: () => transfer("ready"),
    transferInFlight: () => inFlight,
    transferToShared: vi.fn(() => {
      const task = new Promise<DatasetTransferStatus>((_resolve, reject) => {
        stop = reject;
      });
      inFlight = task;
      return task.finally(() => {
        inFlight = null;
      });
    }),
  };
  const server = async () => {
    await answered;
    return {
      credentials: {
        serverUrl: "https://account.example.test",
        relayUrl: "https://sync.example.test",
        token: "t",
        userId: "u",
        email: "u@example.test",
      },
      credentialGeneration: 1,
    };
  };
  const read = () =>
    finishedTransfer({
      local,
      workspaceId: "w",
      datasetId: "d",
      server,
      currentCredentialGeneration: () => 1,
      relayStream: async () => {
        throw Error("Nothing streams in this test.");
      },
      signal: new AbortController().signal,
    });
  const first = read(),
    second = read();
  session();
  await vi.waitFor(() => expect(local.transferToShared).toHaveBeenCalled());
  expect(local.transferToShared).toHaveBeenCalledTimes(1);
  const stopped = Error("The server stopped answering.");
  stop(stopped);
  await expect(first).rejects.toMatchObject({
    name: "CollectionMoveUnfinishedError",
    code: undefined,
    cause: stopped,
  });
  await expect(second).rejects.toMatchObject({
    name: "CollectionMoveUnfinishedError",
    code: "waited",
    cause: stopped,
  });
  expect(local.transferToShared).toHaveBeenCalledTimes(1);
});

it("lets a read of a Collection that went up go on while another is still going up", async () => {
  const looks = new Map<string, number>();
  let stop!: (error: Error) => void;
  const stuck = new Promise<never>((_resolve, reject) => (stop = reject));
  const sendUp = createCollectionsSendUp({
    open: async () =>
      ({
        keptDatasetIds: () => ["a", "b"],
        // "a" arrives as soon as the send reaches it; "b" waits for a server that doesn't answer.
        transferStatus(datasetId: string) {
          const seen = looks.get(datasetId) ?? 0;
          looks.set(datasetId, seen + 1);
          return datasetId === "a" && seen > 0 ? transfer("imported") : null;
        },
        transferInFlight: () => null,
        transferToShared() {},
      }) as never,
    session: () => ({ server: () => stuck, signal: new AbortController().signal }) as never,
    reported() {},
  });
  const done = sendUp.start();
  await expect(sendUp.sent("a", new AbortController().signal)).resolves.toBeUndefined();
  const waiting = new AbortController();
  const b = sendUp.sent("b", waiting.signal);
  waiting.abort(Error("closed"));
  await expect(b).rejects.toThrow("closed");
  stop(Error("stopped"));
  await done;
});

it("starts a send that couldn't open this computer's store once more before a read goes to the server", async () => {
  const unreadable = Error("The store didn't open.");
  const store = {
    keptDatasetIds: () => ["a"],
    transferStatus: () => null,
    transferInFlight: () => null,
    transferToShared() {},
  } as never;
  let refuse!: (error: Error) => void;
  const refused = new Promise<never>((_resolve, reject) => (refuse = reject));
  const session = () => ({ server: () => refused, signal: new AbortController().signal }) as never;
  const open = vi.fn(async () => store).mockRejectedValueOnce(unreadable);
  const sendUp = createCollectionsSendUp({ open, session, reported() {} });
  await expect(sendUp.start()).rejects.toBe(unreadable);
  const read = sendUp.sent("a", new AbortController().signal);
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  // Only the second send can give the read this server's refusal.
  refuse(Error("The server refused."));
  await expect(read).rejects.toThrow("The server refused.");

  // A store that still doesn't open leaves the read to the server, where Collections that went up are.
  const broken = vi.fn(async () => store).mockRejectedValue(unreadable);
  const stuck = createCollectionsSendUp({ open: broken, session, reported() {} });
  await expect(stuck.start()).rejects.toBe(unreadable);
  await expect(stuck.sent("a", new AbortController().signal)).resolves.toBeUndefined();
  expect(broken).toHaveBeenCalledTimes(2);
});

it("stops an attachment's send when the workspace closes, and never sends the reopened workspace's Collections", async () => {
  const attachmentId = Symbol("first opening");
  let opened = { rootPath: "/first" };
  let current = attachmentId;
  const retirement = new AbortController();
  const asked: string[] = [];
  let refuse!: (error: Error) => void;
  const store = {
    keptDatasetIds: () => ["a", "b"],
    transferStatus: () => null,
    transferInFlight: () => null,
    transferToShared() {},
  } as never;
  const reported = vi.fn();
  const sendUp = createAttachmentCollectionsSendUp(
    { workspaceId: "workspace-a", attachmentId },
    {
      findWorkspace: () => opened,
      retirementSignal: (_workspaceId, id) => {
        if (id !== current) throw new Error("This workspace was closed. Open it again.");
        return retirement.signal;
      },
      storeExists: async () => true,
      localHost: async (_workspace, signal) => {
        signal.throwIfAborted();
        return store;
      },
      transferSession: (workspace, signal) =>
        ({ workspaceId: "workspace-a", rootPath: workspace.rootPath, signal }) as never,
      server: (workspace) => {
        asked.push(workspace.rootPath);
        // Only the first question waits; the test answers it once the workspace has opened again.
        if (asked.length > 1) return Promise.reject(Error("The server refused."));
        return new Promise<never>((_resolve, reject) => (refuse = reject));
      },
      reported,
    },
  );
  const done = sendUp.start();
  await vi.waitFor(() => expect(asked).toEqual(["/first"]));
  // The workspace closes and opens again while the server hasn't answered for "a".
  retirement.abort();
  current = Symbol("second opening");
  opened = { rootPath: "/second" };
  refuse(Error("The server didn't answer."));
  const outcome = await done.then(
    () => "finished",
    () => "stopped",
  );
  expect(asked).toEqual(["/first"]);
  expect(outcome).toBe("stopped");
  expect(reported).not.toHaveBeenCalled();
});

it("sends a Collection kept after a running send looked, once that send ends", async () => {
  const kept = ["a"];
  const asked: string[] = [];
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  const sendUp = createCollectionsSendUp({
    open: async () =>
      ({
        keptDatasetIds: () => [...kept],
        transferStatus: () => null,
        transferInFlight: () => null,
        transferToShared() {},
      }) as never,
    session: () =>
      ({
        // Each Collection asks the server once; "a" waits until the test answers.
        server: async () => {
          asked.push(kept[asked.length]!);
          if (asked.length === 1) await answered;
          throw Error("The server refused.");
        },
        signal: new AbortController().signal,
      }) as never,
    reported() {},
  });
  void sendUp.start().catch(() => undefined);
  await vi.waitFor(() => expect(asked).toEqual(["a"]));
  // "b" is kept here after the running send read its list, as a Collection
  // made just as the workspace starts syncing is.
  kept.push("b");
  void sendUp.start().catch(() => undefined);
  const read = sendUp.sent("b", new AbortController().signal);
  answer();
  await expect(read).rejects.toThrow("The server refused.");
  expect(asked).toContain("b");
});

it("lets reads of Collections a running send took or never needs go on while a later send waits for it", async () => {
  const kept = ["a", "b", "gone"];
  const looks = new Map<string, number>();
  let stop!: (error: Error) => void;
  const stuck = new Promise<never>((_resolve, reject) => (stop = reject));
  const sendUp = createCollectionsSendUp({
    open: async () =>
      ({
        keptDatasetIds: () => [...kept],
        // "gone" went up before; "a" arrives as soon as the send reaches it;
        // "b" waits for a server that doesn't answer.
        transferStatus(datasetId: string) {
          const seen = looks.get(datasetId) ?? 0;
          looks.set(datasetId, seen + 1);
          if (datasetId === "gone") return transfer("imported");
          return datasetId === "a" && seen > 0 ? transfer("imported") : null;
        },
        transferInFlight: () => null,
        transferToShared() {},
      }) as never,
    session: () => ({ server: () => stuck, signal: new AbortController().signal }) as never,
    reported() {},
  });
  const done = sendUp.start();
  await expect(sendUp.sent("a", new AbortController().signal)).resolves.toBeUndefined();
  // "c" is kept after the running send looked, so another send waits for it.
  kept.push("c");
  const later = sendUp.start();
  const read = new Set<string>();
  for (const datasetId of ["a", "gone", "elsewhere"])
    void sendUp.sent(datasetId, new AbortController().signal).then(() => read.add(datasetId));
  await vi.waitFor(() => expect([...read].sort()).toEqual(["a", "elsewhere", "gone"]));
  const c = sendUp.sent("c", new AbortController().signal);
  stop(Error("stopped"));
  await expect(c).rejects.toThrow("stopped");
  await done;
  await later;
});
