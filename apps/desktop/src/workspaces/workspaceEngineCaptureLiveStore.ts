import {
  VersionedTextStoreError,
  type ActorNeutralWriteMetadata,
  type FileObjectRecord,
  type MomentAuthor,
  type SecretFileMoment,
  type SecretFileStore,
  type TextFileSnapshot,
  type VersionedTextFileState,
  type VersionedTextMoment,
  type VersionedTextMomentSummary,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import {
  VersionedLiveAdapter,
  type AgentAuthor,
  type ConflictFileState,
  type ConflictRecord,
  type MomentRecord,
  type SecretMomentRecord,
  type VersionedComparisonRecord,
  type VersionedTextListEntry,
  type VersionedTextReadValue,
} from "@dohc/workspace-engine-client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  EngineWorkspaceSessions,
  type EngineWorkspace,
  type EngineWorkspaceBinding,
} from "@dohc/workspace-engine-client/daemon";

// A manifest rebuild after a version switch costs ONE unsettled pass, so this
// budget is generous by two orders of magnitude. It is bounded rather than
// unbounded because a workspace under genuinely continuous mutation can keep
// missing quiescence, and that must still surface as an error rather than hang.
const FLUSH_SETTLE_ATTEMPTS = 50;
const FLUSH_SETTLE_POLL_MS = 20;

export interface CaptureTextFileMetadata {
  path: string;
  objectId: string;
  contentKind: "text" | "binary";
  byteLength: number | null;
  sha256: string | null;
  updatedAtMs: number;
  latestMomentId: string;
  // Is this path owned by the Y.Doc editor? Reconciliation must not retire a
  // Y.Doc-owned record for being un-ownable content: a settled Y.Doc is
  // bounded by nothing, while ordinary captured text is capped.
  hasYdocMarker: boolean;
}

