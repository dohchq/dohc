import {createHash} from "node:crypto";
import {posix} from "node:path";
import type {
  CollectionRecordEditContext,
  RecordEditSession,
} from "@dohc/automation-executor/collection-record-edits";
import {
  openEngineYdocProviderSession,
  isIdempotencyKeyReuseRefusal,
  VersionedLiveAdapter,
  type EngineTransport,
  type EngineYdocProviderSession,
} from "@dohc/workspace-engine-client";
import type {AutomationReplica} from "./automationReplicas";

/** The engine calls a replica's record writes make. */
export interface ReplicaRecordEngine {
  readonly adapter: Pick<VersionedLiveAdapter, "getActiveVersion" | "readTextFile" | "writeTextFile" | "getCollectionRecord">;
  openSession(input: {versionId: string; path: string; expectedObjectId?: string}): Promise<EngineYdocProviderSession>;
}

/** The engine of one open replica. */
export function replicaRecordEngine(replica: Pick<AutomationReplica, "client" | "workspace" | "workspaceId">): ReplicaRecordEngine {
  return {
    adapter: new VersionedLiveAdapter(replica.client, replica.workspace, {workspaceId: replica.workspaceId}),
    openSession: ({versionId, path, expectedObjectId}) => openEngineYdocProviderSession({
      transport: replica.client as EngineTransport,
      workspace: replica.workspace,
      versionId,
      path,
      ...(expectedObjectId === undefined ? {} : {expectedObjectId}),
      // A record file is a live Markdown document.
      contentKind: "richdoc",
      // The session reads its own doc when a write's turn comes.
      onRemoteUpdate: () => undefined,
    }),
  };
}

/**
 * The record edit context over this server's replica of a workspace, for
 * its automations, over `engine` (replicaRecordEngine). Only an automation
 * writes here, as the workspace owner's push, with the automation as the
 * author of every change. `callerSignal` is the caller's lifetime; the
 * replica closing ends it too.
 *
 * Each write opens the record's session in the active version, journals each
 * field with its attribution and idempotency key, settles, and closes, as the
 * desktop's capture does for one write. A keyed update the engine did not
 * answer, or a write whose run ended, leaves the session without settling it,
 * so nothing resends an update without its key and nothing lands after the
 * run; the next open settles what the engine recorded. The engine adopts a
 * record before its create returns, since a replica has no capture to do it
 * later.
 */
export function replicaRecordEditContext(
  replica: Pick<AutomationReplica, "workspaceId" | "signal">,
  engine: ReplicaRecordEngine,
  callerSignal: AbortSignal,
): CollectionRecordEditContext {
  const {workspaceId} = replica;
  const signal = AbortSignal.any([callerSignal, replica.signal]);
  const {adapter} = engine;
  const activeVersion = async (): Promise<string> => {
    const version = await adapter.getActiveVersion({workspaceId});
    if (version === null) throw new Error("This server's copy of the workspace has no active version.");
    return version.id;
  };
  return {
    async openRecord(path) {
      const versionId = await activeVersion();
      const provider = await engine.openSession({versionId, path});
      const expectedObjectId = provider.objectId;
      return await recordSession(provider, path, signal, () => engine.openSession({
        versionId, path, ...(expectedObjectId === undefined ? {} : {expectedObjectId}),
      }));
    },
    async createFile(path, text, author) {
      if (author.kind !== "automation") throw new Error(AUTOMATIONS_ONLY);
      const versionId = await activeVersion();
      signal.throwIfAborted();
      await adapter.writeTextFile({
        workspaceId,
        versionId,
        path,
        text,
        publish: true,
        createOnly: true,
        // The same file again is the same request, so a retry after the
        // engine committed it replays the answer instead of refusing.
        requestId: `automation-create:${createHash("sha256").update(`${path}\0${text}`).digest("hex")}`,
        metadata: {origin: "api", summary: `Added ${posix.basename(path)}`},
        author: {kind: "automation", automationId: author.automationId, onBehalfOf: author.onBehalfOf, depth: author.depth},
      });
      return path;
    },
    async readText(path) {
      const read = await adapter.readTextFile({workspaceId, versionId: await activeVersion(), path});
      if (typeof read?.text !== "string") throw new Error(`${path} is not a text file in this server's copy of the workspace.`);
      return {text: read.text, truncated: false};
    },
    withAdapter: async (work) => replica.signal.aborted ? null : await work(adapter),
    // The engine adopted each record before its create returned.
    onRecordsChanged: () => () => undefined,
    signal,
  };
}

const AUTOMATIONS_ONLY = "This server writes records only for automations.";

/**
 * One write's session over a provider. It refuses a path the version does
 * not hold now, whether it never existed or someone deleted it: a settle
 * would write the file back. It settles first what an earlier write left. Each update
 * must name an automation as its author. A completed creation key reopens
 * canonical state for the caller to inspect. Other failures or an aborted
 * signal stop further writes and settlement.
 */
async function recordSession(provider: EngineYdocProviderSession, path: string, signal: AbortSignal, reopen: () => Promise<EngineYdocProviderSession>): Promise<RecordEditSession> {
  try {
    if (provider.head === "absent") {
      throw new Error(`${path} is not a record in this server's copy of the workspace.`);
    }
    signal.throwIfAborted();
    if (provider.unsettled) await provider.settleNow({summary: `Updated ${posix.basename(path)}`});
  } catch (error) {
    await provider.evict();
    throw error;
  }
  let chain: Promise<unknown> = Promise.resolve();
  let failed = false;
  const stopped = () => failed || signal.aborted;
  return {
    applyDecidedLocalUpdate(decide, onArmed, options) {
      const turn = chain.then(async () => {
        if (failed) throw new Error(`An earlier write to ${path} failed, so this session writes nothing more.`);
        signal.throwIfAborted();
        if (options.attribution?.actorKind !== "automation" || options.actorOriginId === undefined) throw new Error(AUTOMATIONS_ONLY);
        const update = decide(provider.doc);
        if (update === null) return false;
        try {
          // This write settles once, when the caller asks.
          const journaled = provider.applyLocalUpdate(update, {...options, armSettle: false});
          onArmed();
          await journaled;
        } catch (error) {
          failed = true;
          if (isIdempotencyKeyReuseRefusal(error)) {
            // The rejected provider already applied the update locally. Reopen
            // the same object before a caller reads or settles canonical state.
            await provider.evict();
            signal.throwIfAborted();
            provider = await reopen();
            if (provider.head === "absent") throw new Error(`${path} is not a record in this server's copy of the workspace.`);
            signal.throwIfAborted();
            if (provider.unsettled) await provider.settleNow({summary: `Updated ${posix.basename(path)}`});
            failed = false;
            throw error;
          }
          throw new Error(
            `The write to ${path} may have been recorded. Retry it with the same idempotency key to find out; the key keeps a recorded write from applying twice.`,
            {cause: error},
          );
        }
        return true;
      });
      chain = turn.catch(() => undefined);
      return turn;
    },
    async settleNow(options) {
      await chain;
      if (failed) throw new Error(`An earlier write to ${path} failed, so its session does not settle.`);
      signal.throwIfAborted();
      return await provider.settleNow(options);
    },
    async close() {
      await chain;
      if (stopped()) await provider.evict();
      else await provider.close();
    },
  };
}
