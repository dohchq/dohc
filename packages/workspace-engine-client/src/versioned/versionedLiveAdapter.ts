import { createHash, randomUUID } from "node:crypto";
import {
  DaemonClientCapabilityError,
  DaemonProtocolError,
  DaemonRefusalError,
  WorkspaceDaemonRequester,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import type { JsonValue, WorkspaceHandle } from "../protocol";
import {
  WORKSPACE_METHOD,
  collectionResultExpectsBlob,
  decodeCollectionBlobResult,
  decodeWorkspaceResult,
  encodeCollectionQueryParams,
  type AutomationClaimNextParams,
  type AutomationClaimNextResult,
  type AutomationClaimScheduleParams,
  type AutomationClaimScheduleResult,
  type AutomationRunNowParams,
  type AutomationRunNowResult,
  type AutomationClaimSummary,
  type AutomationFailuresResult,
  type AutomationListClaimsParams,
  type AutomationListClaimsResult,
  type AutomationPressParams,
  type AutomationPressResult,
  type AutomationReleaseParams,
  type AutomationRetryParams,
  type AutomationScheduleMarksResult,
  type AutomationSettleParams,
  type AutomationSubscribeParams,
  type AutomationSubscribeResult,
  type AutomationUnsubscribeParams,
  type AutomationUnsubscribeResult,
  type AutomationReleaseGroupsResult,
  type AutomationWatchGroupsParams,
  type AutomationWatchGroupsResult,
  type CaptureFlushResult,
  type CollectionGetParams,
  type CollectionGetRecordParams,
  type CollectionGetRecordResult,
  type CollectionGetResult,
  type CollectionListPage,
  type CollectionListResult,
  type CollectionPendingAdoptionsPage,
  type CollectionPendingAdoptionsParams,
  type CollectionQueryParams,
  type CollectionQueryResult,
  type ConflictFileState,
  type ConflictListParams,
  type ConflictOpenParams,
  type ConflictOpenResult,
  type ConflictRecord,
  type ConflictResolveParams,
  type ConflictResolveResult,
  type WatcherStatusResult,
  type WorkspaceMethod,
  type WorkspaceMethodParamsMap,
  type WorkspaceMethodResultMap,
  type WorkspaceOpenParams,
} from "../workspace/workspaceWireContract";
import {
  VERSIONED_METHOD,
  decodeVersionedResult,
  type AgentAuthor,
  type WriteAuthor,
  type MomentRecord,
  type SecretCompareEntry,
  type SecretMomentRecord,
  type VersionedMethod,
  type VersionedMethodParamsMap,
  type VersionedMethodResultMap,
  type VersionedOrigin,
  type VersionedTextListEntry,
  type VersionedTextReadValue,
  type VersionRecord,
  type SourceCapture,
} from "./versionedWireContract";
import { CONFLICT_ROW_HARD_CAP_BYTES } from "./engineTextLimits";

export class VersionedAdapterCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionedAdapterCapabilityError";
  }
}

export interface AdapterWriteMetadata {
  origin: VersionedOrigin;
  summary?: string;
  correlationId?: string;
}

export interface VersionedLiveAdapterOptions {
  workspaceId: string;
  createId?: (
    kind: "conflict" | "moment" | "object" | "version",
  ) => string;
}

const CONFLICT_HYDRATION_CONCURRENCY = 8;

/**
 * The most reconstructed body text one hydrated `conflicts.list` page may
 * retain.
 *
 * Derived from the transport, not chosen: the daemon answers one
 * `conflicts.list` inside a single control frame, so any page it served with
 * bodies IN BAND is already at most `CONFLICT_ROW_HARD_CAP_BYTES`. Hydration
 * puts back only what the daemon withheld, so holding the reconstructed page
 * to the same bound keeps a caller retaining no more than the daemon itself
 * could have sent.
 *
 * The concurrency limit above does not do this job. It bounds how many blob
 * reads run at once, not how many bytes survive them — a page of 16 degraded
 * conflicts whose three sides each approach `MAX_TEXT_BYTES` is a few
 * kilobytes of withheld metadata on the wire and 480 MiB once rebuilt, which
 * then crosses Electron IPC.
 *
 * A page is cut to this budget before any body is fetched, using the
 * `byteLength` every withheld side already carries, so the bytes are never
 * transferred rather than transferred and dropped. One conflict always
 * survives the cut, or a caller could not make progress; a single conflict
 * whose three sides are each at `MAX_TEXT_BYTES` still costs 30 MiB, which is
 * the price of returning it at all.
 */
const HYDRATED_CONFLICT_PAGE_BYTE_BUDGET = CONFLICT_ROW_HARD_CAP_BYTES;

/**
 * What one conflict's three sides would retain once hydrated: the body a side
 * already carries, or the `byteLength` a withheld side promises.
 */
function hydratedConflictByteCost(conflict: ConflictRecord): number {
  let total = 0;
  for (const state of [conflict.base, conflict.current, conflict.incoming]) {
    const snapshot = state.snapshot;
    if (snapshot === null) continue;
    total += snapshot.text === null ? snapshot.byteLength : snapshot.text.length;
  }
  return total;
}
const INBAND_CONTENT_CAP_BYTES = 48 * 1024;
// JSON byte arrays are collections, so the negotiated collection bound is
// stricter than the content-size bound used by base64/blob transports.
const INBAND_BINARY_COLLECTION_CAP_BYTES = 16_384;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, values.length) },
      async () => {
        for (;;) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= values.length) return;
          results[index] = await operation(values[index]!);
        }
      },
    ),
  );
  return results;
}

export class VersionedLiveAdapter {
  readonly workspace: WorkspaceHandle;
  readonly workspaceId: string;
  private readonly requester: WorkspaceDaemonRequester;
  private readonly createId: NonNullable<
    VersionedLiveAdapterOptions["createId"]
  >;