export type CaptureVersionedTextStore = VersionedTextStore & {
  listTextFileMetadata?(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<CaptureTextFileMetadata[]>;
  flushCapture?(): Promise<void>;
  watcherStatus?(): Promise<{
    running: boolean;
    degraded: boolean;
    terminal: boolean;
  }>;
  setCaptureAuthor?(author: MomentAuthor | null): Promise<void>;
};

export interface CaptureLiveStores {
  store: CaptureVersionedTextStore;
  secretStore: SecretFileStore;
}

function metadataFromOrigin(
  origin: string,
  supplied?: ActorNeutralWriteMetadata,
): ActorNeutralWriteMetadata {
  return {
    origin: publicOrigin(origin),
    ...(supplied?.summary !== undefined ? { summary: supplied.summary } : {}),
    ...(supplied?.correlationId !== undefined
      ? { correlationId: supplied.correlationId }
      : {}),
  };
}

function publicOrigin(origin: string): ActorNeutralWriteMetadata["origin"] {
  switch (origin) {
    case "api":
    case "local-file":
    case "restore":
    case "sync":
    case "unknown":
      return origin;
    case "capture":
      return "local-file";
    default:
      return "unknown";
  }
}

function snapshotFromWire(
  value: VersionedTextReadValue,
  metadata?: ActorNeutralWriteMetadata,
): TextFileSnapshot {
  if (value.contentKind === "text" && value.text === null) {
    throw new Error(`Engine text body for ${value.path} exceeds the RPC in-band limit.`);
  }
  return {
    objectId: value.objectId,
    versionId: value.versionId,
    path: value.path,
    contentKind: value.contentKind,
    sha256: value.sha256,
    byteLength: value.byteLength,
    text: value.text ?? "",
    updatedAtMs: value.updatedAtMs,
    latestMomentId: value.latestMomentId,
    metadata: metadataFromOrigin(value.metadataOrigin, {
      origin: publicOrigin(value.metadataOrigin),
      ...(value.metadataSummary != null
        ? { summary: value.metadataSummary }
        : {}),
      ...(value.metadataCorrelationId != null
        ? { correlationId: value.metadataCorrelationId }
        : {}),
      ...metadata,
    }),
  };
}

function authorFromWire(author: MomentRecord["author"]): MomentAuthor | undefined {
  if (author === null) return undefined;
  if ("corrupt" in author) {
    throw new VersionedTextStoreError(
      "state-corrupt",
      "Engine moment contains corrupt author provenance.",
    );
  }
  return {
    kind: "agent",
    agentId: author.agentId,
    onBehalfOf: author.onBehalfOf,
    ...(author.agentRunId !== undefined
      ? { agentRunId: author.agentRunId }
      : {}),
  };
}

function payloadSnapshot(
  moment: MomentRecord,
  side: "before" | "after",
): VersionedTextMoment["payload"]["after"] {
  const before = side === "before";
  const contentKind = before
    ? moment.beforeContentKind
    : moment.afterContentKind;
  const text = before ? moment.beforeText : moment.afterText;
  if (contentKind === "text" && text === null) {
    const limit = before
      ? moment.beforeInbandLimitBytes
      : moment.afterInbandLimitBytes;
    throw new Error(
      `Engine moment text for ${moment.path} exceeds the RPC in-band limit${
        limit === undefined ? "" : ` (${limit} bytes)`
      }.`,
    );
  }
  const sha256 =
    contentKind === "binary"
      ? before
        ? moment.beforeBinarySha256
        : moment.afterBinarySha256
      : before
        ? moment.beforeBlobSha256
        : moment.afterBlobSha256;
  const byteLength = before ? moment.beforeByteLength : moment.afterByteLength;
  return {
    path: before ? (moment.beforePath ?? moment.path) : moment.path,
    contentKind,
    ...(sha256 !== null ? { sha256 } : {}),
    ...(byteLength !== null ? { byteLength } : {}),
    text: contentKind === "binary" ? "" : (text ?? ""),
  };
}

function momentFromWire(
  workspaceId: string,
  moment: MomentRecord,
  suppliedMetadata?: ActorNeutralWriteMetadata,
): VersionedTextMoment {
  const author = authorFromWire(moment.author);
  const before = moment.beforePresent
    ? payloadSnapshot(moment, "before")
    : null;
  return {
    id: moment.momentId,
    workspaceId,
    versionId: moment.versionId,
    objectId: moment.objectId,
    path: moment.path,
    recordedAtMs: moment.recordedAtMs,
    operation: moment.operation,
    payload: {
      before,
      // The engine's delete wire record has no post-delete content fields,
      // while the oracle deliberately repeats the deleted snapshot in
      // payload.after. Reconstruct that compatibility shape from the atomic
      // preimage carried by the same mutation response.
      after:
        moment.operation === "delete" && before !== null
          ? { ...before }
          : payloadSnapshot(moment, "after"),
    },
    metadata: metadataFromOrigin(moment.metadataOrigin, {
      origin: publicOrigin(moment.metadataOrigin),
      ...(moment.metadataSummary != null
        ? { summary: moment.metadataSummary }
        : {}),
      ...(moment.metadataCorrelationId != null
        ? { correlationId: moment.metadataCorrelationId }
        : {}),
      ...suppliedMetadata,
    }),
    ...(author !== undefined ? { author } : {}),
    ...(moment.syncRecordOnly ? { syncRecordOnly: true } : {}),
  };
}

function momentSummaryFromWire(
  workspaceId: string,
  moment: MomentRecord,
): VersionedTextMomentSummary {
  const author = authorFromWire(moment.author);
  return {
    id: moment.momentId,
    workspaceId,
    versionId: moment.versionId,
    objectId: moment.objectId,
    path: moment.path,
    recordedAtMs: moment.recordedAtMs,
    operation: moment.operation,
    contentKind: moment.afterContentKind,
    ...(moment.afterByteLength !== null
      ? { byteLength: moment.afterByteLength }
      : {}),
    metadata: metadataFromOrigin(moment.metadataOrigin, {
      origin: publicOrigin(moment.metadataOrigin),
      ...(moment.metadataSummary != null
        ? { summary: moment.metadataSummary }
        : {}),
      ...(moment.metadataCorrelationId != null
        ? { correlationId: moment.metadataCorrelationId }
        : {}),
    }),
    ...(author !== undefined ? { author } : {}),
    momentOrder: moment.momentOrder,
    ...(moment.syncRecordOnly ? { syncRecordOnly: true } : {}),
  };
}

function conflictFromWire(conflict: ConflictRecord) {
  return {
    ...conflict,
    base: conflictStateFromWire(conflict.base),
    current: conflictStateFromWire(conflict.current),
    incoming: conflictStateFromWire(conflict.incoming),
    metadata: metadataFromOrigin(conflict.metadata.origin, {
      origin: publicOrigin(conflict.metadata.origin),
      ...(conflict.metadata.summary !== null
        ? { summary: conflict.metadata.summary }
        : {}),
      ...(conflict.metadata.correlationId !== null
        ? { correlationId: conflict.metadata.correlationId }
        : {}),
    }),
    ...(conflict.resolution !== null
      ? { resolution: conflict.resolution }
      : {}),
  };
}

function conflictStateFromWire(state: ConflictFileState): VersionedTextFileState {
  const snapshot = state.snapshot;
  if (snapshot === null) {
    if (state.contentKind === "binary" && state.binarySha256 !== null) {
      return {
        exists: true,
        path: state.path,
        contentKind: "binary",
        sha256: state.binarySha256,
        ...(state.binaryByteLength !== null
          ? { byteLength: state.binaryByteLength }
          : {}),
        ...(state.binaryObjectId !== null
          ? { objectId: state.binaryObjectId }
          : {}),
        ...(state.binaryLatestMomentId !== null
          ? { latestMomentId: state.binaryLatestMomentId }
          : {}),
      };
    }
    return {
      exists: false,
      path: state.path,
      contentKind: state.contentKind,
    };
  }
  return {
    exists: true,
    path: snapshot.path,
    objectId: snapshot.objectId,
    contentKind: state.contentKind,
    sha256: snapshot.sha256,
    byteLength: snapshot.byteLength,
    ...(state.contentKind === "text" ? { text: snapshot.text } : {}),
    updatedAtMs: snapshot.updatedAtMs,
    latestMomentId: snapshot.latestMomentId,
    metadata: metadataFromOrigin(snapshot.metadataOrigin, {
      origin: publicOrigin(snapshot.metadataOrigin),
      ...(state.metadataSummary !== null
        ? { summary: state.metadataSummary }
        : {}),
      ...(state.metadataCorrelationId !== null
        ? { correlationId: state.metadataCorrelationId }
        : {}),
    }),
  };
}

function secretMomentFromWire(moment: SecretMomentRecord): SecretFileMoment {
  return {
    ...moment,
    metadata: metadataFromOrigin(moment.metadata.origin, {
      origin: publicOrigin(moment.metadata.origin),
      ...(moment.metadata.summary !== null
        ? { summary: moment.metadata.summary }
        : {}),
      ...(moment.metadata.correlationId !== null
        ? { correlationId: moment.metadata.correlationId }
        : {}),
    }),
  };
}

function comparisonFromWire(
  comparison: VersionedComparisonRecord,
) {
  const state = (
    value: VersionedTextReadValue | null,
  ): VersionedTextFileState => {
    if (value === null) return { exists: false, path: comparison.path };
    if (value.contentKind === "text" && value.text === null) {
      throw new Error(
        `Engine comparison text for ${value.path} exceeds the RPC in-band limit.`,
      );
    }
    return {
      exists: true,
      path: value.path,
      objectId: value.objectId,
      contentKind: value.contentKind,
      ...(value.sha256 !== null ? { sha256: value.sha256 } : {}),
      ...(value.byteLength !== null ? { byteLength: value.byteLength } : {}),
      text: value.text ?? "",
      updatedAtMs: value.updatedAtMs,
      latestMomentId: value.latestMomentId,
      metadata: metadataFromOrigin(value.metadataOrigin, {
        origin: publicOrigin(value.metadataOrigin),
        ...(value.metadataSummary != null
          ? { summary: value.metadataSummary }
          : {}),
        ...(value.metadataCorrelationId != null
          ? { correlationId: value.metadataCorrelationId }
          : {}),
      }),
    };
  };
  return {
    workspaceId: comparison.workspaceId,
    path: comparison.path,
    targetVersionId: comparison.targetVersionId,
    sourceVersionId: comparison.sourceVersionId,
    base: state(comparison.base),
    current: state(comparison.current),
    incoming: state(comparison.incoming),
    status: comparison.status,
  };
}

function fileObjectFromWire(value: unknown): FileObjectRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Engine mutation returned an invalid file object.");
  }
  const object = value as Record<string, unknown>;
  if (
    typeof object.id !== "string" ||
    typeof object.workspaceId !== "string" ||
    typeof object.createdAtMs !== "number"
  ) {
    throw new Error("Engine mutation returned an invalid file object.");
  }
  return {
    id: object.id,
    workspaceId: object.workspaceId,
    createdAtMs: object.createdAtMs,
  };
}

