import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseAppPublicationCandidate,
  type AppPublicationCandidate,
} from "@dohc/security-contract/app-publication";
import {
  parseAppBackendInvokeRequest,
  parseAppBackendUploadRequest,
} from "@dohc/security-contract/app-backend";
import { parseDatasetAttemptRequest } from "@dohc/security-contract/dataset-attempts";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import { parseDatasetRevision, type DatasetRevision } from "@dohc/security-contract/dataset";
import { isDatasetServerNotFound } from "../ipc/errorWords";
import { APP_PUBLICATION_LIMITS } from "./ownerAppPublication";
import type { LocalAppPrepared, LocalAppRow, LocalAppStore } from "./localAppStore";
import type { LocalAppAction } from "./localAppLaunch";
import type { LocalDatasetAgent } from "./localDatasetHost";
import type { createLocalDatasetApps } from "./localDatasetApps";

/** The owner's server, which holds a syncing workspace's Collections. */
export interface ServerCollectionsTransport {
  /** Creates a Collection with rules approved on this computer. The same rules again return the same Collection. */
  activate(
    input: {
      revision: DatasetRevision;
      schemaSql: string;
      operationSource: string;
      approvalAgent?: ApprovalAgent | null;
    },
    signal?: AbortSignal,
  ): Promise<DatasetRevision>;
  /** Approves the app over its Collection on the server, which checks it against the Collection's rules. */
  approve(
    candidate: AppPublicationCandidate,
    signal: AbortSignal,
  ): Promise<{ publicationId: string; authorityRevision: number }>;
  withdraw(datasetId: string, publicationId: string): Promise<void>;
  /** One of the app's requests, which the server runs as the app. */
  request(
    publicationId: string,
    action: "invoke" | "attempt" | "upload" | "file",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** The owner's server's Collection routes this computer uses, over one way to send it a request. */
export function createServerCollectionsTransport(
  workspaceId: string,
  post: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>,
): ServerCollectionsTransport {
  const workspacePath = `/sync/${encodeURIComponent(workspaceId)}`;
  const binding = (datasetId: string) =>
    `${workspacePath}/datasets/${encodeURIComponent(datasetId)}/binding`;
  return {
    async activate({ revision, schemaSql, operationSource, approvalAgent }, signal) {
      const value = await post(
        `${workspacePath}/datasets/${encodeURIComponent(revision.datasetId)}/activate`,
        { revision, schemaSql, operationSource, ...(approvalAgent ? { approvalAgent } : {}) },
        signal,
      );
      const approved = parseDatasetRevision(value);
      if (approved.revisionSha256 !== revision.revisionSha256)
        throw new Error("The server answered the Collection's creation unexpectedly.");
      return approved;
    },
    async approve(candidate, signal) {
      const capability = candidate.capabilities[0];
      if (capability?.kind !== "dataset")
        throw new Error("Choose an app connected to a Collection.");
      const value = await post(binding(capability.datasetId), { localApp: candidate }, signal);
      const { publicationId, authorityRevision } = (value ?? {}) as Record<string, unknown>;
      if (
        typeof publicationId !== "string" ||
        !/^[0-9a-f]{64}$/.test(publicationId) ||
        typeof authorityRevision !== "number" ||
        !Number.isSafeInteger(authorityRevision) ||
        authorityRevision < 1
      )
        throw new Error("The server answered the app approval unexpectedly.");
      return { publicationId, authorityRevision };
    },
    async withdraw(datasetId, publicationId) {
      await post(binding(datasetId), { publicationId, enabled: false });
    },
    request: (publicationId, action, body, signal) =>
      post(
        `${workspacePath}/app-publications/${encodeURIComponent(publicationId)}/backend/${action}`,
        body,
        signal,
      ),
  };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** How long a withdrawal that could not reach the server waits before it goes again. */
const WITHDRAWAL_RETRY_MS = 10_000;

/** Waits for `work` until `signal` stops the wait; `work` itself goes on. */
function until<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/**
 * Apps approved on this computer over Collections on the workspace's server.
 * This computer keeps each approval; the server keeps it too, and runs the
 * app's work as the app, within it. The checks here only refuse early in the
 * words this computer's store uses; the server's are the ones that hold.
 */
export function createServerDatasetApps(options: {
  store: LocalAppStore;
  workspaceId: string;
  assertCurrent(): void;
  agentRun(): LocalDatasetAgent | null;
  server: Pick<ServerCollectionsTransport, "approve" | "withdraw" | "request">;
  /** Aborts when the workspace closes. */
  lifetime: AbortSignal;
}): ReturnType<typeof createLocalDatasetApps> {
  // The server's approval revision for each app this computer approved, once the server has it.
  const approvals = new Map<string, Promise<number>>();
  const declared = (row: LocalAppRow) => {
    const capability = row.candidate.capabilities[0];
    if (capability?.kind !== "dataset") throw new Error("Invalid app approval.");
    return capability;
  };
  // Every approval of each app still on its way. An approval that arrives after a withdrawal approves the app
  // again, so a withdrawal waits for all of them.
  const approving = new Map<string, Promise<unknown>>();
  const approve = (
    publicationId: string,
    candidate: AppPublicationCandidate,
    signal: AbortSignal,
  ) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    // A request already sent can still reach the server after its caller stops waiting, so the approval waits for
    // the server's answer, and a withdrawal that waits for it reaches the server after it.
    const sent = options.server.approve(candidate, options.lifetime);
    const settled = Promise.allSettled([approving.get(publicationId), sent]);
    approving.set(publicationId, settled);
    void settled.then(() => {
      if (approving.get(publicationId) === settled) approving.delete(publicationId);
    });
    return until(sent, signal);
  };
  function current(id: string, expected?: number) {
    const row = options.store.row(id, expected);
    return { row, capability: declared(row) };
  }
  // The server learns of an approval when the app first reaches it, as after a restart.
  const serverRevision = (row: LocalAppRow, signal?: AbortSignal) => {
    let revision = approvals.get(row.publicationId);
    if (!revision) {
      revision = approve(
        row.publicationId,
        row.candidate,
        signal ?? new AbortController().signal,
      ).then((approved) => {
        if (approved.publicationId !== row.publicationId) throw new Error("Invalid app approval.");
        return approved.authorityRevision;
      });
      approvals.set(row.publicationId, revision);
      revision.catch(() => {
        if (approvals.get(row.publicationId) === revision) approvals.delete(row.publicationId);
      });
    }
    return revision;
  };
  const approvedHere = (publicationId: string) => {
    try {
      current(publicationId);
      return true;
    } catch {
      return false;
    }
  };
  // A withdrawal that cannot reach the server goes again while the workspace is open, until the server takes it
  // or this computer approves the app again.
  const withdraw = async (row: LocalAppRow) => {
    approvals.delete(row.publicationId);
    while (!options.lifetime.aborted) {
      await approving.get(row.publicationId);
      if (options.lifetime.aborted || approvedHere(row.publicationId)) return;
      try {
        await options.server.withdraw(row.resourceId, row.publicationId);
        return;
      } catch (error) {
        // The server holds no such app or Collection.
        if (isDatasetServerNotFound(error)) return;
      }
      await delay(WITHDRAWAL_RETRY_MS, undefined, { signal: options.lifetime }).catch(
        () => undefined,
      );
    }
  };
  async function send(
    publicationId: string,
    expected: number,
    action: "invoke" | "attempt" | "upload" | "file",
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const { row } = current(publicationId, expected);
    const sent = async () => {
      const authorityRevision = await serverRevision(row, signal);
      // The owner may have withdrawn the app while the server approved it.
      current(publicationId, expected);
      return options.server.request(publicationId, action, { ...body, authorityRevision }, signal);
    };
    // The server forgets an approval another of the owner's computers replaced. Nothing ran, so approve it again once,
    // unless the owner withdrew it here: that withdrawal may be what the server answered.
    const result = await sent().catch((error: unknown) => {
      if (!isDatasetServerNotFound(error)) throw error;
      signal?.throwIfAborted();
      current(publicationId, expected);
      approvals.delete(publicationId);
      return sent();
    });
    signal?.throwIfAborted();
    current(publicationId, expected);
    return result;
  }
  const operation = (publicationId: string, expected: number, name: string) =>
    current(publicationId, expected).capability.operations.find(
      (candidate) => candidate.name === name,
    );
  return {
    current,
    resolveAuthority() {
      throw new Error("App access is not permitted.");
    },
    async activate(prepared: LocalAppPrepared, signal: AbortSignal, agent?: ApprovalAgent | null) {
      options.assertCurrent();
      signal.throwIfAborted();
      const candidate = parseAppPublicationCandidate(prepared.candidate, APP_PUBLICATION_LIMITS);
      const capability = candidate.capabilities[0];
      if (capability?.kind !== "dataset")
        throw new Error("Choose an app connected to a Collection.");
      const publicationId = hash(
        JSON.stringify(["dohc-local-dataset-app-v1", options.workspaceId, candidate]),
      );
      const approved = await approve(publicationId, candidate, signal);
      if (approved.publicationId !== publicationId) throw new Error("Invalid app approval.");
      approvals.set(publicationId, Promise.resolve(approved.authorityRevision));
      return options.store.activate(
        {
          kind: "dataset",
          resourceId: capability.datasetId,
          publicationId,
          prepared,
          agent,
        },
        signal,
        (existing, _displaced, commit) => {
          commit();
          if (existing && existing.publicationId !== publicationId) void withdraw(existing);
        },
      );
    },
    withdrawBinding(value: LocalAppRow, commit: () => void) {
      commit();
      void withdraw(value);
    },
    describe(value: LocalAppRow) {
      let active = false;
      try {
        current(value.publicationId, value.authorityRevision);
        active = true;
      } catch {}
      return {
        publicationId: value.publicationId,
        authorityRevision: value.authorityRevision,
        appRoot: value.appRoot,
        sourceRevision: value.candidate.sourceRevision,
        datasetCapability: declared(value),
        approved: options.store.held(value),
        active,
      };
    },
    request(
      publicationId: string,
      action: LocalAppAction,
      raw: unknown,
      signal?: AbortSignal,
      activated = false,
    ): Promise<unknown> {
      if (action === "list" || action === "create")
        throw new Error("This app is not approved for document Collection access.");
      if (action === "attempt") {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Invalid pending submission request.");
        const { authorityRevision, operation: name, ...request } = raw as Record<string, unknown>;
        const parsed = parseDatasetAttemptRequest(request);
        const identity = parseAppBackendInvokeRequest({
          authorityRevision,
          operation: name,
          input: {},
          idempotencyKey: "attempt",
        });
        const found = operation(publicationId, identity.authorityRevision, identity.operation);
        if (!found || found.readOnly) throw new Error("This action is not approved for the app.");
        return send(
          publicationId,
          identity.authorityRevision,
          "attempt",
          { operation: identity.operation, ...parsed },
          signal,
        );
      }
      if (action === "upload") {
        const { authorityRevision, ...upload } = parseAppBackendUploadRequest(raw);
        if (
          !current(publicationId, authorityRevision).capability.operations.some(
            (candidate) => !candidate.readOnly,
          )
        )
          throw new Error("This app cannot upload files.");
        return send(publicationId, authorityRevision, "upload", upload, signal);
      }
      const { authorityRevision, ...input } = parseAppBackendInvokeRequest(raw);
      if (!operation(publicationId, authorityRevision, input.operation))
        throw new Error("This action is not approved for the app.");
      // While an agent run is active, a change is the run's, unless a person's
      // click or key press in the app started it, as dohc's bootstrap reports.
      const run = activated ? null : options.agentRun();
      return send(
        publicationId,
        authorityRevision,
        "invoke",
        {
          ...input,
          ...(run
            ? {
                agent:
                  run.agentId === undefined
                    ? { depth: run.depth }
                    : { depth: run.depth, agentId: run.agentId },
              }
            : {}),
        },
        signal,
      );
    },
    readBrowserFile(
      publicationId: string,
      raw: { authorityRevision: number; fileId: string; operation: string; input: unknown },
      signal?: AbortSignal,
    ): Promise<unknown> {
      const input = parseAppBackendInvokeRequest({
        authorityRevision: raw.authorityRevision,
        operation: raw.operation,
        input: raw.input,
        idempotencyKey: "file-read",
      });
      const found = operation(publicationId, input.authorityRevision, input.operation);
      if (
        !found?.readOnly ||
        typeof raw.fileId !== "string" ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(raw.fileId)
      )
        return Promise.reject(new Error("Choose an approved read action for this file."));
      return send(
        publicationId,
        input.authorityRevision,
        "file",
        { fileId: raw.fileId, operation: input.operation, input: input.input },
        signal,
      );
    },
  };
}
