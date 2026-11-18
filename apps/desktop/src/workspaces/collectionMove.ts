import type { DatasetPlace } from "@dohc/cli/dataset";
import { CollectionMoveUnfinishedError } from "../ipc/errorWords";
import type { CloudCredentials } from "./cloudCredentialStore";
import type { LocalDatasetHost } from "./localDatasetHost";
import type { DatasetTransferStatus } from "./localDatasetTransfer";
import {
  createDatasetAuthorityRouter,
  createRemoteDatasetTransferTarget,
  type DatasetAuthorityRoute,
  type OwnerDatasetData,
} from "./remoteDataset";

/** The transfer record of a Collection whose move to a server finished. */
export type FinishedTransfer = DatasetTransferStatus & { state: "imported" };

/** Where a Collection is, from its finished transfer record on this computer. */
export function collectionPlace(transfer: FinishedTransfer | null): DatasetPlace {
  return transfer
    ? { kind: "server", host: new URL(transfer.targetOrigin).host }
    : { kind: "here" };
}

/**
 * Moves a Collection that is only on this computer to the workspace's server,
 * which then holds it for good. A move that stops after this computer
 * stopped changing the Collection names the server it didn't reach.
 */
export async function moveCollectionToServer(input: {
  local: Pick<LocalDatasetHost, "transferToShared" | "transferStatus">;
  workspaceId: string;
  datasetId: string;
  credentials: CloudCredentials;
  credentialGeneration: number;
  currentCredentialGeneration(): number;
  relayStream(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
  signal: AbortSignal;
}): Promise<void> {
  if (!input.credentials.relayUrl) throw new Error("Reconnect to your server, then try again.");
  const targetOrigin = new URL(input.credentials.relayUrl).origin;
  const target = createRemoteDatasetTransferTarget({
    workspaceId: input.workspaceId,
    datasetId: input.datasetId,
    origin: targetOrigin,
    credentials: input.credentials,
    credentialGeneration: input.credentialGeneration,
    currentCredentialGeneration: input.currentCredentialGeneration,
    signal: input.signal,
    assertCurrent: () => input.signal.throwIfAborted(),
    relayStream: input.relayStream,
  });
  await input.local
    .transferToShared({ datasetId: input.datasetId, targetOrigin, target, signal: input.signal })
    .catch((error: unknown) => {
      if (input.signal.aborted || input.local.transferStatus(input.datasetId)?.state !== "ready")
        throw error;
      throw new CollectionMoveUnfinishedError(new URL(targetOrigin).host, { cause: error });
    });
}

/**
 * A Collection's transfer record once its move has finished, or null for one
 * only on this computer. A read waits for the move this app is running, even
 * one still preparing its archive. A move that stopped partway resumes to the
 * same server, which the workspace syncs with.
 */
export async function finishedTransfer(input: {
  local: Pick<LocalDatasetHost, "transferStatus" | "transferInFlight" | "transferToShared">;
  workspaceId: string;
  datasetId: string;
  /** The workspace's server session, asked for only to resume a move. */
  server(): Promise<{ credentials: CloudCredentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  relayStream(credentials: CloudCredentials, path: string, init: RequestInit): Promise<unknown>;
  signal: AbortSignal;
}): Promise<FinishedTransfer | null> {
  const moving = input.local.transferInFlight(input.datasetId);
  const failure = moving
    ? await abortable(moving, input.signal).then(
        () => null,
        (error: unknown) => error,
      )
    : null;
  input.signal.throwIfAborted();
  const transfer = input.local.transferStatus(input.datasetId);
  if (!transfer || transfer.state === "imported") return transfer as FinishedTransfer | null;
  const host = new URL(transfer.targetOrigin).host;
  if (moving) throw new CollectionMoveUnfinishedError(host, { cause: failure, waited: true });
  const needsHost = (cause?: unknown) =>
    new Error(`This Collection is moving to ${host}. Sign in to ${host} to finish the move.`, {
      cause,
    });
  const { credentials, credentialGeneration } = await input.server().catch((error: unknown) => {
    throw needsHost(error);
  });
  input.signal.throwIfAborted();
  if (!credentials.relayUrl || new URL(credentials.relayUrl).origin !== transfer.targetOrigin)
    throw needsHost();
  // Another read resumed the move while this one asked for the session: wait for that move, not after it.
  if (input.local.transferInFlight(input.datasetId)) return finishedTransfer(input);
  await moveCollectionToServer({ ...input, credentials, credentialGeneration });
  input.signal.throwIfAborted();
  const finished = input.local.transferStatus(input.datasetId);
  if (finished?.state !== "imported")
    throw new CollectionMoveUnfinishedError(host, { cause: null });
  return finished as FinishedTransfer;
}

/**
 * Sends each Collection this computer keeps to the workspace's server, which
 * then holds it for good: a workspace that syncs keeps its Collections there.
 * A send that stopped partway resumes to the same server. A server that
 * already has a Collection with the same id refuses it, and this computer
 * keeps that one's records. Answers each Collection it couldn't send, with why.
 */
export async function sendCollectionsUp(
  input: Omit<Parameters<typeof finishedTransfer>[0], "local" | "datasetId"> & {
    local: Pick<
      LocalDatasetHost,
      "keptDatasetIds" | "transferStatus" | "transferInFlight" | "transferToShared"
    >;
    /** Hears each Collection as it arrives, or with why it didn't. */
    settled?(datasetId: string, failure?: { error: unknown }): void;
  },
): Promise<Map<string, unknown>> {
  const unsent = new Map<string, unknown>();
  for (const datasetId of input.local.keptDatasetIds()) {
    try {
      if (input.local.transferStatus(datasetId)?.state !== "imported") {
        if (!input.local.transferStatus(datasetId) && !input.local.transferInFlight(datasetId)) {
          const session = await input.server();
          input.signal.throwIfAborted();
          await moveCollectionToServer({ ...input, ...session, datasetId });
        }
        await finishedTransfer({ ...input, datasetId });
      }
      input.settled?.(datasetId);
    } catch (error) {
      input.signal.throwIfAborted();
      unsent.set(datasetId, error);
      input.settled?.(datasetId, { error });
    }
  }
  return unsent;
}

type SendUpStore = Parameters<typeof sendCollectionsUp>[0]["local"];

/**
 * The Collections this computer kept before its workspace synced, as they go
 * to the server once. `start` sends them in the background, unless a send is
 * running; `reported` hears each send's Collections that didn't arrive. A
 * read of a Collection still going up waits for it with `sent`. One that
 * didn't arrive goes again, and the read rejects with why if it still can't.
 * A send that couldn't open this computer's store starts again once.
 */
export function createCollectionsSendUp(input: {
  /** This computer's store, or null where it has none. */
  open(): Promise<SendUpStore | null>;
  session(): Omit<Parameters<typeof sendCollectionsUp>[0], "local">;
  reported(unsent: Map<string, unknown>): void;
}) {
  type Failure = { error: unknown } | undefined;
  type Started = {
    // Each Collection the send took, settled once it arrives or with why it didn't.
    waits: ReadonlyMap<string, Promise<Failure>>;
    done: Promise<unknown>;
    local: SendUpStore;
  } | null;
  type SendUp = {
    run: Promise<Started>;
    settled: boolean;
    looked: boolean;
    // The running send this one waits for, until it begins.
    before: SendUp | null;
    started?: Started;
  };
  let current: SendUp | null = null;
  async function begin(sendUp: SendUp): Promise<Started> {
    sendUp.before = null;
    const finish = () => (sendUp.settled = true);
    const local = await input.open();
    const ids = local
      ? local.keptDatasetIds().filter((id) => local.transferStatus(id)?.state !== "imported")
      : [];
    sendUp.looked = true;
    if (!local || ids.length === 0) {
      finish();
      return null;
    }
    const settle = new Map<
      string,
      { resolve(failure: Failure): void; reject(error: unknown): void }
    >();
    const waits = new Map(
      ids.map((id) => {
        const wait = new Promise<Failure>((resolve, reject) => settle.set(id, { resolve, reject }));
        wait.catch(() => undefined);
        return [id, wait];
      }),
    );
    const done = sendCollectionsUp({
      local,
      ...input.session(),
      settled: (id, failure) => settle.get(id)?.resolve(failure),
    }).then(
      (unsent) => {
        finish();
        input.reported(unsent);
        // A Collection the send didn't reach, as one that went up meanwhile, is settled here.
        for (const [id, { resolve }] of settle)
          resolve(unsent.has(id) ? { error: unsent.get(id) } : undefined);
      },
      (error: unknown) => {
        finish();
        for (const { reject } of settle.values()) reject(error);
        throw error;
      },
    );
    sendUp.started = { waits, done, local };
    return sendUp.started;
  }
  // A send that hasn't looked at this computer's Collections yet takes this
  // start too. One that has may miss a Collection kept since, so another
  // send follows it.
  function start(): Promise<unknown> {
    if (current && !current.settled && !current.looked)
      return current.run.then((started) => started?.done);
    const running = current && !current.settled ? current : null;
    const sendUp: SendUp = {
      run: Promise.resolve(null),
      settled: false,
      looked: false,
      before: running,
    };
    sendUp.run = running
      ? running.run
          .then((started) => started?.done)
          .catch(() => undefined)
          .then(() => begin(sendUp))
      : begin(sendUp);
    sendUp.run.catch(() => (sendUp.settled = true));
    current = sendUp;
    return sendUp.run.then((started) => started?.done);
  }
  async function sent(datasetId: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (!current) return;
      // While a send waits for the running one, a Collection the running send
      // took waits only for that send, and one that went up or that this
      // computer never kept doesn't wait.
      const running = current.before?.settled === false ? current.before.started : undefined;
      if (running && !running.waits.has(datasetId) && needsNoSend(running.local, datasetId)) return;
      const started = running?.waits.has(datasetId)
        ? running
        : await abortable(
            current.run.catch(() => undefined),
            signal,
          );
      if (started === undefined) {
        // The send couldn't look at this computer's Collections, so this one may
        // still be here. Look once more. If that fails too, the read goes on to
        // the server, so Collections already there stay readable.
        if (attempt > 0) return;
        void start().catch(() => undefined);
        continue;
      }
      const wait = started?.waits.get(datasetId);
      if (!started || !wait) return;
      const failure = await abortable(wait, signal);
      if (!failure) return;
      if (attempt > 0) throw failure.error;
      // Send it again once this send has finished.
      await abortable(
        started.done.catch(() => undefined),
        signal,
      );
      void start().catch(() => undefined);
    }
  }
  return { start, sent };
}

function needsNoSend(local: SendUpStore, datasetId: string): boolean {
  return (
    local.transferStatus(datasetId)?.state === "imported" ||
    !local.keptDatasetIds().includes(datasetId)
  );
}

/**
 * One workspace attachment's background send. A workspace that already synced
 * but still keeps Collections sends them when it opens. Only an existing store
 * opens. The send belongs to the attachment that opened it: once that closes,
 * it stops and never reads a later opening of the same workspace.
 */
export function createAttachmentCollectionsSendUp<Workspace extends { rootPath: string }>(
  attachment: { workspaceId: string; attachmentId: symbol },
  input: {
    findWorkspace(workspaceId: string): Workspace | null;
    /** Aborts when the attachment closes. Throws if it already has. */
    retirementSignal(workspaceId: string, attachmentId: symbol): AbortSignal;
    storeExists(rootPath: string): Promise<boolean>;
    localHost(workspace: Workspace, signal: AbortSignal): Promise<SendUpStore>;
    transferSession(
      workspace: Workspace,
      signal: AbortSignal,
    ): Omit<Parameters<typeof sendCollectionsUp>[0], "local">;
    server(workspace: Workspace): ReturnType<Parameters<typeof sendCollectionsUp>[0]["server"]>;
    reported(unsent: Map<string, unknown>): void;
  },
) {
  const opened = () => {
    const signal = input.retirementSignal(attachment.workspaceId, attachment.attachmentId);
    const workspace = input.findWorkspace(attachment.workspaceId);
    if (!workspace) throw new Error("This workspace is no longer available.");
    return { workspace, signal };
  };
  return createCollectionsSendUp({
    open: async () => {
      const { workspace, signal } = opened();
      if (!(await input.storeExists(workspace.rootPath))) return null;
      signal.throwIfAborted();
      return input.localHost(workspace, signal);
    },
    session: () => {
      const { workspace, signal } = opened();
      return {
        ...input.transferSession(workspace, signal),
        server: () => input.server(opened().workspace),
      };
    },
    reported: input.reported,
  });
}

/**
 * A Collection's transfer record as a background read goes by it, as the
 * Collections list does: the record once its move finished, or null while
 * this computer still keeps the Collection's records. It never waits for an
 * unfinished move or resumes a stopped one. It waits only while a finished
 * move removes its archive.
 */
export function movedTransfer(
  input: Parameters<typeof finishedTransfer>[0],
): Promise<FinishedTransfer | null> {
  return input.local.transferStatus(input.datasetId)?.state === "imported"
    ? finishedTransfer(input)
    : Promise.resolve(null);
}

/**
 * The Collections a background read sees, such as History's. It goes by
 * `movedTransfer`, so a Collection whose move hasn't finished reads from this
 * computer, and the read never waits for the move or resumes it.
 */
export function createBackgroundDatasetRouter(
  local: LocalDatasetHost,
  session: Omit<Parameters<typeof finishedTransfer>[0], "local" | "datasetId">,
  remote: DatasetAuthorityRoute["remote"],
  assertCurrent: () => void,
): OwnerDatasetData {
  return createDatasetAuthorityRouter(local, {
    status: async (datasetId) => {
      assertCurrent();
      return movedTransfer({ ...session, local, datasetId });
    },
    marker: (datasetId) => local.transferStatus(datasetId),
    remote,
  });
}

// Settles with the work, or rejects when the signal aborts. Aborting stops only the wait, not the work.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