function adapterMetadata(metadata: ActorNeutralWriteMetadata) {
  return {
    origin: metadata.origin,
    ...(metadata.summary !== undefined ? { summary: metadata.summary } : {}),
    ...(metadata.correlationId !== undefined
      ? { correlationId: metadata.correlationId }
      : {}),
  };
}

function adapterAuthor(author: MomentAuthor): AgentAuthor {
  return {
    kind: "agent",
    agentId: author.agentId,
    onBehalfOf: author.onBehalfOf,
    ...(author.agentRunId !== undefined
      ? { agentRunId: author.agentRunId }
      : {}),
  };
}

export function createCaptureLiveStores(
  workspace: EngineWorkspace,
  sessions: EngineWorkspaceSessions,
): CaptureLiveStores {
  const adapters = new WeakMap<object, Map<string, VersionedLiveAdapter>>();
  sessions.rememberCaptureAuthor(workspace.workspaceId, null);

  function adapterFor(binding: EngineWorkspaceBinding): VersionedLiveAdapter {
    const clientKey = binding.client as object;
    let byHandle = adapters.get(clientKey);
    if (!byHandle) {
      byHandle = new Map();
      adapters.set(clientKey, byHandle);
    }
    let adapter = byHandle.get(binding.workspace);
    if (!adapter) {
      adapter = new VersionedLiveAdapter(binding.client, binding.workspace, {
        workspaceId: workspace.workspaceId,
      });
      byHandle.set(binding.workspace, adapter);
    }
    return adapter;
  }

  async function runRead<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await sessions.run(
      workspace,
      async (binding) => await operation(adapterFor(binding)),
      { retryTransportErrors: true },
    );
  }

  async function runMutation<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await sessions.run(
      workspace,
      async (binding) => await operation(adapterFor(binding)),
    );
  }

  const store = {
    ensureMainVersion: (input: { workspaceId: string }) =>
      runMutation(async (adapter) => await adapter.ensureMainVersion(input)),
    getMainVersion: (input: { workspaceId: string }) =>
      runRead(async (adapter) => await adapter.getMainVersion(input)),
    getActiveVersion: (input: { workspaceId: string }) =>
      runRead(async (adapter) => await adapter.getActiveVersion(input)),
    setActiveVersion: (input: { workspaceId: string; versionId: string }) =>
      runMutation(async (adapter) => await adapter.setActiveVersion(input)),
    createNamedVersion: (input: {
      workspaceId: string;
      name: string;
      fromVersionId: string;
    }) => runMutation(async (adapter) => await adapter.createNamedVersion(input)),
    listVersions: (input: { workspaceId: string }) =>
      runRead(async (adapter) => await adapter.listVersions(input)),

    async readTextFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
    }) {
      const value = await runRead(async (adapter) => await adapter.readTextFile(input));
      return value === null ? null : snapshotFromWire(value);
    },

    async listTextFileMetadata(input: {
      workspaceId: string;
      versionId: string;
    }): Promise<CaptureTextFileMetadata[]> {
      const rows = await runRead(
        async (adapter) => await adapter.listTextFileMetadata(input),
      );
      return rows.map((row: VersionedTextListEntry) => ({
        path: row.path,
        objectId: row.objectId,
        contentKind: row.contentKind,
        byteLength: row.byteLength,
        sha256: row.sha256,
        updatedAtMs: row.updatedAtMs,
        latestMomentId: row.latestMomentId,
        hasYdocMarker: row.hasYdocMarker,
      }));
    },

    async listTextFiles(input: {
      workspaceId: string;
      versionId: string;
    }) {
      const values = await runRead(
        async (adapter) => await adapter.listTextFiles(input),
      );
      return values.map((value) => snapshotFromWire(value));
    },

    async writeTextFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
      text: string;
      metadata: ActorNeutralWriteMetadata;
      author?: MomentAuthor;
      momentId?: string;
    }) {
      const { metadata, author, ...writeInput } = input;
      const raw = await runMutation(
        async (adapter) =>
          await adapter.writeTextFile({
            ...writeInput,
            ...(author ? { author: adapterAuthor(author) } : {}),
            metadata: adapterMetadata(metadata),
          }),
      );
      return {
        object: raw.object,
        snapshot: snapshotFromWire(raw.snapshot, input.metadata),
        moment: momentFromWire(input.workspaceId, raw.moment, input.metadata),
      };
    },

    async writeBinaryFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
      bytes: Uint8Array;
      metadata: ActorNeutralWriteMetadata;
      author?: MomentAuthor;
      momentId?: string;
    }) {
      const { metadata, author, ...writeInput } = input;
      const raw = await runMutation(
        async (adapter) =>
          await adapter.writeBinaryFile({
            ...writeInput,
            ...(author ? { author: adapterAuthor(author) } : {}),
            metadata: adapterMetadata(metadata),
          }),
      );
      const value: VersionedTextReadValue = {
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        objectId: raw.snapshot.objectId,
        path: raw.snapshot.path,
        contentKind: "binary",
        text: "",
        sha256: raw.snapshot.sha256,
        blobSha256: raw.snapshot.sha256,
        byteLength: raw.snapshot.byteLength,
        updatedAtMs: raw.snapshot.updatedAtMs,
        latestMomentId: raw.snapshot.latestMomentId,
        metadataOrigin: input.metadata.origin,
      };
      return {
        object: raw.object,
        snapshot: snapshotFromWire(value, input.metadata),
        moment: momentFromWire(input.workspaceId, raw.moment, input.metadata),
      };
    },

    readBinaryFile: (input: {
      workspaceId: string;
      versionId: string;
      path: string;
    }) => runRead(async (adapter) => await adapter.readBinaryFile(input)),
    readBinaryBlob: (input: { workspaceId: string; sha256: string }) =>
      runRead(async (adapter) => await adapter.readBinaryBlob(input)),

    async deleteTextFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
      metadata: ActorNeutralWriteMetadata;
      author?: MomentAuthor;
      momentId?: string;
    }) {
      const { metadata, author, ...deleteInput } = input;
      const raw = await runMutation(
        async (adapter) =>
          await adapter.deleteTextFile({
            ...deleteInput,
            ...(author ? { author: adapterAuthor(author) } : {}),
            metadata: adapterMetadata(metadata),
          }),
      );
      if (!raw.moment.beforePresent) {
        throw new VersionedTextStoreError(
          "state-corrupt",
          `Engine delete result for ${input.path} has no preimage.`,
        );
      }
      const beforePayload = payloadSnapshot(raw.moment, "before");
      const wireBefore: VersionedTextReadValue =
        raw.before.contentKind === "text"
          ? {
              ...raw.before,
              contentKind: "text",
              blobSha256: raw.before.sha256,
              text: beforePayload.text,
            }
          : {
              ...raw.before,
              contentKind: "binary",
              blobSha256: raw.before.sha256,
              text: "",
            };
      const before = snapshotFromWire(wireBefore, input.metadata);
      return {
        object: raw.object,
        before,
        moment: momentFromWire(input.workspaceId, raw.moment, input.metadata),
      };
    },

    async renameTextFile(input: {
      workspaceId: string;
      versionId: string;
      fromPath: string;
      toPath: string;
      metadata: ActorNeutralWriteMetadata;
    }) {
      const before = await store.readTextFile({
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.fromPath,
      });
      if (!before) {
        throw new Error(`Engine text head for ${input.fromPath} disappeared before rename.`);
      }
      const raw = await runMutation(
        async (adapter) =>
          await adapter.renameTextFile({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      );
      const after = await store.readTextFile({
        workspaceId: input.workspaceId,
        versionId: input.versionId,
        path: input.toPath,
      });
      if (!after) {
        throw new Error(`Engine text head for ${input.toPath} disappeared after rename.`);
      }
      return {
        object: raw.object,
        before,
        after,
        moment: momentFromWire(input.workspaceId, raw.moment, input.metadata),
      };
    },

    rollbackTextFileMutation: (input: {
      workspaceId: string;
      versionId: string;
      path: string;
      mutationMomentId: string;
      legacyBeforeText?: string;
    }) =>
      runMutation(
        async (adapter) => await adapter.rollbackTextFileMutation(input),
      ),

    async listMoments(input: {
      workspaceId: string;
      versionId?: string;
      objectId?: string;
      limit?: number;
      beforeMomentOrder?: number;
    }) {
      const page = await runRead(async (adapter) => await adapter.listMoments(input));
      return {
        ...page,
        moments: page.moments.map((moment) =>
          momentSummaryFromWire(input.workspaceId, moment),
        ),
      };
    },

    async getMoment(input: { workspaceId: string; momentId: string }) {
      const moment = await runRead(async (adapter) => await adapter.getMoment(input));
      return moment === null
        ? null
        : momentFromWire(input.workspaceId, moment);
    },

    async compareTextFileVersions(input: {
      workspaceId: string;
      targetVersionId: string;
      sourceVersionId: string;
      path: string;
    }) {
      const result = await runRead(
        async (adapter) => await adapter.compareTextFileVersions(input),
      );
      return comparisonFromWire(result);
    },

    async listTextConflicts(input: {
      workspaceId: string;
      status?: "open" | "resolved";
    }) {
      const conflicts = await runRead(
        async (adapter) => await adapter.listTextConflicts(input),
      );
      return conflicts.map(conflictFromWire);
    },

    async mergeTextFileFromVersion(input: {
      workspaceId: string;
      targetVersionId: string;
      sourceVersionId: string;
      path: string;
      metadata: ActorNeutralWriteMetadata;
    }) {
      const before = await store.readTextFile({
        workspaceId: input.workspaceId,
        versionId: input.targetVersionId,
        path: input.path,
      });
      const raw = await runMutation(
        async (adapter) =>
          await adapter.mergeTextFileFromVersion({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      );
      const comparison = comparisonFromWire(raw.comparison);
      if (raw.status === "unchanged") {
        return {
          kind: "unchanged",
          reason: raw.reason ?? "already-same",
          comparison,
        };
      }
      if (raw.status === "conflict") {
        const conflicts = await store.listTextConflicts({
          workspaceId: input.workspaceId,
          status: "open",
        });
        const conflict = conflicts.find((entry) => entry.id === raw.conflictId);
        if (!conflict) throw new Error(`Engine conflict for ${input.path} was not returned.`);
        return { kind: "conflict", comparison, conflict };
      }
      if (raw.writeKind === "write") {
        const snapshot = await store.readTextFile({
          workspaceId: input.workspaceId,
          versionId: input.targetVersionId,
          path: input.path,
        });
        if (!snapshot) throw new Error(`Merged engine head for ${input.path} is absent.`);
        return {
          kind: "merged",
          operation: "write",
          comparison,
          write: {
            object: raw.object,
            snapshot,
            moment: momentFromWire(
              input.workspaceId,
              raw.moment as MomentRecord,
              input.metadata,
            ),
          },
        };
      }
      if (!before) throw new Error(`Deleted merge preimage for ${input.path} is absent.`);
      return {
        kind: "merged",
        operation: "delete",
        comparison,
        delete: {
          object: raw.object,
          before,
          moment: momentFromWire(
            input.workspaceId,
            raw.moment as MomentRecord,
            input.metadata,
          ),
        },
      };
    },

    async resolveTextConflict(input: {
      workspaceId: string;
      conflictId: string;
      resolution:
        | { kind: "keep-current" }
        | { kind: "apply-incoming" }
        | { kind: "apply-merged"; text: string };
      metadata: ActorNeutralWriteMetadata;
    }) {
      const open = await store.listTextConflicts({
        workspaceId: input.workspaceId,
        status: "open",
      });
      const existing = open.find((conflict) => conflict.id === input.conflictId);
      if (!existing) throw new Error(`Engine conflict ${input.conflictId} was not found.`);
      const raw = await runMutation(
        async (adapter) =>
          await adapter.resolveTextConflict({
            local: {
              conflictId: input.conflictId,
              resolution: input.resolution.kind,
              ...(input.resolution.kind === "apply-merged"
                ? { mergedText: input.resolution.text }
                : {}),
              objectId: `object-${randomUUID()}`,
              writeMomentId: `moment-${randomUUID()}`,
              deleteMomentId: `moment-${randomUUID()}`,
              metadataOrigin: input.metadata.origin,
              ...(input.metadata.summary !== undefined
                ? { metadataSummary: input.metadata.summary }
                : {}),
              ...(input.metadata.correlationId !== undefined
                ? { metadataCorrelationId: input.metadata.correlationId }
                : {}),
            },
          }),
      );
      if (!("conflict" in raw)) {
        throw new Error(`Engine conflict ${input.conflictId} was not resolved locally.`);
      }
      const conflict = conflictFromWire(raw.conflict as ConflictRecord);
      if (raw.write !== null) {
        const write = raw.write as {
          object: unknown;
          snapshot: VersionedTextReadValue;
          moment: MomentRecord;
        };
        return {
          kind: "resolved",
          conflict,
          write: {
            object: fileObjectFromWire(write.object),
            snapshot: snapshotFromWire(write.snapshot, input.metadata),
            moment: momentFromWire(
              input.workspaceId,
              write.moment,
              input.metadata,
            ),
          },
        };
      }
      if (raw.delete !== null) {
        const deletion = raw.delete as {
          object: unknown;
          before: VersionedTextReadValue;
          moment: MomentRecord;
        };
        return {
          kind: "resolved",
          conflict,
          delete: {
            object: fileObjectFromWire(deletion.object),
            before: snapshotFromWire(deletion.before, input.metadata),
            moment: momentFromWire(
              input.workspaceId,
              deletion.moment,
              input.metadata,
            ),
          },
        };
      }
      return { kind: "resolved", conflict };
    },

    async flushCapture() {
      // `settled: false` is not an error. The daemon documents it as "state
      // not comparable" — a layer down, a teardown race, or a workspace under
      // continuous mutation — and expects the caller to poll. Every Rust-side
      // consumer does (`flush_until_settled`); this one threw on the first
      // unsettled answer.
      //
      // That made a normal sequence fail in the user's face. A version switch
      // whose pre-switch reconcile saw change calls `request_manifest_refresh`,
      // which bumps the driver's refresh epoch, so the next pass classifies the
      // layer as PolicyChanged and drops it to rebuild the manifest — one
      // deliberate unsettled pass, `running: false` with `degraded: false`.
      // A second switch straight after the first therefore threw
      // "did not settle" at whoever asked for it.
      let outcome = await runRead(async (adapter) => await adapter.flushCapture());
      for (
        let attempt = 0;
        !outcome.settled && attempt < FLUSH_SETTLE_ATTEMPTS;
        attempt += 1
      ) {
        await delay(FLUSH_SETTLE_POLL_MS);
        outcome = await runRead(async (adapter) => await adapter.flushCapture());
      }
      if (!outcome.settled) {
        throw new Error(
          `Engine capture for ${workspace.workspaceId} did not settle.`,
        );
      }
    },

    async watcherStatus() {
      return await runRead(async (adapter) => await adapter.watcherStatus());
    },

    async setCaptureAuthor(author: MomentAuthor | null) {
      const desired = author === null ? null : adapterAuthor(author);
      await runMutation(async (adapter) => {
        await adapter.setCaptureAuthor(desired);
      });
      // Reopen replay is a cache of daemon-accepted state, not caller intent.
      // Remember only after the mutation succeeds.
      sessions.rememberCaptureAuthor(workspace.workspaceId, desired);
    },

    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };

  const secretStore = {
    async writeSecretFile(input: Parameters<SecretFileStore["writeSecretFile"]>[0]) {
      return await runMutation(async (adapter) => {
        const result = await adapter.writeSecretFile({
          ...input,
          metadata: adapterMetadata(input.metadata),
        });
        return {
          ...result,
          ...(result.moment
            ? { moment: secretMomentFromWire(result.moment) }
            : {}),
        };
      });
    },
    async deleteSecretFile(input: Parameters<SecretFileStore["deleteSecretFile"]>[0]) {
      return await runMutation(async (adapter) => {
        const result = await adapter.deleteSecretFile({
            ...input,
            metadata: adapterMetadata(input.metadata),
        });
        return {
          moment:
            result.moment === null
              ? null
              : secretMomentFromWire(result.moment),
        };
      });
    },
    listSecretFiles: (input: Parameters<SecretFileStore["listSecretFiles"]>[0]) =>
      runRead(async (adapter) => await adapter.listSecretFiles(input)),
    async listSecretMoments(
      input: Parameters<SecretFileStore["listSecretMoments"]>[0],
    ) {
      const moments = await runRead(
        async (adapter) => await adapter.listSecretMoments(input),
      );
      return moments.map(secretMomentFromWire);
    },
    async getSecretMoment(
      input: Parameters<SecretFileStore["getSecretMoment"]>[0],
    ) {
      const moment = await runRead(
        async (adapter) => await adapter.getSecretMoment(input),
      );
      return moment === null ? null : secretMomentFromWire(moment);
    },
    forkVersion: (input: Parameters<SecretFileStore["forkVersion"]>[0]) =>
      runMutation(async (adapter) => await adapter.forkVersion(input)),
    compareSecretFileVersions: (
      input: Parameters<SecretFileStore["compareSecretFileVersions"]>[0],
    ) =>
      runRead(async (adapter) => await adapter.compareSecretFileVersions(input)),
    applySecretFileFromVersion: (
      input: Parameters<SecretFileStore["applySecretFileFromVersion"]>[0],
    ) =>
      runMutation(async (adapter) => {
        const result = await adapter.applySecretFileFromVersion(input);
        return {
          ...result,
          ...(result.moment
            ? { moment: secretMomentFromWire(result.moment) }
            : {}),
        };
      }),
    restoreSecretFileToBeforeMoment: (
      input: Parameters<SecretFileStore["restoreSecretFileToBeforeMoment"]>[0],
    ) =>
      runMutation(
        async (adapter) =>
          await adapter.restoreSecretFileToBeforeMoment({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      ),
    materializeSecretFile: (
      input: Parameters<SecretFileStore["materializeSecretFile"]>[0],
    ) =>
      runRead(async (adapter) => await adapter.materializeSecretFile(input)),
    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };

  return {
    store: store as unknown as CaptureVersionedTextStore,
    secretStore: secretStore as unknown as SecretFileStore,
  };
}
