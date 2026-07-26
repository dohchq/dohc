import type {
  ActorNeutralWriteMetadata,
  MomentAuthor,
  SecretFileStore,
  TextFileSnapshot,
  VersionedTextMoment,
  VersionedTextMomentSummary,
  VersionedTextStore,
} from "@dohc/workspace-engine";
import {
  VersionedLiveAdapter,
  type AgentAuthor,
  type ConflictRecord,
  type MomentRecord,
  type VersionedTextListEntry,
  type VersionedTextReadValue,
} from "@dohc/workspace-engine-client";
import {
  EngineWorkspaceSessions,
  type EngineWorkspace,
  type EngineWorkspaceBinding,
} from "./engineWorkspaceSessions";

export interface CaptureTextFileMetadata {
  path: string;
  objectId: string;
  contentKind: "text" | "binary";
  byteLength: number | null;
  sha256: string | null;
  updatedAtMs: number;
  latestMomentId: string;
}

export type CaptureVersionedTextStore = VersionedTextStore & {
  listTextFileMetadata?(input: {
    workspaceId: string;
    versionId: string;
  }): Promise<CaptureTextFileMetadata[]>;
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
    origin: origin as ActorNeutralWriteMetadata["origin"],
    ...(supplied?.summary !== undefined ? { summary: supplied.summary } : {}),
    ...(supplied?.correlationId !== undefined
      ? { correlationId: supplied.correlationId }
      : {}),
  };
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
    metadata: metadataFromOrigin(value.metadataOrigin, metadata),
  };
}

function authorFromWire(author: MomentRecord["author"]): MomentAuthor | undefined {
  if (
    author === null ||
    "corrupt" in author ||
    author.kind !== "agent"
  ) {
    return undefined;
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
    path: moment.path,
    contentKind,
    ...(sha256 !== null ? { sha256 } : {}),
    ...(byteLength !== null ? { byteLength } : {}),
    text: text ?? "",
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
      after: payloadSnapshot(moment, "after"),
    },
    metadata: metadataFromOrigin(moment.metadataOrigin, suppliedMetadata),
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
    metadata: metadataFromOrigin(moment.metadataOrigin),
    ...(author !== undefined ? { author } : {}),
    momentOrder: moment.momentOrder,
    ...(moment.syncRecordOnly ? { syncRecordOnly: true } : {}),
  };
}

