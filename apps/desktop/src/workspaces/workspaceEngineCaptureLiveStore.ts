import {
  VersionedTextStoreError,
  type VersionedTextStoreErrorCode,
} from "@dohc/workspace-contracts/engine";
import type {
  ActorNeutralWriteMetadata,
  FileObjectRecord,
  MomentAuthor,
  SecretFileMoment,
  SecretFileStore,
  TextFileSnapshot,
  VersionedTextFileState,
  VersionedTextMoment,
  VersionedTextMomentSummary,
  VersionedTextStore,
} from "@dohc/workspace-contracts/engine";
import {
  DaemonRefusalError,
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
import { createHash, randomUUID } from "node:crypto";
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

// Every `VersionedTextStoreErrorCode`. The engine writes its domain code
// verbatim into the wire MESSAGE (`map_runtime`,
// crates/dohc-workspace-engine/src/lib.rs), so recognising a refusal is a set
// lookup, not a rename table.
const VERSIONED_TEXT_STORE_ERROR_CODES = [
  "conflict-not-found",
  "conflict-stale-target",
  "duplicate-id",
  "file-too-large",
  "file-not-found",
  "fork-base-not-found",
  "invalid-generated-id",
  "invalid-input",
  "invalid-metadata",
  "invalid-object",
  "invalid-path",
  "invalid-root",
  "invalid-version",
  "invalid-text",
  "invalid-timestamp",
  "invalid-version-name",
  "invalid-workspace",
  "persist-failed",
  "state-corrupt",
  "target-path-exists",
  "version-name-conflict",
  "version-not-found",
  "workspace-mismatch",
  "write-lane-reentry",
] as const satisfies readonly VersionedTextStoreErrorCode[];

// A new domain code must be listed above, or this stops compiling.
type AssertNever<T extends never> = T;
type _AllDomainCodesRepresented = AssertNever<
  Exclude<
    VersionedTextStoreErrorCode,
    (typeof VERSIONED_TEXT_STORE_ERROR_CODES)[number]
  >
>;

const DOMAIN_ERROR_CODES: ReadonlySet<string> = new Set(
  VERSIONED_TEXT_STORE_ERROR_CODES,
);

/**
 * Present a daemon refusal as the domain error this store's contract promises.
 *
 * The in-process store raised `VersionedTextStoreError` with a domain code. The
 * daemon reports the same failure as a `DaemonRefusalError` whose message is
 * that same code, so a caller keying on `error.code` — the obvious way to write
 * "that name is already taken" — matched nothing here (#418).
 *
 * A refusal the domain has no code for is rethrown untouched. Collapsing it
 * into a generic code would lose exactly the information this translation
 * exists to keep.
 */
function domainErrorFrom(error: unknown): VersionedTextStoreError | null {
  if (!(error instanceof DaemonRefusalError)) return null;
  if (!DOMAIN_ERROR_CODES.has(error.message)) return null;
  const translated = new VersionedTextStoreError(
    error.message as VersionedTextStoreErrorCode,
    error.message,
  );
  // The wire code and retryability stay reachable; translation adds a domain
  // code, it does not replace the refusal.
  translated.cause = error;
  return translated;
}

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
  // Every caller hydrates an over-cap body first (`hydratedMoment`), so a
  // withheld text reaching here is one of two different failures. Fabricating
  // "" in either case would report a wipe that never happened.
  if (contentKind === "text" && text === null) {
    const blobSha256 = before ? moment.beforeBlobSha256 : moment.afterBlobSha256;
    throw new Error(
      blobSha256 === null
        ? `Engine moment ${side} text for ${moment.path} is absent and carries no text digest.`
        : `Engine moment ${side} text for ${moment.path} was not hydrated from ${blobSha256}.`,
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
      // A delete repeats its preimage on the after side rather than emptying
      // it — `delete_text_in_tx` (store.rs) binds one digest to both sides —
      // so the after side is read from the record like any other, not
      // reconstructed from the before side.
      after: payloadSnapshot(moment, "after"),
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
    // A withheld body carries no text, the way a binary side carries none.
    // Only `conflicts.resolve` withholds, and the conflict it answers with is
    // read for identity and content kind, never for a body — the bodies a
    // reader paints come from `conflicts.list`.
    ...(state.contentKind === "text" && snapshot.text !== null
      ? { text: snapshot.text }
      : {}),
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

  // Untranslated. `sessions.run` reads a refusal's disposition to decide
  // whether to reconnect, so translation has to happen outside it, and the
  // secret surface has its own taxonomy (`SecretFileStoreErrorCode`) that this
  // one must not answer for.
  async function runRawRead<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await sessions.run(
      workspace,
      async (binding) => await operation(adapterFor(binding)),
      { retryTransportErrors: true },
    );
  }

  async function runRawMutation<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await sessions.run(
      workspace,
      async (binding) => await operation(adapterFor(binding)),
    );
  }

  async function withDomainErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const domainError = domainErrorFrom(error);
      if (domainError !== null) throw domainError;
      throw error;
    }
  }

  async function runRead<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await withDomainErrors(async () => await runRawRead(operation));
  }

  async function runMutation<T>(
    operation: (adapter: VersionedLiveAdapter) => Promise<T>,
  ): Promise<T> {
    return await withDomainErrors(async () => await runRawMutation(operation));
  }

  /**
   * The bodies ONE answer withheld: offered first, fetched only if unknown,
   * and fetched once per digest.
   *
   * Digests repeat inside a single answer. A resolution’s settled snapshot and
   * its moment’s `afterText` are the same body under the same digest, and a
   * delete or rename binds one digest to both moment sides (`delete_text_in_tx`
   * and the rename insert, store.rs). Hydrating them apart streams a
   * multi-megabyte blob twice for one answer.
   *
   * The offer matters more than the cache. A resolution has COMMITTED by the
   * time its answer is read, so a read that fails between the commit and the
   * materialization leaves the folder on the losing content while the conflict
   * is closed — the exact shape this surface exists to prevent. A caller that
   * already holds the settled body (it submitted the combined text, or it read
   * the side it chose) never has to take that risk.
   */
  interface WithheldBodyReader {
    (sha256: string, path: string): Promise<string>;
    /**
     * A body this call ALREADY HOLDS. Offering it removes the read that would
     * otherwise stand between a committed write and the folder it belongs in.
     *
     * The caller offers text it can name but not address: the digest is the
     * answer’s, so an offer only satisfies a hydration when the two agree
     * byte for byte. An offer that does not match is ignored, and the read
     * happens as before.
     */
    offer(text: string | null | undefined): void;
  }

  function withheldBodies(): WithheldBodyReader {
    const bodies = new Map<string, Promise<string>>();
    const offered: string[] = [];
    const reader = (sha256: string, path: string): Promise<string> => {
      const cached = bodies.get(sha256);
      if (cached !== undefined) return cached;
      // Hashing happens HERE, not at the offer: only an over-cap answer ever
      // asks, and only then is a candidate worth a digest.
      const held = offered.find(
        (candidate) =>
          createHash("sha256").update(candidate, "utf8").digest("hex") === sha256,
      );
      const body =
        held === undefined
          ? runRead(async (adapter) => {
              const text = await adapter.readTextBlob({
                workspaceId: workspace.workspaceId,
                sha256,
              });
              if (text === null) {
                throw new VersionedTextStoreError(
                  "state-corrupt",
                  `Engine text blob ${sha256} for ${path} is unreadable.`,
                );
              }
              return text;
            })
          : Promise.resolve(held);
      bodies.set(sha256, body);
      return body;
    };
    reader.offer = (text: string | null | undefined) => {
      if (typeof text === "string") offered.push(text);
    };
    return reader;
  }

  /**
   * Restore a moment payload body the daemon withheld for being over-cap.
   *
   * `moment_json` (lib.rs) nulls a payload text past the in-band limit and
   * reports its digest instead, exactly as a capped head read does. This store
   * promises the body, so fetch it out of band — the same hydration
   * `readTextFile` already performs, keyed off the digest the moment carries.
   *
   * A moment whose body already fits makes no extra request, and a metadata
   * listing (`listMoments`) never reaches here: it reads no payload text.
   */
  async function hydratedMoment(
    moment: MomentRecord,
    body: WithheldBodyReader = withheldBodies(),
  ): Promise<MomentRecord> {
    const afterSha256 =
      moment.afterContentKind === "text" && moment.afterText === null
        ? moment.afterBlobSha256
        : null;
    const beforeSha256 =
      moment.beforePresent &&
      moment.beforeContentKind === "text" &&
      moment.beforeText === null
        ? moment.beforeBlobSha256
        : null;
    if (afterSha256 === null && beforeSha256 === null) return moment;
    const afterText =
      afterSha256 === null ? null : await body(afterSha256, moment.path);
    const beforeText =
      beforeSha256 === null ? null : await body(beforeSha256, moment.path);
    return {
      ...moment,
      ...(afterText !== null ? { afterText } : {}),
      ...(beforeText !== null ? { beforeText } : {}),
    };
  }

  /**
   * Restore a settled body the daemon withheld for being over-cap.
   *
   * `settled_snapshot_json` (lib.rs) nulls the body a resolution settled and
   * reports its digest instead, so the answer's size never follows the body a
   * conflict was combined from. This store promises the body — the caller
   * mirrors it to disk — so fetch it out of band, the same hydration
   * `readTextFile` and `hydratedMoment` already perform.
   */
  async function hydratedSnapshot(
    snapshot: VersionedTextReadValue,
    body: WithheldBodyReader = withheldBodies(),
  ): Promise<VersionedTextReadValue> {
    if (snapshot.contentKind !== "text" || snapshot.text !== null) return snapshot;
    const text = await body(snapshot.blobSha256, snapshot.path);
    const { inbandLimitBytes: _inbandLimitBytes, ...metadata } = snapshot;
    return { ...metadata, text };
  }

  // One open conflict by id, walking the daemon's `conflicts.list` pages until
  // the id appears. Null when no open conflict has the id.
  async function findOpenConflict(
    workspaceId: string,
    conflictId: string,
  ): Promise<ReturnType<typeof conflictFromWire> | null> {
    let afterConflictId: string | undefined;
    do {
      const page = await runRead(
        async (adapter) =>
          await adapter.listTextConflicts({
            workspaceId,
            status: "open",
            ...(afterConflictId !== undefined ? { afterConflictId } : {}),
          }),
      );
      const match = page.conflicts.find((entry) => entry.id === conflictId);
      if (match) return conflictFromWire(match);
      afterConflictId = page.nextAfterConflictId ?? undefined;
    } while (afterConflictId !== undefined);
    return null;
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
        moment: momentFromWire(
          input.workspaceId,
          await hydratedMoment(raw.moment),
          input.metadata,
        ),
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
        moment: momentFromWire(
          input.workspaceId,
          await hydratedMoment(raw.moment),
          input.metadata,
        ),
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
      const hydrated = await hydratedMoment(raw.moment);
      const beforePayload = payloadSnapshot(hydrated, "before");
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
        moment: momentFromWire(input.workspaceId, hydrated, input.metadata),
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
        moment: momentFromWire(
          input.workspaceId,
          await hydratedMoment(raw.moment),
          input.metadata,
        ),
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
        : momentFromWire(input.workspaceId, await hydratedMoment(moment));
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
      afterConflictId?: string;
    }) {
      const page = await runRead(
        async (adapter) => await adapter.listTextConflicts(input),
      );
      return {
        conflicts: page.conflicts.map(conflictFromWire),
        nextAfterConflictId: page.nextAfterConflictId,
      };
    },

    async compareVersionFilesPage(input: {
      workspaceId: string;
      sourceVersionId: string;
      targetVersionId: string;
      afterPath?: string;
    }) {
      return await runRead(
        async (adapter) => await adapter.compareVersionFilesPage(input),
      );
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
        const conflict = await findOpenConflict(input.workspaceId, raw.conflictId);
        if (!conflict) throw new Error(`Engine conflict for ${input.path} was not returned.`);
        return { kind: "conflict", comparison, conflict };
      }
      // A fast-forwarded binary head takes the same path as a text one: the
      // head is re-read from the engine, and materializing it reads its kind.
      if (raw.writeKind === "write" || raw.writeKind === "binary-write") {
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
              await hydratedMoment(raw.moment as MomentRecord),
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
            await hydratedMoment(raw.moment as MomentRecord),
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
      const existing = await findOpenConflict(input.workspaceId, input.conflictId);
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
      const withheld = withheldBodies();
      // Everything a settled body can be, on this path, is already in hand:
      // the combined text this call submitted, the side it chose, and the head
      // that side replaced (the moment’s before-body). None of them needs a
      // post-commit read.
      if (input.resolution.kind === "apply-merged") withheld.offer(input.resolution.text);
      withheld.offer(existing.incoming.text);
      withheld.offer(existing.current.text);
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
            // ONE reader for both: a settled body and the moment’s `afterText`
            // are the same body under the same digest.
            snapshot: snapshotFromWire(
              await hydratedSnapshot(write.snapshot, withheld),
              input.metadata,
            ),
            moment: momentFromWire(
              input.workspaceId,
              await hydratedMoment(write.moment, withheld),
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
              await hydratedMoment(deletion.moment, withheld),
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
      return await runRawMutation(async (adapter) => {
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
      return await runRawMutation(async (adapter) => {
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
      runRawRead(async (adapter) => await adapter.listSecretFiles(input)),
    async listSecretMoments(
      input: Parameters<SecretFileStore["listSecretMoments"]>[0],
    ) {
      const moments = await runRawRead(
        async (adapter) => await adapter.listSecretMoments(input),
      );
      return moments.map(secretMomentFromWire);
    },
    async getSecretMoment(
      input: Parameters<SecretFileStore["getSecretMoment"]>[0],
    ) {
      const moment = await runRawRead(
        async (adapter) => await adapter.getSecretMoment(input),
      );
      return moment === null ? null : secretMomentFromWire(moment);
    },
    forkVersion: (input: Parameters<SecretFileStore["forkVersion"]>[0]) =>
      runRawMutation(async (adapter) => await adapter.forkVersion(input)),
    compareSecretFileVersions: (
      input: Parameters<SecretFileStore["compareSecretFileVersions"]>[0],
    ) =>
      runRawRead(async (adapter) => await adapter.compareSecretFileVersions(input)),
    applySecretFileFromVersion: (
      input: Parameters<SecretFileStore["applySecretFileFromVersion"]>[0],
    ) =>
      runRawMutation(async (adapter) => {
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
      runRawMutation(
        async (adapter) =>
          await adapter.restoreSecretFileToBeforeMoment({
            ...input,
            metadata: adapterMetadata(input.metadata),
          }),
      ),
    materializeSecretFile: (
      input: Parameters<SecretFileStore["materializeSecretFile"]>[0],
    ) =>
      runRawRead(async (adapter) => await adapter.materializeSecretFile(input)),
    close: async () => await sessions.closeWorkspace(workspace.workspaceId),
  };

  return {
    store: store as unknown as CaptureVersionedTextStore,
    secretStore: secretStore as unknown as SecretFileStore,
  };
}