  constructor(
    client: MinimalDaemonClient,
    workspace: WorkspaceHandle,
    options: VersionedLiveAdapterOptions,
  ) {
    if (typeof options?.workspaceId !== "string") {
      throw new VersionedAdapterCapabilityError(
        "VersionedLiveAdapter requires a workspaceId binding.",
      );
    }
    this.requester = new WorkspaceDaemonRequester(client);
    this.workspace = workspace;
    this.workspaceId = options.workspaceId;
    this.createId =
      options.createId ?? ((kind) => `${kind}-${randomUUID()}`);
  }

  static async openWorkspace(
    client: MinimalDaemonClient,
    input: WorkspaceOpenParams,
    options: Omit<VersionedLiveAdapterOptions, "workspaceId"> = {},
  ): Promise<VersionedLiveAdapter> {
    const requester = new WorkspaceDaemonRequester(client);
    const raw = await requester.request(WORKSPACE_METHOD.open, input);
    const opened = decodeWorkspaceResult(WORKSPACE_METHOD.open, raw);
    const adapter = new VersionedLiveAdapter(
      client,
      opened.workspace,
      { ...options, workspaceId: input.workspaceId },
    );
    return adapter;
  }

  async request<M extends VersionedMethod>(
    method: M,
    params: VersionedMethodParamsMap[M],
    options?: { idempotencyKey?: string; deadlineMs?: number },
  ): Promise<VersionedMethodResultMap[M]> {
    const raw = await this.requester.request(method, params, {
      workspace: this.workspace,
      ...options,
    });
    return decodeVersionedResult(method, raw);
  }

  async workspaceRequest<M extends Exclude<WorkspaceMethod, "workspace.open">>(
    method: M,
    params: WorkspaceMethodParamsMap[M],
    options?: { idempotencyKey?: string; deadlineMs?: number },
  ): Promise<WorkspaceMethodResultMap[M]> {
    if (method === WORKSPACE_METHOD.collectionsQuery) {
      return this.collectionRequest(
        method,
        encodeCollectionQueryParams(params as CollectionQueryParams),
        options,
      ) as Promise<WorkspaceMethodResultMap[M]>;
    }
    if (
      method === WORKSPACE_METHOD.collectionsGet ||
      method === WORKSPACE_METHOD.collectionsGetRecord
    ) {
      return this.collectionRequest(
        method,
        params as unknown as JsonValue,
        options,
      ) as Promise<WorkspaceMethodResultMap[M]>;
    }
    const raw = await this.requester.request(method, params as JsonValue, {
      workspace: this.workspace,
      ...options,
    });
    return decodeWorkspaceResult(method, raw);
  }