function conflictFromWire(conflict: ConflictRecord) {
  return {
    ...conflict,
    metadata: metadataFromOrigin(conflict.metadata.origin, {
      origin: conflict.metadata.origin as ActorNeutralWriteMetadata["origin"],
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

function adapterMetadata(metadata: ActorNeutralWriteMetadata) {
  // The current versioned RPC mutation surface carries origin. Secret apply
  // additionally carries summary/correlationId and receives them unchanged in
  // its dedicated wrapper below.
  return { origin: metadata.origin };
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

  async function run<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await sessions.run(
      workspace,
      async (binding) => await operation(adapterFor(binding)),
      { retryTransportErrors: true },
    );
  }

  const store = {
    ensureMainVersion: (input: { workspaceId: string }) =>
      run(async (adapter) => await adapter.ensureMainVersion(input)),
    getMainVersion: (input: { workspaceId: string }) =>
      run(async (adapter) => await adapter.getMainVersion(input)),
    getActiveVersion: (input: { workspaceId: string }) =>
      run(async (adapter) => await adapter.getActiveVersion(input)),
    setActiveVersion: (input: { workspaceId: string; versionId: string }) =>
      run(async (adapter) => await adapter.setActiveVersion(input)),
    createNamedVersion: (input: {
      workspaceId: string;
      name: string;
      fromVersionId: string;
    }) => run(async (adapter) => await adapter.createNamedVersion(input)),
    listVersions: (input: { workspaceId: string }) =>
      run(async (adapter) => await adapter.listVersions(input)),

    async readTextFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
    }) {
      const value = await run(async (adapter) => await adapter.readTextFile(input));
      return value === null ? null : snapshotFromWire(value);
    },

    async listTextFileMetadata(input: {
      workspaceId: string;
      versionId: string;
    }): Promise<CaptureTextFileMetadata[]> {
      const rows = await run(
        async (adapter) => await adapter.listTextFileMetadata(input),
      );
      return rows.map((row: VersionedTextListEntry) => ({
        path: row.path,
        objectId: row.objectId,
        contentKind: row.contentKind,
        byteLength: row.byteLength,
        sha256: row.binarySha256,
        updatedAtMs: row.updatedAtMs,
        latestMomentId: row.latestMomentId,
      }));
    },

    async listTextFiles(input: {
      workspaceId: string;
      versionId: string;
    }) {
      const values = await run(async (adapter) => await adapter.listTextFiles(input));
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
      const raw = await run(
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
      const raw = await run(
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
    }) => run(async (adapter) => await adapter.readBinaryFile(input)),
    readBinaryBlob: (input: { workspaceId: string; sha256: string }) =>
      run(async (adapter) => await adapter.readBinaryBlob(input)),

    async deleteTextFile(input: {
      workspaceId: string;
      versionId: string;
      path: string;
      metadata: ActorNeutralWriteMetadata;
      author?: MomentAuthor;
      momentId?: string;
    }) {
      const before = await store.readTextFile(input);
      if (!before) {
        throw new Error(`Engine text head for ${input.path} disappeared before delete.`);
      }
      const { metadata, author, ...deleteInput } = input;
      const raw = await run(
        async (adapter) =>
          await adapter.deleteTextFile({
            ...deleteInput,
            ...(author ? { author: adapterAuthor(author) } : {}),
            metadata: adapterMetadata(metadata),
          }),
      );
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
      const raw = await run(
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
    }) => run(async (adapter) => await adapter.rollbackTextFileMutation(input)),

    async listMoments(input: {
      workspaceId: string;
      versionId?: string;
      objectId?: string;
      limit?: number;
      beforeMomentOrder?: number;
    }) {
      const page = await run(async (adapter) => await adapter.listMoments(input));
      return {
        ...page,
        moments: page.moments.map((moment) =>
          momentSummaryFromWire(input.workspaceId, moment),
        ),
      };
    },

    async getMoment(input: { workspaceId: string; momentId: string }) {
      const moment = await run(async (adapter) => await adapter.getMoment(input));
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
      const result = await run(
        async (adapter) => await adapter.compareTextFileVersions(input),
      );
      return { ...result, ...input };
    },

    async listTextConflicts(input: {
      workspaceId: string;
      status?: "open" | "resolved";
    }) {
      const conflicts = await run(
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
      const raw = await run(
        async (adapter) =>
          await adapter.mergeTextFileFromVersion({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      );
      const comparison = {
        workspaceId: input.workspaceId,
        path: input.path,
        targetVersionId: input.targetVersionId,
        sourceVersionId: input.sourceVersionId,
        status: raw.status,
      };
      if (raw.status === "unchanged") {
        return { kind: "unchanged", reason: "already-same", comparison };
      }
      if (raw.status === "conflict") {
        const conflicts = await store.listTextConflicts({
          workspaceId: input.workspaceId,
          status: "open",
        });
        const conflict = conflicts.find(
          (entry) =>
            entry.path === input.path &&
            entry.targetVersionId === input.targetVersionId &&
            entry.sourceVersionId === input.sourceVersionId,
        );
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
      const raw = await run(
        async (adapter) =>
          await adapter.resolveTextConflict({
            conflictId: input.conflictId,
            resolution: input.resolution,
          }),
      );
      if (!("conflict" in raw)) {
        throw new Error(`Engine conflict ${input.conflictId} was not resolved locally.`);
      }
      const conflict = conflictFromWire(raw.conflict as ConflictRecord);
      const snapshot = await store.readTextFile({
        workspaceId: input.workspaceId,
        versionId: existing.targetVersionId,
        path: existing.path,
      });
      return snapshot
        ? { kind: "resolved", conflict, write: { snapshot } }
        : { kind: "resolved", conflict, delete: { before: existing.current } };
    },

    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };

  const secretStore = {
    async writeSecretFile(input: Parameters<SecretFileStore["writeSecretFile"]>[0]) {
      return await run(
        async (adapter) =>
          await adapter.writeSecretFile({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      );
    },
    async deleteSecretFile(input: Parameters<SecretFileStore["deleteSecretFile"]>[0]) {
      return await run(
        async (adapter) =>
          await adapter.deleteSecretFile({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      );
    },
    listSecretFiles: (input: Parameters<SecretFileStore["listSecretFiles"]>[0]) =>
      run(async (adapter) => await adapter.listSecretFiles(input)),
    listSecretMoments: (input: Parameters<SecretFileStore["listSecretMoments"]>[0]) =>
      run(async (adapter) => await adapter.listSecretMoments(input)),
    getSecretMoment: (input: Parameters<SecretFileStore["getSecretMoment"]>[0]) =>
      run(async (adapter) => await adapter.getSecretMoment(input)),
    forkVersion: (input: Parameters<SecretFileStore["forkVersion"]>[0]) =>
      run(async (adapter) => await adapter.forkVersion(input)),
    compareSecretFileVersions: (
      input: Parameters<SecretFileStore["compareSecretFileVersions"]>[0],
    ) => run(async (adapter) => await adapter.compareSecretFileVersions(input)),
    applySecretFileFromVersion: (
      input: Parameters<SecretFileStore["applySecretFileFromVersion"]>[0],
    ) =>
      run(
        async (adapter) => await adapter.applySecretFileFromVersion(input),
      ),
    restoreSecretFileToBeforeMoment: (
      input: Parameters<SecretFileStore["restoreSecretFileToBeforeMoment"]>[0],
    ) =>
      run(
        async (adapter) =>
          await adapter.restoreSecretFileToBeforeMoment({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      ),
    materializeSecretFile: (
      input: Parameters<SecretFileStore["materializeSecretFile"]>[0],
    ) => run(async (adapter) => await adapter.materializeSecretFile(input)),
    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };

  return {
    store: store as unknown as CaptureVersionedTextStore,
    secretStore: secretStore as unknown as SecretFileStore,
  };
}
