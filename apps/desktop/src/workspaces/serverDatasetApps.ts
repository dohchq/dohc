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
import {
  createLocalDatasetApps,
  datasetCapabilitiesOf,
  selectDatasetCapability,
} from "./localDatasetApps";

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
  withdraw(datasetId: string, publicationId: string, signal?: AbortSignal): Promise<void>;
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
      if (
        candidate.capabilities.length === 0 ||
        candidate.capabilities.some((capability) => capability.kind !== "dataset")
      )
        throw new Error("Choose an app connected to a Collection.");
      const capabilities = datasetCapabilitiesOf(candidate);
      const path =
        capabilities.length === 1
          ? binding(capabilities[0]!.datasetId)
          : `${workspacePath}/local-apps`;
      const value = await post(path, { localApp: candidate }, signal);
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
    async withdraw(datasetId, publicationId, signal) {
      await post(
        datasetId ? binding(datasetId) : `${workspacePath}/local-apps`,
        { publicationId, enabled: false },
        signal,
      );
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
}): ReturnType<typeof createLocalDatasetApps> & { close(): Promise<void> } {
  // The server's approval revision for each app this computer approved, once the server has it.
  const approvals = new Map<string, Promise<number>>();
  const declared = (row: LocalAppRow) => datasetCapabilitiesOf(row.candidate);
  // Each app's approvals and withdrawal on their way to the server. The server keeps whichever reaches it last, so
  // an approval and a withdrawal of the same app never go at once:
  // - `approving` holds each approval until the server has answered it and this computer has committed it or given
  //   it up. A withdrawal goes once none is left, and only if this computer has not approved the app again.
  // - `sending` is the withdrawal on its way. An approval goes once the server has answered it.
  // - While `withdrawing`, a withdrawal that failed waits to go again; `wake` sends it at once.
  interface ServerWork {
    approving: Set<Promise<unknown>>;
    sending?: Promise<void>;
    withdrawing?: boolean;
    wake?: AbortController;
  }
  const work = new Map<string, ServerWork>();
  const workOf = (publicationId: string) => {
    let found = work.get(publicationId);
    if (!found) work.set(publicationId, (found = { approving: new Set() }));
    return found;
  };
  const done = (publicationId: string, found: ServerWork) => {
    if (!found.approving.size && !found.withdrawing) work.delete(publicationId);
  };
  // Everything still on its way, which closing waits for once the lifetime has stopped it.
  const owned = new Set<Promise<unknown>>();
  const own = (task: Promise<unknown>) => {
    owned.add(task);
    void task.then(() => owned.delete(task));
  };
  const approve = <T>(
    publicationId: string,
    candidate: AppPublicationCandidate,
    signal: AbortSignal,
    then: (approved: { publicationId: string; authorityRevision: number }) => T,
  ): Promise<T> => {
    const found = workOf(publicationId);
    let sent: Promise<unknown> | undefined;
    const result = (async () => {
      const stop = AbortSignal.any([signal, options.lifetime]);
      while (found.sending) await until(found.sending, stop);
      stop.throwIfAborted();
      // A request already sent can still reach the server after its caller stops waiting, so it goes for the
      // workspace's lifetime, and counts as on its way until the server answers or the workspace closes.
      const request = options.server.approve(candidate, options.lifetime);
      sent = request;
      return then(await until(request, stop));
    })();
    const settled = () => sent && until(sent, options.lifetime);
    const finished = result.then(settled, settled).catch(() => undefined);
    found.approving.add(finished);
    own(finished);
    void finished.then(() => {
      found.approving.delete(finished);
      done(publicationId, found);
    });
    return result;
  };
  function current(id: string, expected?: number) {
    const row = options.store.row(id, expected);
    return { row, capabilities: declared(row) };
  }
  // The server learns of an approval when the app first reaches it, as after a restart.
  const serverRevision = (row: LocalAppRow, signal?: AbortSignal) => {
    let revision = approvals.get(row.publicationId);
    if (!revision) {
      revision = approve(
        row.publicationId,
        row.candidate,
        signal ?? new AbortController().signal,
        (approved) => {
          if (approved.publicationId !== row.publicationId)
            throw new Error("Invalid app approval.");
          return approved.authorityRevision;
        },
      );
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
  const withdraw = (row: LocalAppRow) => {
    approvals.delete(row.publicationId);
    const found = workOf(row.publicationId);
    if (found.withdrawing) {
      found.wake?.abort();
      return;
    }
    found.withdrawing = true;
    const lifetime = options.lifetime;
    own(
      (async () => {
        while (!lifetime.aborted) {
          while (found.approving.size) await Promise.all(found.approving);
          if (lifetime.aborted || approvedHere(row.publicationId)) break;
          const request = options.server.withdraw(row.resourceId, row.publicationId, lifetime);
          const clear = () => {
            found.sending = undefined;
          };
          found.sending = request.then(clear, clear);
          try {
            await until(request, lifetime);
            break;
          } catch (error) {
            // The server holds no such app or Collection.
            if (isDatasetServerNotFound(error)) break;
          }
          found.wake = new AbortController();
          await delay(WITHDRAWAL_RETRY_MS, undefined, {
            signal: AbortSignal.any([lifetime, found.wake.signal]),
          }).catch(() => undefined);
        }
        found.withdrawing = false;
        done(row.publicationId, found);
      })(),
    );
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
  const operation = (publicationId: string, expected: number, name: string, dataset?: string) =>
    selectDatasetCapability(current(publicationId, expected).capabilities, dataset).operations.find(
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
      if (
        candidate.capabilities.length === 0 ||
        candidate.capabilities.some((capability) => capability.kind !== "dataset")
      )
        throw new Error("Choose an app connected to a Collection.");
      const capabilities = datasetCapabilitiesOf(candidate);
      const resourceId = capabilities.length === 1 ? capabilities[0]!.datasetId : "";
      const publicationId = hash(
        JSON.stringify(["dohc-local-dataset-app-v1", options.workspaceId, candidate]),
      );
      // A withdrawal of this app waits until this computer has committed the approval or given it up.
      return approve(publicationId, candidate, signal, (approved) => {
        if (approved.publicationId !== publicationId) throw new Error("Invalid app approval.");
        approvals.set(publicationId, Promise.resolve(approved.authorityRevision));
        return options.store.activate(
          {
            kind: "dataset",
            resourceId,
            publicationId,
            prepared,
            agent,
          },
          signal,
          (existing, _displaced, commit) => {
            commit();
            if (existing && existing.publicationId !== publicationId) withdraw(existing);
          },
        );
      });
    },
    withdrawBinding(value: LocalAppRow, commit: () => void) {
      commit();
      withdraw(value);
    },
    /** Waits for the work on its way to the server, once the lifetime has stopped it. */
    async close() {
      while (owned.size) await Promise.all(owned);
    },
    describe(value: LocalAppRow) {
      let active = false;
      try {
        current(value.publicationId, value.authorityRevision);
        active = true;
      } catch {}
      const capabilities = declared(value);
      return {
        publicationId: value.publicationId,
        authorityRevision: value.authorityRevision,
        appRoot: value.appRoot,
        sourceRevision: value.candidate.sourceRevision,
        ...(capabilities.length === 1
          ? { datasetCapability: capabilities[0]! }
          : { datasetCapabilities: capabilities }),
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
        const {
          authorityRevision,
          operation: name,
          dataset,
          ...request
        } = raw as Record<string, unknown>;
        const parsed = parseDatasetAttemptRequest(request);
        const identity = parseAppBackendInvokeRequest({
          authorityRevision,
          operation: name,
          input: {},
          idempotencyKey: "attempt",
          ...(Object.hasOwn(raw, "dataset") ? { dataset } : {}),
        });
        const found = operation(
          publicationId,
          identity.authorityRevision,
          identity.operation,
          identity.dataset,
        );
        if (!found || found.readOnly) throw new Error("This action is not approved for the app.");
        return send(
          publicationId,
          identity.authorityRevision,
          "attempt",
          {
            operation: identity.operation,
            ...(identity.dataset === undefined ? {} : { dataset: identity.dataset }),
            ...parsed,
          },
          signal,
        );
      }
      if (action === "upload") {
        const { authorityRevision, ...upload } = parseAppBackendUploadRequest(raw);
        if (
          !selectDatasetCapability(
            current(publicationId, authorityRevision).capabilities,
            upload.dataset,
          ).operations.some((candidate) => !candidate.readOnly)
        )
          throw new Error("This app cannot upload files.");
        return send(publicationId, authorityRevision, "upload", upload, signal);
      }
      const { authorityRevision, ...input } = parseAppBackendInvokeRequest(raw);
      if (!operation(publicationId, authorityRevision, input.operation, input.dataset))
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
      raw: {
        authorityRevision: number;
        fileId: string;
        operation: string;
        input: unknown;
        dataset?: string;
      },
      signal?: AbortSignal,
    ): Promise<unknown> {
      const input = parseAppBackendInvokeRequest({
        authorityRevision: raw.authorityRevision,
        operation: raw.operation,
        input: raw.input,
        idempotencyKey: "file-read",
        ...(raw.dataset === undefined ? {} : { dataset: raw.dataset }),
      });
      const found = operation(
        publicationId,
        input.authorityRevision,
        input.operation,
        input.dataset,
      );
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
        {
          fileId: raw.fileId,
          operation: input.operation,
          input: input.input,
          ...(input.dataset === undefined ? {} : { dataset: input.dataset }),
        },
        signal,
      );
    },
  };
}
