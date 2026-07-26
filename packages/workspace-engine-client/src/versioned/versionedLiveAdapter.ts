import { createHash, randomUUID } from "node:crypto";
import {
  DaemonClientCapabilityError,
  DaemonProtocolError,
  DaemonRefusalError,
  WorkspaceDaemonRequester,
  type MinimalDaemonClient,
} from "../live/daemonLiveAdapter";
import type { WorkspaceHandle } from "../ydoc/generated/WorkspaceHandle";
import {
  WORKSPACE_METHOD,
  decodeWorkspaceResult,
  type CaptureFlushResult,
  type ConflictListParams,
  type ConflictOpenParams,
  type ConflictOpenResult,
  type ConflictRecord,
  type ConflictResolveParams,
  type ConflictResolveResult,
  type SearchQueryParams,
  type SearchResult,
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
} from "./versionedWireContract";

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

const LIST_TEXT_FILE_HYDRATION_CONCURRENCY = 8;
const INBAND_CONTENT_CAP_BYTES = 48 * 1024;

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
    const raw = await this.requester.request(method, params, {
      workspace: this.workspace,
      ...options,
    });
    return decodeWorkspaceResult(method, raw);
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
    metadata: AdapterWriteMetadata;
    author?: AgentAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedText.write"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    return this.request(
      VERSIONED_METHOD.textWrite,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
        text: input.text,
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
    author?: AgentAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedBinary.write"]> {
    this.assertWorkspace(input.workspaceId);
    const requestId = randomUUID();
    if (input.bytes.byteLength > INBAND_CONTENT_CAP_BYTES) {
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
      throw new VersionedAdapterCapabilityError(
        "The text body exceeds the daemon's in-band response limit.",
      );
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

  async listTextConflicts(input: {
    workspaceId: string;
    status?: "open" | "resolved";
  }): Promise<ConflictRecord[]> {
    this.assertWorkspace(input.workspaceId);
    const params: ConflictListParams = {
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    return this.workspaceRequest(WORKSPACE_METHOD.conflictsList, params);
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

  async listTextFiles(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<VersionedTextReadValue[]> {
    this.assertWorkspace(input.workspaceId);
    const metadata = await this.listTextFileMetadata(input);
    const snapshots = await mapWithConcurrency(
      metadata,
      LIST_TEXT_FILE_HYDRATION_CONCURRENCY,
      async (row) =>
        await this.readTextFile({
          workspaceId: input.workspaceId,
          versionId: input.versionId,
          path: row.path,
        }),
    );
    return snapshots.filter(
      (snapshot): snapshot is VersionedTextReadValue => snapshot !== null,
    );
  }

  async listTextFileMetadata(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<VersionedTextListEntry[]> {
    this.assertWorkspace(input.workspaceId);
    const files: VersionedTextListEntry[] = [];
    let afterPath: string | undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.textList, {
        versionId: input.versionId,
        limit: 500,
        ...(afterPath !== undefined ? { afterPath } : {}),
      });
      files.push(...page.files);
      afterPath = page.nextAfterPath ?? undefined;
    } while (afterPath !== undefined);
    return files;
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
    metadata: AdapterWriteMetadata;
    author?: AgentAuthor | null;
    momentId?: string;
  }): Promise<VersionedMethodResultMap["versionedText.delete"]> {
    this.assertWorkspace(input.workspaceId);
    if (input.momentId !== undefined) {
      throw new VersionedAdapterCapabilityError(
        "versionedText.delete does not accept a caller-supplied moment id.",
      );
    }
    const requestId = randomUUID();
    return this.request(
      VERSIONED_METHOD.textDelete,
      {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.path,
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
    legacyBeforeText?: string;
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

  async querySearch(input: SearchQueryParams): Promise<SearchResult[]> {
    return this.workspaceRequest(WORKSPACE_METHOD.searchQuery, input);
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

  async listSecretMoments(input: {
    workspaceId: string;
    versionId?: string;
  }): Promise<SecretMomentRecord[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: SecretMomentRecord[] = [];
    let beforeMomentOrder: number | undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.secretsMomentsList, {
        workspaceId: input.workspaceId,
        ...(input.versionId !== undefined
          ? { versionId: input.versionId }
          : {}),
        limit: 500,
        ...(beforeMomentOrder !== undefined ? { beforeMomentOrder } : {}),
      });
      rows.push(...page.moments);
      beforeMomentOrder = page.nextBeforeMomentOrder ?? undefined;
    } while (beforeMomentOrder !== undefined);
    return rows;
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

  async compareSecretFileVersions(input: {
    workspaceId: string;
    targetVersionId: string;
    sourceVersionId: string;
  }): Promise<SecretCompareEntry[]> {
    this.assertWorkspace(input.workspaceId);
    const rows: SecretCompareEntry[] = [];
    let afterPath: string | undefined;
    do {
      const page = await this.request(VERSIONED_METHOD.secretsCompare, {
        workspaceId: input.workspaceId,
        targetVersionId: input.targetVersionId,
        sourceVersionId: input.sourceVersionId,
        limit: 500,
        ...(afterPath !== undefined ? { afterPath } : {}),
      });
      rows.push(...page.entries);
      afterPath = page.nextAfterPath ?? undefined;
    } while (afterPath !== undefined);
    return rows;
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
}