  private async collectionRequest<
    M extends
      | typeof WORKSPACE_METHOD.collectionsGet
      | typeof WORKSPACE_METHOD.collectionsQuery
      | typeof WORKSPACE_METHOD.collectionsGetRecord,
  >(
    method: M,
    params: JsonValue,
    options?: { idempotencyKey?: string; deadlineMs?: number },
  ): Promise<WorkspaceMethodResultMap[M]> {
    let delivery: Awaited<
      ReturnType<WorkspaceDaemonRequester["requestWithBlob"]>
    >;
    try {
      delivery = await this.requester.requestWithBlob(
        method,
        params,
        collectionResultExpectsBlob,
        { workspace: this.workspace, ...options },
      );
    } catch (error) {
      if (error instanceof DaemonClientCapabilityError) {
        throw new VersionedAdapterCapabilityError(error.message);
      }
      throw error;
    }
    if (!collectionResultExpectsBlob(delivery.result)) {
      return decodeWorkspaceResult(method, delivery.result);
    }
    const metadata = decodeCollectionBlobResult(delivery.result);
    if (delivery.blob === null) {
      throw new DaemonProtocolError(
        "The daemon returned blob-backed collection metadata without a completed blob.",
      );
    }
    if (delivery.blob.sha256 !== metadata.blobSha256) {
      throw new DaemonProtocolError(
        "The completed blob digest does not match the collection metadata.",
      );
    }
    if (delivery.blob.bytes.byteLength !== metadata.byteLength) {
      throw new DaemonProtocolError(
        "The completed blob length does not match the collection metadata.",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(delivery.blob.bytes);
    } catch {
      throw new DaemonProtocolError(
        "The blob-backed collection result is not valid UTF-8.",
      );
    }
    let result: JsonValue;
    try {
      result = JSON.parse(text) as JsonValue;
    } catch {
      throw new DaemonProtocolError(
        "The blob-backed collection result is not valid JSON.",
      );
    }
    return decodeWorkspaceResult(method, result);
  }

  async ensureMainVersion(input: {
    workspaceId: string;
  }): Promise<VersionRecord> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.versionsEnsureMain, {
      workspaceId: input.workspaceId,
    });
  }

  async getMainVersion(input: {
    workspaceId: string;
  }): Promise<VersionRecord | null> {
    const versions = await this.listVersions(input);
    return versions.find((version) => version.kind === "main") ?? null;
  }

  async getActiveVersion(input: {
    workspaceId: string;
  }): Promise<VersionRecord | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.versionsActive, {
      workspaceId: input.workspaceId,
    });
  }

  async setActiveVersion(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<VersionRecord> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.versionsSetActive, input);
  }

  async createNamedVersion(input: {
    workspaceId: string;
    name: string;
    fromVersionId: string;
  }): Promise<VersionRecord> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.versionsCreateNamed, input, {
      idempotencyKey: this.createId("version"),
    });
  }

  async listVersions(input: {
    workspaceId: string;
  }): Promise<VersionRecord[]> {
    this.assertWorkspace(input.workspaceId);
    const records: VersionRecord[] = [];
    let afterVersionId: string | undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.versionsList, {
        ...(afterVersionId !== undefined ? { afterVersionId } : {}),
      });
      records.push(
        ...page.versions.map((row) => ({
          id: row.versionId,
          workspaceId: input.workspaceId,
          kind: row.kind,
          name: row.name,
          createdAtMs: row.createdAtMs,
          ...(row.forkVersionId !== null
            ? {
                forkPoint: {
                  versionId: row.forkVersionId,
                  ...(row.forkMomentId !== null
                    ? { momentId: row.forkMomentId }
                    : {}),
                },
              }
            : {}),
        })),
      );
      afterVersionId = page.nextAfterVersionId ?? undefined;
    } while (afterVersionId !== undefined);
    return records;
  }

  async writeTextFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    text: string;
    createOnly?: boolean;
    requestId?: string;
    restoreBeforeMomentId?: string;
    metadata: AdapterWriteMetadata;
    author?: WriteAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedText.write"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = input.requestId ?? randomUUID();
    return this.request(
      VERSIONED_METHOD.textWrite,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
        text: input.text,
        ...(input.createOnly !== undefined ? { createOnly: input.createOnly } : {}),
        ...(input.restoreBeforeMomentId !== undefined ? { restoreBeforeMomentId: input.restoreBeforeMomentId } : {}),
        origin: input.metadata.origin,
        ...(input.metadata.summary !== undefined
          ? { summary: input.metadata.summary }
          : {}),
        ...(input.metadata.correlationId !== undefined
          ? { correlationId: input.metadata.correlationId }
          : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.momentId !== undefined ? { momentId: input.momentId } : {}),
        requestId,
      },
      { idempotencyKey: requestId },
    );
  }

  async writeBinaryFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    bytes: Uint8Array;
    metadata: AdapterWriteMetadata;
    author?: WriteAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedBinary.write"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    if (input.bytes.byteLength > INBAND_BINARY_COLLECTION_CAP_BYTES) {
      const sha256 = createHash("sha256").update(input.bytes).digest("hex");
      return this.request(
        VERSIONED_METHOD.binaryWriteBlob,
        {
          workspaceId: input.workspaceId,
          versionId: input.versionId,
          path: input.path,
          sha256,
          ...(input.metadata.origin === "restore"
            ? {}
            : { bytesBase64: Buffer.from(input.bytes).toString("base64") }),
          origin: input.metadata.origin,
          ...(input.metadata.summary !== undefined
            ? { summary: input.metadata.summary }
            : {}),
          ...(input.metadata.correlationId !== undefined
            ? { correlationId: input.metadata.correlationId }
            : {}),
          ...(input.author ? { author: input.author } : {}),
          ...(input.momentId !== undefined ? { momentId: input.momentId } : {}),
          requestId,
        },
        { idempotencyKey: requestId },
      );
    }
    return this.request(
      VERSIONED_METHOD.binaryWrite,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
        bytes: Array.from(input.bytes),
        origin: input.metadata.origin,
        ...(input.metadata.summary !== undefined
          ? { summary: input.metadata.summary }
          : {}),
        ...(input.metadata.correlationId !== undefined
          ? { correlationId: input.metadata.correlationId }
          : {}),
        ...(input.author ? { author: input.author } : {}),
        ...(input.momentId !== undefined ? { momentId: input.momentId } : {}),
        requestId,
      },
      { idempotencyKey: requestId },
    );
  }

  async readBinaryFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): Promise<Uint8Array | null> {
    this.assertWorkspace(input.workspaceId);
    let result: VersionedMethodResultMap["versionedBinary.read"];
    try {
      result = await this.request(VERSIONED_METHOD.binaryRead, {
        versionId: input.versionId,
        path: input.path,
      });
    } catch (error) {
      // Older daemon rounds exposed the domain's content-kind mismatch as an
      // INVALID_PARAMS refusal. The TypeScript store contract has always
      // treated a text-headed path as "not a binary value", exactly like an
      // absent head or missing blob, so preserve that null contract here.
      if (
        error instanceof DaemonRefusalError &&
        error.wireCode === "INVALID_PARAMS" &&
        (error.message === "text-head-not-binary" ||
          error.message === "content at path is a text head, not binary")
      ) {
        return null;
      }
      throw error;
    }
    if (result === null) return null;
    if (result.bytesBase64 !== null) {
      return this.decodeBase64(result.bytesBase64);
    }
    return this.readBinaryBlob({
      workspaceId: input.workspaceId,
      sha256: result.sha256,
    });
  }

  async readBinaryBlob(input: {
    workspaceId: string;
    sha256: string;
  }): Promise<Uint8Array | null> {
    this.assertWorkspace(input.workspaceId);
    let delivery: Awaited<
      ReturnType<WorkspaceDaemonRequester["requestWithBlob"]>
    >;
    try {
      delivery = await this.requester.requestWithBlob(
        VERSIONED_METHOD.binaryReadBlob,
        input,
        (raw) =>
          decodeVersionedResult(VERSIONED_METHOD.binaryReadBlob, raw)
            .bytesBase64 === null,
        { workspace: this.workspace },
      );
    } catch (error) {
      if (
        error instanceof DaemonRefusalError &&
        error.wireCode === "INVALID_PARAMS" &&
        error.message === "file-not-found"
      ) {
        return null;
      }
      if (error instanceof DaemonClientCapabilityError) {
        throw new VersionedAdapterCapabilityError(error.message);
      }
      throw error;
    }
    const result = decodeVersionedResult(
      VERSIONED_METHOD.binaryReadBlob,
      delivery.result,
    );
    if (result.bytesBase64 !== null) {
      return this.decodeBase64(result.bytesBase64);
    }
    if (delivery.blob === null) {
      throw new DaemonProtocolError(
        "The daemon returned out-of-band blob metadata without a completed blob.",
      );
    }
    const expectedSha256 = input.sha256.toLowerCase();
    if (delivery.blob.sha256 !== expectedSha256) {
      throw new DaemonProtocolError(
        "The completed blob digest does not match the requested binary digest.",
      );
    }
    if (
      result.byteLength !== undefined &&
      delivery.blob.bytes.byteLength !== result.byteLength
    ) {
      throw new DaemonProtocolError(
        "The completed blob length does not match the binary metadata.",
      );
    }
    return new Uint8Array(delivery.blob.bytes);
  }

  /**
   * The body behind a text digest, decoded once here so every caller of an
   * over-cap text read gets the same string. `ignoreBOM` is load-bearing: the
   * default decoder strips a leading U+FEFF, and a stripped body no longer
   * matches the `sha256`/`byteLength` the daemon recorded for it.
   */
  async readTextBlob(input: {
    workspaceId: string;
    sha256: string;
  }): Promise<string | null> {
    this.assertWorkspace(input.workspaceId);
    let delivery: Awaited<
      ReturnType<WorkspaceDaemonRequester["requestWithBlob"]>
    >;
    try {
      delivery = await this.requester.requestWithBlob(
        VERSIONED_METHOD.textReadBlob,
        input,
        (raw) =>
          decodeVersionedResult(VERSIONED_METHOD.textReadBlob, raw)
            .bytesBase64 === null,
        { workspace: this.workspace },
      );
    } catch (error) {
      if (
        error instanceof DaemonRefusalError &&
        error.wireCode === "INVALID_PARAMS" &&
        error.message === "file-not-found"
      ) {
        return null;
      }
      if (error instanceof DaemonClientCapabilityError) {
        throw new VersionedAdapterCapabilityError(error.message);
      }
      throw error;
    }
    const result = decodeVersionedResult(
      VERSIONED_METHOD.textReadBlob,
      delivery.result,
    );
    if (result.bytesBase64 !== null) {
      return this.decodeUtf8(this.decodeBase64(result.bytesBase64));
    }
    if (delivery.blob === null) {
      throw new DaemonProtocolError(
        "The daemon returned out-of-band text blob metadata without a completed blob.",
      );
    }
    const expectedSha256 = input.sha256.toLowerCase();
    if (delivery.blob.sha256 !== expectedSha256) {
      throw new DaemonProtocolError(
        "The completed blob digest does not match the requested text digest.",
      );
    }
    if (delivery.blob.bytes.byteLength !== result.byteLength) {
      throw new DaemonProtocolError(
        "The completed blob length does not match the text metadata.",
      );
    }
    return this.decodeUtf8(new Uint8Array(delivery.blob.bytes));
  }

  async readTextFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): Promise<VersionedTextReadValue | null> {
    this.assertWorkspace(input.workspaceId);
    const result = await this.request(VERSIONED_METHOD.textRead, {
      versionId: input.versionId,
      path: input.path,
    });
    if (result?.contentKind === "text" && result.text === null) {
      const text = await this.readTextBlob({
        workspaceId: input.workspaceId,
        sha256: result.blobSha256,
      });
      if (text === null) {
        throw new DaemonProtocolError(
          "The daemon could not hydrate the referenced text blob.",
        );
      }
      const { inbandLimitBytes: _inbandLimitBytes, ...metadata } = result;
      return { ...metadata, text };
    }
    return result;
  }

  async compareTextFileVersions(input: {
    workspaceId: string;
    targetVersionId: string;
    sourceVersionId: string;
    path: string;
  }): Promise<VersionedMethodResultMap["versionedText.compare"]> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.versionsCompare, {
      workspaceId: input.workspaceId,
      targetVersionId: input.targetVersionId,
      sourceVersionId: input.sourceVersionId,
      path: input.path,
    });
  }

  // One page of the daemon's whole-version comparison: differing paths with
  // status only, in path order, under the daemon's own page budget. Callers
  // hydrate the sides they need per path.
  async compareVersionFilesPage(input: {
    workspaceId: string;
    sourceVersionId: string;
    targetVersionId: string;
    afterPath?: string;
  }): Promise<{
    entries: VersionedMethodResultMap["versions.compareFiles"]["entries"];
    nextAfterPath: string | null;
  }> {
    this.assertWorkspace(input.workspaceId);
    const page = await this.request(VERSIONED_METHOD.versionsCompareFiles, {
      workspaceId: input.workspaceId,
      sourceVersionId: input.sourceVersionId,
      targetVersionId: input.targetVersionId,
      ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
    });
    return { entries: page.entries, nextAfterPath: page.nextCursor };
  }

  async mergeTextFileFromVersion(input: {
    workspaceId: string;
    targetVersionId: string;
    sourceVersionId: string;
    path: string;
    metadata: AdapterWriteMetadata;
  }): Promise<VersionedMethodResultMap["versionedText.merge"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    return this.request(
      VERSIONED_METHOD.versionsMerge,
      {
        workspaceId: input.workspaceId,
        targetVersionId: input.targetVersionId,
        sourceVersionId: input.sourceVersionId,
        path: input.path,
        origin: input.metadata.origin,
        ...(input.metadata.summary !== undefined
          ? { summary: input.metadata.summary }
          : {}),
        ...(input.metadata.correlationId !== undefined
          ? { correlationId: input.metadata.correlationId }
          : {}),
        requestId,
      },
      { idempotencyKey: requestId },
    );
  }

  // One `conflicts.list` page, passed through with the daemon's own
  // continuation. This adapter used to drain every page into one array, which
  // undid the daemon's paging for every caller at once.
  async listTextConflicts(input: {
    workspaceId: string;
    status?: "open" | "resolved";
    afterConflictId?: string;
    /**
     * `"withheld"` returns the daemon's page untouched, bodies still absent.
     * A caller that reads only ids, paths or counts asks for this: hydrating
     * for it transfers every body just to discard it.
     */
    bodies?: "hydrate" | "withheld";
  }): Promise<{
    conflicts: ConflictRecord[];
    nextAfterConflictId: string | null;
  }> {
    this.assertWorkspace(input.workspaceId);
    const params: ConflictListParams = {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.afterConflictId !== undefined
        ? { afterConflictId: input.afterConflictId }
        : {}),
    };
    const page = await this.workspaceRequest(
      WORKSPACE_METHOD.conflictsList,
      params,
    );
    if (input.bodies === "withheld") {
      return {
        conflicts: page.conflicts,
        nextAfterConflictId: page.nextAfterConflictId,
      };
    }
    // Cut the page to its byte budget before fetching anything, using the
    // `byteLength` each withheld side already carries. Sizing first means the
    // bodies past the budget are never transferred, rather than transferred
    // and then dropped. One conflict always survives, or the cursor could not
    // advance.
    const affordable: ConflictRecord[] = [];
    let retained = 0;
    for (const conflict of page.conflicts) {
      const cost = hydratedConflictByteCost(conflict);
      if (
        affordable.length > 0 &&
        retained + cost > HYDRATED_CONFLICT_PAGE_BYTE_BUDGET
      ) {
        break;
      }
      affordable.push(conflict);
      retained += cost;
    }
    // A row past the daemon's conflict row frame cap arrives with its side
    // bodies withheld. Hydrate them here — the branch `readTextFile` already
    // has — so every caller still receives full sides. Bounded over one page,
    // because this adapter passes the daemon's continuation through
    // instead of draining every page.
    const conflicts = await mapWithConcurrency(
      affordable,
      CONFLICT_HYDRATION_CONCURRENCY,
      async (conflict) => {
        // Sides in sequence, so the concurrency bound counts blob reads —
        // three parallel sides per row would triple it.
        const base = await this.hydrateConflictSide(
          input.workspaceId,
          conflict.base,
        );
        const current = await this.hydrateConflictSide(
          input.workspaceId,
          conflict.current,
        );
        const incoming = await this.hydrateConflictSide(
          input.workspaceId,
          conflict.incoming,
        );
        return base === conflict.base &&
          current === conflict.current &&
          incoming === conflict.incoming
          ? conflict
          : { ...conflict, base, current, incoming };
      },
    );
    // A page cut by the budget continues from its own last row, not the
    // daemon's — the rows dropped here have not been served yet.
    return {
      conflicts,
      nextAfterConflictId:
        affordable.length < page.conflicts.length
          ? (affordable[affordable.length - 1]?.id ?? null)
          : page.nextAfterConflictId,
    };
  }

  private async hydrateConflictSide(
    workspaceId: string,
    state: ConflictFileState,
  ): Promise<ConflictFileState> {
    const snapshot = state.snapshot;
    if (snapshot === null || snapshot.text !== null) return state;
    const text = await this.readTextBlob({
      workspaceId,
      sha256: snapshot.blobSha256,
    });
    if (text === null) {
      throw new DaemonProtocolError(
        "The daemon could not hydrate a withheld conflict side's text blob.",
      );
    }
    const { inbandLimitBytes: _inbandLimitBytes, ...metadata } = snapshot;
    return { ...state, snapshot: { ...metadata, text } };
  }

  async openTextConflict(
    input: ConflictOpenParams,
  ): Promise<ConflictOpenResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.conflictsOpen, input);
  }

  async resolveTextConflict(
    input: ConflictResolveParams,
    idempotencyKey = randomUUID(),
  ): Promise<ConflictResolveResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.conflictsResolve, input, {
      idempotencyKey,
    });
  }

  /**
   * Lists every file in the version, or only files under the folder `under`.
   * The engine orders paths bytewise, so a folder's files are one run that
   * starts after `${under}/`; the listing stops at the first path past it.
   */
  async listTextFileMetadata(input: {
    workspaceId: string;
    versionId: string;
    under?: string;
  }): Promise<VersionedTextListEntry[]> {
    this.assertWorkspace(input.workspaceId);
    const prefix = input.under === undefined ? "" : `${input.under}/`;
    const files: VersionedTextListEntry[] = [];
    let afterPath: string | undefined = prefix || undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.textList, {
        versionId: input.versionId,
        limit: 500,
        ...(afterPath !== undefined ? { afterPath } : {}),
      });
      const inside = page.files.filter((file) => file.path.startsWith(prefix));
      files.push(...inside);
      afterPath = inside.length === page.files.length ? page.nextAfterPath ?? undefined : undefined;
    } while (afterPath !== undefined);
    return files;
  }

  async captureSourceMetadata(input: {
    workspaceId: string;
    versionId: string;
    paths: readonly string[];
    bounds: { maxInputFiles: number; maxInputBytes: number };
    signal: AbortSignal;
  }): Promise<SourceCapture> {
    this.assertWorkspace(input.workspaceId);
    input.signal.throwIfAborted();
    const { workspaceId, versionId, signal } = input;
    const paths = [...input.paths];
    const bounds = { ...input.bounds };
    if (!Number.isSafeInteger(bounds.maxInputFiles) || bounds.maxInputFiles < 1 || bounds.maxInputFiles > 512 ||
        !Number.isSafeInteger(bounds.maxInputBytes) || bounds.maxInputBytes < 1 || bounds.maxInputBytes > 128 * 1024 * 1024 ||
        paths.length === 0 || paths.length > bounds.maxInputFiles || new Set(paths).size !== paths.length) {
      throw new Error("Invalid source capture bounds or paths.");
    }
    const capture = await this.request(VERSIONED_METHOD.textCaptureSources, { versionId, paths, bounds });
    signal.throwIfAborted();
    this.assertWorkspace(workspaceId);
    const expectedPaths = new Set(paths);
    let totalBytes = 0;
    for (const file of capture.files) {
      if (!expectedPaths.delete(file.path) || !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 ||
          !/^[a-f0-9]{64}$/.test(file.sha256) || !file.objectId || !file.latestMomentId) {
        throw new DaemonProtocolError("Invalid captured source identity.");
      }
      totalBytes += file.byteLength;
    }
    if (capture.workspaceId !== workspaceId || capture.versionId !== versionId || expectedPaths.size !== 0 ||
        totalBytes !== capture.totalBytes || totalBytes > bounds.maxInputBytes || !/^[a-f0-9]{64}$/.test(capture.sourceDigest)) {
      throw new DaemonProtocolError("Captured sources do not match the selected workspace, paths, or bounds.");
    }
    const digest = createHash("sha256").update(JSON.stringify([
      "dohc-source-capture-v1", workspaceId, versionId,
      capture.files.map(({ path, objectId, contentKind, sha256, byteLength, latestMomentId }) =>
        ({ path, objectId, contentKind, sha256, byteLength, latestMomentId })),
    ])).digest("hex");
    if (digest !== capture.sourceDigest) {
      throw new DaemonProtocolError("Captured source digest does not match its metadata.");
    }
    return capture;
  }

  async hydrateCapturedSources(capture: SourceCapture, signal: AbortSignal): Promise<{
    path: string; bytes: Uint8Array; sha256: string;
  }[]> {
    // Snapshot caller-owned metadata before the first asynchronous read.
    const workspaceId = capture.workspaceId;
    const files = capture.files.map((file) => ({ ...file }));
    this.assertWorkspace(workspaceId);
    signal.throwIfAborted();
    if (files.length === 0 || files.length > 512 || files.some((file) =>
      !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) ||
      files.reduce((total, file) => total + file.byteLength, 0) > 128 * 1024 * 1024) {
      throw new DaemonProtocolError("Invalid captured source hydration bounds.");
    }
    const inputs: { path: string; bytes: Uint8Array; sha256: string }[] = [];
    for (const file of files) {
      signal.throwIfAborted();
      const blob = file.contentKind === "text"
        ? await this.readTextBlob({ workspaceId, sha256: file.sha256 })
        : await this.readBinaryBlob({ workspaceId, sha256: file.sha256 });
      signal.throwIfAborted();
      this.assertWorkspace(workspaceId);
      const bytes = typeof blob === "string" ? new TextEncoder().encode(blob) : blob;
      if (bytes === null || bytes.byteLength !== file.byteLength || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
        throw new DaemonProtocolError("Captured source blob is missing or does not match its recorded bytes.");
      }
      inputs.push({ path: file.path, sha256: file.sha256, bytes });
    }
    return inputs;
  }

  async checkMove(input: { workspaceId: string; versionId: string; path: string }): Promise<void> {
    this.assertWorkspace(input.workspaceId);
    await this.request(VERSIONED_METHOD.textCheckMove, {
      versionId: input.versionId,
      path: input.path,
    });
  }

  async renameTextFile(input: {
    workspaceId: string;
    versionId: string;
    fromPath: string;
    toPath: string;
    metadata: AdapterWriteMetadata;
  }): Promise<VersionedMethodResultMap["versionedText.rename"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    return this.request(
      VERSIONED_METHOD.textRename,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        fromPath: input.fromPath,
        toPath: input.toPath,
        origin: input.metadata.origin,
        ...(input.metadata.summary !== undefined
          ? { summary: input.metadata.summary }
          : {}),
        ...(input.metadata.correlationId !== undefined
          ? { correlationId: input.metadata.correlationId }
          : {}),
        requestId,
      },
      { idempotencyKey: requestId },
    );
  }

  async deleteTextFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    expectedObjectId?: string;
    requestId?: string;
    metadata: AdapterWriteMetadata;
    author?: WriteAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedText.delete"]> {
    this.assertWorkspace(input.workspaceId);
    if (input.momentId !== undefined) {
      throw new VersionedAdapterCapabilityError(
        "versionedText.delete does not accept a caller-supplied moment id.",
      );
    }
    const requestId = input.requestId ?? randomUUID();
    return this.request(
      VERSIONED_METHOD.textDelete,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
        ...(input.expectedObjectId !== undefined ? { expectedObjectId: input.expectedObjectId } : {}),
        origin: input.metadata.origin,
        ...(input.metadata.summary !== undefined
          ? { summary: input.metadata.summary }
          : {}),
        ...(input.metadata.correlationId !== undefined
          ? { correlationId: input.metadata.correlationId }
          : {}),
        ...(input.author ? { author: input.author } : {}),
        requestId,
      },
      { idempotencyKey: requestId },
    );
  }

  async rollbackTextFileMutation(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    mutationMomentId: string;
  }): Promise<void> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    await this.request(
      VERSIONED_METHOD.textRollback,
      { ...input, requestId },
      { idempotencyKey: requestId },
    );
  }

  async listMoments(input: {
    workspaceId: string;
    versionId?: string;
    objectId?: string;
    limit?: number;
    beforeMomentOrder?: number;
  }): Promise<{
    moments: MomentRecord[];
    nextBeforeMomentOrder: number | null;
    latestMomentOrder: number;
  }> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.momentsList, {
      ...(input.versionId !== undefined ? { versionId: input.versionId } : {}),
      ...(input.objectId !== undefined ? { objectId: input.objectId } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.beforeMomentOrder !== undefined
        ? { beforeMomentOrder: input.beforeMomentOrder }
        : {}),
    });
  }

  async readHistoryPage(input: {
    workspaceId: string;
    limit?: number;
    beforeMomentOrder?: number;
  }): Promise<VersionedMethodResultMap["history.page"]> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.historyPage, {
      workspaceId: input.workspaceId,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.beforeMomentOrder !== undefined
        ? { beforeMomentOrder: input.beforeMomentOrder }
        : {}),
    });
  }

  async getMoment(input: {
    workspaceId: string;
    momentId: string;
  }): Promise<MomentRecord | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.momentsGet, {
      momentId: input.momentId,
    });
  }

  async ensureSearchIndex(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<void> {
    this.assertWorkspace(input.workspaceId);
    await this.request(VERSIONED_METHOD.searchEnsureIndex, input);
  }

  /**
   * Drains every `collections.list` page through the exclusive cursor, so
   * callers keep the full listing while each response stays frame-bounded.
   */
  async listCollections(): Promise<CollectionListResult> {
    const collections: CollectionListResult["collections"] = [];
    let cursor: string | null = null;
    do {
      const page: CollectionListPage = await this.workspaceRequest(
        WORKSPACE_METHOD.collectionsList,
        cursor === null ? {} : { cursor },
      );
      collections.push(...page.collections);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return { collections };
  }

  async listPendingCollectionAdoptions(
    input: CollectionPendingAdoptionsParams = {},
  ): Promise<CollectionPendingAdoptionsPage> {
    return this.workspaceRequest(
      WORKSPACE_METHOD.collectionsListPendingAdoptions,
      input,
    );
  }

  async getCollection(input: CollectionGetParams): Promise<CollectionGetResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.collectionsGet, input);
  }

  async queryCollectionRecords(
    input: CollectionQueryParams,
  ): Promise<CollectionQueryResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.collectionsQuery, input);
  }

  async getCollectionRecord(
    input: CollectionGetRecordParams,
  ): Promise<CollectionGetRecordResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.collectionsGetRecord, input);
  }

  /**
   * Registers one (automationId, collection path) pair with the change
   * kinds and fields it wants; a new filter replaces the pair's old one.
   */
  async subscribeAutomation(
    input: AutomationSubscribeParams,
  ): Promise<AutomationSubscribeResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsSubscribe, input);
  }

  /** Removes one exact (automationId, collection path) pair. */
  async unsubscribeAutomation(
    input: AutomationUnsubscribeParams,
  ): Promise<AutomationUnsubscribeResult> {
    return this.workspaceRequest(
      WORKSPACE_METHOD.automationsUnsubscribe,
      input,
    );
  }

  /**
   * Stops every Group subscription in the workspace from claiming, in one
   * engine write, and answers what the next automation host needs.
   */
  async releaseAutomationGroups(): Promise<AutomationReleaseGroupsResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsReleaseGroups, {});
  }

  /**
   * Sets every Group subscription this computer watches, in one engine
   * write, taking the handover a release left for it at a new host
   * generation.
   */
  async watchAutomationGroups(
    input: AutomationWatchGroupsParams,
  ): Promise<AutomationWatchGroupsResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsWatchGroups, input);
  }

  /**
   * Takes the oldest pending claim in the executor's namespace (pending ->
   * running) with its field facts, or null.
   */
  async claimNextAutomation(
    input: AutomationClaimNextParams,
  ): Promise<AutomationClaimNextResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsClaimNext, input);
  }

  /** Settles a running claim as done, or failed with its error text. */
  async settleAutomationClaim(
    input: AutomationSettleParams,
  ): Promise<AutomationClaimSummary> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsSettle, input);
  }

  /**
   * Queues a failed claim as its next run, with its facts. A pending or
   * running claim comes back unchanged; a done or chain-stopped claim is
   * refused. The engine announces a requeued claim with
   * `automation.claimed`, but that event can drop under backpressure and a
   * repeated retry announces nothing, so after this resolves the caller
   * wakes its executor's drain and re-reads `automations.failures` itself.
   */
  async retryAutomationClaim(
    input: AutomationRetryParams,
  ): Promise<AutomationClaimSummary> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsRetry, input);
  }

  /**
   * Hands back a running claim the executor cannot run yet. It is pending
   * again with its attempts as they were before `claimNext` served it, and
   * the same run. A claim that is not running is refused. The engine
   * announces nothing, so the executor drains again when what held the
   * claim clears.
   */
  async releaseAutomationClaim(
    input: AutomationReleaseParams,
  ): Promise<AutomationClaimSummary> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsRelease, input);
  }

  /**
   * Records a Button field press and answers the claim that runs it, or
   * busy while the button runs on the record for someone else. The engine
   * announces a new claim with `automation.claimed`.
   */
  async pressAutomation(input: AutomationPressParams): Promise<AutomationPressResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsPress, input);
  }

  /**
   * Claims a schedule's due times and moves its mark, in one transaction.
   * The engine announces each new claim with `automation.claimed`.
   */
  async claimAutomationSchedule(
    input: AutomationClaimScheduleParams,
  ): Promise<AutomationClaimScheduleResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsClaimSchedule, input);
  }

  /**
   * Run now from a skipped-run notice, after this computer's dismissal was
   * the notice's first. A new claim announces itself with
   * `automation.claimed`; a repeat answers the claim made before.
   */
  async runAutomationNow(input: AutomationRunNowParams): Promise<AutomationRunNowResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsRunNow, input);
  }

  /** Every schedule's mark, for the scheduler's start. */
  async listAutomationScheduleMarks(): Promise<AutomationScheduleMarksResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsScheduleMarks, {});
  }

  /** One automation's run history: its newest claims, newest first. */
  async listAutomationClaims(
    input: AutomationListClaimsParams,
  ): Promise<AutomationListClaimsResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsListClaims, input);
  }

  /**
   * Every automation with at least one failed claim: the newest error and a
   * generation the owner's notice acknowledges against.
   */
  async listAutomationFailures(): Promise<AutomationFailuresResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.automationsFailures, {});
  }

  /**
   * How many changes that did not originate on this computer the engine has
   * applied to the workspace. Record it with a decision; an equal count
   * later proves no one else's change arrived in between.
   */
  async remoteChangesApplied(): Promise<number> {
    const result = await this.workspaceRequest(
      WORKSPACE_METHOD.syncRemoteChanges,
      {},
    );
    return result.applied;
  }

  async writeSecretFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    text: string;
    metadata: AdapterWriteMetadata;
  }): Promise<{ changed: boolean; moment?: SecretMomentRecord }> {
    this.assertWorkspace(input.workspaceId);
    const result = await this.request(VERSIONED_METHOD.secretsWrite, {
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      text: input.text,
      origin: input.metadata.origin,
      momentId: this.createId("moment"),
      ...(input.metadata.summary !== undefined
        ? { summary: input.metadata.summary }
        : {}),
      ...(input.metadata.correlationId !== undefined
        ? { correlationId: input.metadata.correlationId }
        : {}),
    });
    return {
      changed: result.changed,
      ...(result.moment !== null ? { moment: result.moment } : {}),
    };
  }

  async deleteSecretFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
    metadata: AdapterWriteMetadata;
  }): Promise<{ moment: SecretMomentRecord | null }> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.secretsDelete, {
      workspaceId: input.workspaceId,
      versionId: input.versionId,
      path: input.path,
      origin: input.metadata.origin,
      momentId: this.createId("moment"),
      ...(input.metadata.summary !== undefined
        ? { summary: input.metadata.summary }
        : {}),
      ...(input.metadata.correlationId !== undefined
        ? { correlationId: input.metadata.correlationId }
        : {}),
    });
  }

  async listSecretFiles(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<
    Array<{
      workspaceId: string;
      versionId: string;
      path: string;
      byteLength: number;
      updatedAtMs: number;
      latestMomentId: string;
    }>
  > {
    this.assertWorkspace(input.workspaceId);
    const rows: Array<{
      workspaceId: string;
      versionId: string;
      path: string;
      byteLength: number;
      updatedAtMs: number;
      latestMomentId: string;
    }> = [];
    let afterPath: string | undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.secretsList, {
        versionId: input.versionId,
        limit: 500,
        ...(afterPath !== undefined ? { afterPath } : {}),
      });
      rows.push(
        ...page.secrets.map((entry) => ({
          workspaceId: input.workspaceId,
          versionId: input.versionId,
          ...entry,
        })),
      );
      afterPath = page.nextAfterPath ?? undefined;
    } while (afterPath !== undefined);
    return rows;
  }

  async secretStateExists(input: { workspaceId: string }): Promise<boolean> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.secretsStateExists, input);
  }

  async getSecretMoment(input: {
    workspaceId: string;
    momentId: string;
  }): Promise<SecretMomentRecord | null> {
    this.assertWorkspace(input.workspaceId);
    return this.request(VERSIONED_METHOD.secretsMomentsGet, input);
  }

  async forkVersion(input: {
    workspaceId: string;
    fromVersionId: string;
    toVersionId: string;
  }): Promise<void> {
    this.assertWorkspace(input.workspaceId);
    await this.request(VERSIONED_METHOD.secretsFork, input);
  }

  // One `secrets.compare` page, passed through with the daemon's own
  // continuation — the drain that put every remaining protected row on
  // one compare page lived here.
  async compareSecretFileVersions(input: {
    workspaceId: string;
    targetVersionId: string;
    sourceVersionId: string;
    afterPath?: string;
  }): Promise<{
    entries: SecretCompareEntry[];
    nextAfterPath: string | null;
  }> {
    this.assertWorkspace(input.workspaceId);
    const page = await this.request(VERSIONED_METHOD.secretsCompare, {
      workspaceId: input.workspaceId,
      targetVersionId: input.targetVersionId,
      sourceVersionId: input.sourceVersionId,
      limit: 500,
      ...(input.afterPath !== undefined ? { afterPath: input.afterPath } : {}),
    });
    return { entries: page.entries, nextAfterPath: page.nextAfterPath };
  }

  async applySecretFileFromVersion(input: {
    workspaceId: string;
    targetVersionId: string;
    sourceVersionId: string;
    path: string;
    metadata: AdapterWriteMetadata;
  }): Promise<{ changed: boolean; moment?: SecretMomentRecord }> {
    this.assertWorkspace(input.workspaceId);
    const result = await this.request(VERSIONED_METHOD.secretsApply, {
      workspaceId: input.workspaceId,
      targetVersionId: input.targetVersionId,
      sourceVersionId: input.sourceVersionId,
      path: input.path,
      origin: input.metadata.origin,
      momentId: this.createId("moment"),
      ...(input.metadata.summary !== undefined
        ? { summary: input.metadata.summary }
        : {}),
      ...(input.metadata.correlationId !== undefined
        ? { correlationId: input.metadata.correlationId }
        : {}),
    });
    return {
      changed: result.changed,
      ...(result.moment !== null ? { moment: result.moment } : {}),
    };
  }

  async restoreSecretFileToBeforeMoment(input: {
    workspaceId: string;
    momentId: string;
    metadata: AdapterWriteMetadata;
  }): Promise<VersionedMethodResultMap["secrets.restore"]> {
    this.assertWorkspace(input.workspaceId);
    const before = await this.getSecretMoment({
      workspaceId: input.workspaceId,
      momentId: input.momentId,
    });
    if (before === null) {
      throw new VersionedAdapterCapabilityError(
        `Secret moment ${input.momentId} was not found.`,
      );
    }
    return this.request(VERSIONED_METHOD.secretsRestore, {
      workspaceId: input.workspaceId,
      path: before.path,
      beforeMomentId: input.momentId,
      momentId: this.createId("moment"),
      origin: input.metadata.origin,
      ...(input.metadata.summary !== undefined
        ? { summary: input.metadata.summary }
        : {}),
      ...(input.metadata.correlationId !== undefined
        ? { correlationId: input.metadata.correlationId }
        : {}),
    });
  }

  async materializeSecretFile(input: {
    workspaceId: string;
    versionId: string;
    path: string;
  }): Promise<{ present: false } | { present: true; text: string }> {
    this.assertWorkspace(input.workspaceId);
    const result = await this.request(VERSIONED_METHOD.secretsMaterialize, {
      versionId: input.versionId,
      path: input.path,
    });
    if (result === null) return { present: false };
    if (result.text === null) {
      throw new VersionedAdapterCapabilityError(
        "The protected text exceeds the daemon's in-band response limit.",
      );
    }
    return { present: true, text: result.text };
  }

  async watcherStatus(): Promise<WatcherStatusResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.watcherStatus, {});
  }

  async flushCapture(): Promise<CaptureFlushResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.captureFlush, {});
  }

  async reconcileCapture(): Promise<CaptureFlushResult> {
    return this.workspaceRequest(WORKSPACE_METHOD.captureReconcile, {});
  }

  async setCaptureAuthor(author: AgentAuthor | null): Promise<void> {
    await this.workspaceRequest(WORKSPACE_METHOD.captureSetAuthor, { author });
  }

  async close(): Promise<void> {
    await this.workspaceRequest(WORKSPACE_METHOD.close, {});
  }

  disposeTransport(): void {
    this.requester.closeTransport();
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new VersionedAdapterCapabilityError(
        `Workspace ${workspaceId} does not match this adapter's workspace.`,
      );
    }
  }

  private assertMutationMetadataSupported(
    method: string,
    metadata: AdapterWriteMetadata,
    implicitOrigin?: VersionedOrigin,
  ): void {
    if (
      metadata.summary !== undefined ||
      metadata.correlationId !== undefined ||
      (implicitOrigin !== undefined && metadata.origin !== implicitOrigin)
    ) {
      throw new VersionedAdapterCapabilityError(
        `${method} cannot preserve the supplied mutation metadata.`,
      );
    }
  }

  private decodeBase64(value: string): Uint8Array {
    if (
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value,
      )
    ) {
      throw new VersionedAdapterCapabilityError(
        "The daemon returned invalid base64.",
      );
    }
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  private decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  }
}
