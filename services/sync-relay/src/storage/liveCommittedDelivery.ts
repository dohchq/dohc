import {
  hasServiceActivation,
  readServiceActivation,
  serviceActivationSeed,
  serviceActivationState,
  type ServiceActivationAccess,
} from "./serviceActivationAccess";
import { readServiceActivationOrigin } from "./serviceActivationOrigin";
import { randomUUID, createHash } from "node:crypto";
import {
  canonicalVersionedAcceptedMetadata,
  initialAcceptedHistoryDigest,
  nextVersionedAcceptedHistoryDigest,
} from "../liveAcceptedHistory";
import type {
  LiveOwnerAdoptionCut,
  NativeOwnerActivationSource,
  RetainedPrefix,
  RetainedPrefixBody,
} from "@dohc/workspace-engine-client/daemon";
import { LIVE_DELIVERY_OWNER_HISTORY, SERVICE_ACTIVATIONS } from "./serviceActivationSchema";
import { isDeepStrictEqual } from "node:util";
import {
  parseLiveUpdateDigest,
  parseLiveUpdateIdentifier,
  parseLiveUpdateReceipt,
  parseLiveUpdateHostApplicationAck,
  type LiveDocumentKey,
  type LiveUpdateReceipt,
  type AdmittedLiveUpdate,
} from "@dohc/live-session-contract/live-update-admission";
import {
  parseLiveObjectBinding,
  type LiveObjectBinding,
} from "@dohc/live-session-contract/live-object-binding";
import type { StorageContext } from "./context";
import type { RetirementKey } from "./serviceActivationRetirement";
import type { LiveHostConnectionCoordinate, StoredLiveDocumentAuthority } from "./types";
import { snapshotHostCoordinate } from "../liveTicketInputs";
import {
  authorityInteger,
  baselineRecord,
  decodeLiveDocumentAuthorityStructure,
  currentLiveDocumentBinding,
  authorizeLiveDocument,
} from "./liveDocumentAuthority";
import {
  attachLiveJournalHistory,
  requireLiveJournalHistory,
  type LiveJournalHistoryAuthority,
} from "./liveJournalHistory";
import {
  LIVE_DELIVERY_BOOTSTRAPS as BOOTSTRAPS,
  LIVE_DELIVERY_EDGES as EDGES,
  LIVE_DELIVERY_OWNERS as OWNERS,
} from "./liveCommittedDeliverySchema";
import { LIVE_JOURNAL_TABLE } from "./schema";
import { liveJournalCheckpointDue } from "./liveJournalCheckpoint";
import {
  journalDocument,
  journalHost,
  documentParams,
  liveJournalCut,
  verifyJournalCut,
  decodeJournalRow,
  verifyJournalRow,
  assertJournalCheckpointPosition,
} from "./liveUpdateJournal";
import {
  adoptLiveDeliveryPrefix,
  bindLiveDeliveryHostNamespace,
  consumeLiveDeliveryReservation,
} from "./liveDeliveryReservations";

export interface CommittedBootstrap {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly binding: LiveObjectBinding;
  readonly baselineMomentRelaySequence: number;
  readonly baselineRegisteredAtMs: number;
  readonly baselineDigest: string;
  readonly projectedMarkdownDigest: string;
  readonly projectedMarkdownByteLength: number;
  readonly baselineBytes: Uint8Array;
}
export interface CommittedBootstrapAck {
  readonly bootstrapId: string;
  readonly bootstrapMomentId: string;
  readonly baselineDigest: string;
  readonly baselineMomentRelaySequence: number;
  readonly localYDocSequence: number;
  readonly bootstrapReplayed: boolean;
}
export interface CommittedDeliveryDrain {
  readonly baseline: CommittedBootstrap;
  readonly terminalReceipt: LiveUpdateReceipt | null;
}

export interface OwnerCutCapture {
  binding: LiveObjectBinding;
  cut: LiveOwnerAdoptionCut;
  assertCurrent(): void;
}
export interface OwnerDeliveryCapture {
  binding: LiveObjectBinding;
  assertCurrent(): void;
}
/** An adopted document's owner delivery after its owner lost live authority: the relay's tip, and the next row it accepted after it. */
export interface DepartedOwnerDelivery {
  readonly binding: LiveObjectBinding;
  readonly tip: LiveUpdateReceipt | null;
  readonly next: LiveUpdateReceipt | null;
}
export type CommittedDeliveryStep =
  | { kind: "bootstrap"; baseline: CommittedBootstrap }
  | {
      kind: "next";
      admitted: AdmittedLiveUpdate;
      predecessor: LiveUpdateReceipt | null;
    }
  | { kind: "done"; terminalReceipt: LiveUpdateReceipt | null };
interface DrainCapture {
  host: LiveHostConnectionCoordinate;
  document: LiveDocumentKey;
  authority: StoredLiveDocumentAuthority;
  baseline: CommittedBootstrap;
  terminal: LiveUpdateReceipt | null;
  progress?: {
    predecessor: LiveUpdateReceipt | null;
    tip: Record<string, unknown> | null;
  };
  checkpoint?: {
    receipt: LiveUpdateReceipt;
    count: number;
    bytes: number;
    rowBytes: number;
    hasCheckpoint: boolean;
  };
}
const WHERE_DOCUMENT =
  "workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=?";
const WHERE_BOOTSTRAP =
  "relay_database_namespace=? AND workspace_id=? AND main_version_id=? AND object_id=? AND lineage_claim_id=? AND host_id=?";
function integrity(condition: unknown): asserts condition {
  if (!condition) throw new Error("Committed delivery evidence is damaged or conflicts.");
}
function receipt(row: Record<string, unknown>): LiveUpdateReceipt {
  return parseLiveUpdateReceipt({
    deliveryId: row.delivery_id,
    updateDigest: row.update_digest,
    journalCursor: row.journal_cursor,
    acceptingHostEpoch: row.accepting_host_epoch,
  });
}
function sameReceipt(a: LiveUpdateReceipt | null, b: LiveUpdateReceipt | null): boolean {
  return isDeepStrictEqual(a, b);
}
function parseBootstrapAck(value: unknown): CommittedBootstrapAck {
  const row = baselineRecord(value, [
    "bootstrapId",
    "bootstrapMomentId",
    "baselineDigest",
    "baselineMomentRelaySequence",
    "localYDocSequence",
    "bootstrapReplayed",
  ]);
  if (typeof row.bootstrapReplayed !== "boolean")
    throw new TypeError("Invalid bootstrap replay flag.");
  return {
    bootstrapId: parseLiveUpdateIdentifier(row.bootstrapId, "bootstrap ID"),
    bootstrapMomentId: parseLiveUpdateIdentifier(row.bootstrapMomentId, "bootstrap moment ID"),
    baselineDigest: parseLiveUpdateDigest(row.baselineDigest),
    baselineMomentRelaySequence: authorityInteger(row.baselineMomentRelaySequence, 1),
    localYDocSequence: authorityInteger(row.localYDocSequence),
    bootstrapReplayed: row.bootstrapReplayed,
  };
}
function copiedBaseline(value: CommittedBootstrap): CommittedBootstrap {
  return {
    ...value,
    binding: {
      ...value.binding,
      selectorPaths: [...value.binding.selectorPaths],
    },
    baselineBytes: new Uint8Array(value.baselineBytes),
  };
}

function ownerCutDigest(capture: OwnerCutCapture): string {
  const { baselineBytes, events, ...header } = capture.cut;
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return digest(
    Buffer.from(
      JSON.stringify({
        binding: capture.binding,
        ...header,
        baselineDigest: digest(baselineBytes),
        events: events.map((event) => ({
          metadata: event.metadata,
          digest: digest(event.updateBytes),
        })),
      }),
    ),
  );
}

/**
 * The evidence native adoption hashes for `cut` (adoption.rs `validate_cut`).
 * A successor's prefix is the tenth element, only when present, so a first
 * adoption's evidence keeps its nine.
 */
export function ownerAdoptionCutEvidenceDigest(
  binding: LiveObjectBinding,
  cut: LiveOwnerAdoptionCut,
): string {
  const evidence: unknown[] = [
    binding,
    cut.relayDatabaseNamespace,
    cut.sourceMomentId,
    cut.sourceDigest,
    cut.sourceByteLength,
    cut.baselineMomentRelaySequence,
    cut.baselineRegisteredAtMs,
    cut.expectedLocalSequence,
    cut.events.map((event) => canonicalVersionedAcceptedMetadata(event.metadata)),
  ];
  const prefix = cut.retainedPrefix;
  if (prefix) {
    const terminal = prefix.terminalReceipt;
    evidence.push({
      terminalReceipt: terminal && {
        deliveryId: terminal.deliveryId,
        updateDigest: terminal.updateDigest,
        journalCursor: terminal.journalCursor,
        acceptingHostEpoch: terminal.acceptingHostEpoch,
      },
      eventCount: prefix.eventCount,
      historyEvidenceDigest: prefix.historyEvidenceDigest,
      predecessorActivationId: prefix.predecessorActivationId,
    });
  }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

/** Internal storage consumer. Authentication and namespace provisioning belong to its caller. */
export class LiveCommittedDeliveryStore {
  readonly #drains = new WeakMap<CommittedDeliveryDrain, DrainCapture>();
  readonly #storage: StorageContext;
  readonly #history: LiveJournalHistoryAuthority;
  readonly #ownerCuts = new WeakMap<
    OwnerCutCapture,
    {
      host: LiveHostConnectionCoordinate;
      document: LiveDocumentKey;
      digest: string;
      activation: NativeOwnerActivationSource | null;
    }
  >();
  readonly #ownerDeliveries = new WeakMap<
    OwnerDeliveryCapture,
    { host: LiveHostConnectionCoordinate; document: LiveDocumentKey; highWater: number }
  >();
  constructor(
    storage: StorageContext,
    history: LiveJournalHistoryAuthority,
    private readonly activation?: ServiceActivationAccess,
  ) {
    this.#storage = storage;
    this.#history = history;
    attachLiveJournalHistory(storage, history);
  }

  nextOwnerDocument(workspaceId: string, afterObject: string): LiveDocumentKey | undefined {
    parseLiveUpdateIdentifier(workspaceId, "workspace ID");
    return this.#storage.readTx(() => {
      const row = this.#storage.db
        .prepare(
          "SELECT workspace_id,main_version_id,object_id,lineage_claim_id FROM sync_relay_live_documents WHERE workspace_id=? AND lineage_state='current' AND admission_state='open' AND object_id>? ORDER BY object_id LIMIT 1",
        )
        .get(workspaceId, afterObject);
      return row
        ? journalDocument({
            workspaceId: row.workspace_id,
            mainVersionId: row.main_version_id,
            objectId: row.object_id,
            lineageClaimId: row.lineage_claim_id,
          })
        : undefined;
    });
  }
  #ownerSource(
    document: LiveDocumentKey,
    adoptionId: string,
    authority: Pick<
      StoredLiveDocumentAuthority,
      "binding" | "baselineSequence" | "projectedDigest" | "projectedLength" | "registeredAtMs"
    >,
  ) {
    const activation = readServiceActivationOrigin(
      this.#storage,
      this.#history.namespace,
      document,
      adoptionId,
    );
    if (activation) {
      integrity(
        activation.source.currentPath === authority.binding.currentPath &&
          activation.baseline.relaySequence === authority.baselineSequence &&
          activation.baseline.projectedDigest === authority.projectedDigest &&
          activation.baseline.projectedLength === authority.projectedLength &&
          activation.baseline.registeredAtMs === authority.registeredAtMs,
      );
      return {
        sourceMomentId: activation.source.sourceMomentId,
        sourceDigest: activation.source.sourceDigest,
        sourceByteLength: activation.source.sourceByteLength,
        activation,
      };
    }
    const source = this.#storage.db
      .prepare(
        "SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?",
      )
      .get(document.workspaceId, document.objectId, authority.baselineSequence);
    integrity(
      source &&
        source.version_id === document.mainVersionId &&
        source.path === authority.binding.currentPath &&
        source.content_kind === "text" &&
        source.blob_sha256 === authority.projectedDigest &&
        source.byte_length === authority.projectedLength,
    );
    return {
      sourceMomentId: parseLiveUpdateIdentifier(source.moment_id, "source moment ID"),
      sourceDigest: authority.projectedDigest,
      sourceByteLength: authority.projectedLength,
      activation: null,
    };
  }
  // A successor's retained prefix: the boundary its retired predecessor released, or none when that chain never adopted.
  #retainedPrefix(source: NativeOwnerActivationSource | undefined): RetainedPrefix | null {
    const predecessorActivationId = source?.predecessorActivationId;
    if (predecessorActivationId === undefined) return null;
    const row = this.#storage.db
      .prepare(`SELECT retired_boundary_json FROM ${SERVICE_ACTIVATIONS}
      WHERE relay_database_namespace=? AND activation_id=? AND retired_at_ms IS NOT NULL`)
      .get(this.#history.namespace, predecessorActivationId);
    integrity(row);
    const boundary = JSON.parse(String(row.retired_boundary_json)) as RetainedPrefixBody | null;
    return (
      boundary && {
        terminalReceipt: boundary.terminalReceipt,
        eventCount: boundary.eventCount,
        historyEvidenceDigest: boundary.historyEvidenceDigest,
        predecessorActivationId,
      }
    );
  }
  // The owner row's adoption against the live document row: its baseline, its
  // source and its original binding. Live authority is the caller's to check.
  #ownerOrigin(document: LiveDocumentKey, owner: Record<string, unknown>) {
    const origin = JSON.parse(String(owner.origin_json));
    const row = this.#storage.db
      .prepare(
        `SELECT workspace_id,main_version_id,object_id,lineage_claim_id,current_path,restore_fence_generation,lineage_state,admission_state,baseline_digest,baseline_projected_sha256,baseline_projected_byte_length,baseline_moment_relay_seq,registered_at_ms FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`,
      )
      .get(...documentParams(document));
    integrity(
      row &&
        row.lineage_state === "current" &&
        row.baseline_digest === document.lineageClaimId &&
        row.baseline_moment_relay_seq === origin.baselineMomentRelaySequence &&
        row.registered_at_ms === origin.baselineRegisteredAtMs,
    );
    const binding = parseLiveObjectBinding({
      ...document,
      currentPath: row.current_path,
      selectorPaths: [row.current_path],
      restoreFenceGeneration: row.restore_fence_generation,
    });
    const source = this.#ownerSource(document, origin.adoptionId, {
      binding,
      baselineSequence: authorityInteger(row.baseline_moment_relay_seq, 1),
      projectedDigest: parseLiveUpdateDigest(row.baseline_projected_sha256),
      projectedLength: authorityInteger(row.baseline_projected_byte_length),
      registeredAtMs: authorityInteger(row.registered_at_ms),
    });
    integrity(
      source.sourceMomentId === origin.sourceMomentId &&
        source.sourceDigest === origin.sourceDigest &&
        source.sourceByteLength === origin.sourceByteLength &&
        (!source.activation ||
          source.activation.source.nativeHeadSequence === origin.expectedLocalSequence),
    );
    const originalBinding = parseLiveObjectBinding(origin.originalBinding);
    integrity(
      createHash("sha256").update(JSON.stringify(originalBinding)).digest("hex") ===
        origin.bindingDigest,
    );
    return { row, origin, binding, source, originalBinding };
  }
  openOwnerDelivery(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    actor: import("./types").CurrentLiveBindingRequest["actor"];
  }): OwnerDeliveryCapture {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const read = () => {
      this.#standing(host);
      const owner = this.#ownerRow(host, document);
      integrity(owner);
      const { row, binding, source, originalBinding } = this.#ownerOrigin(document, owner);
      integrity(row.admission_state === "open");
      const hostState = this.#storage.getLiveHostControl();
      integrity(hostState);
      const current = authorizeLiveDocument(
        this.#storage,
        { document, actor: input.actor },
        hostState,
        {
          binding,
          current: true,
          open: true,
          baselineSequence: authorityInteger(row.baseline_moment_relay_seq, 1),
        },
        this.activation,
      );
      integrity(current.kind === "current" && isDeepStrictEqual(current.host, host));
      integrity(isDeepStrictEqual(originalBinding, current.binding));
      return { row, origin: String(owner.origin_json), binding: current.binding, source };
    };
    const initial = this.#storage.readTx(read);
    const assertCurrent = () => {
      const current = read();
      integrity(isDeepStrictEqual(current, initial));
    };
    const high = this.#storage.db
      .prepare(
        `SELECT MAX(journal_cursor) AS cursor FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT}`,
      )
      .get(...documentParams(document))!;
    const capture = { binding: initial.binding, assertCurrent };
    this.#ownerDeliveries.set(capture, {
      host,
      document,
      highWater: high.cursor === null ? 0 : authorityInteger(high.cursor, 1),
    });
    return capture;
  }
  existingOwnerDelivery(
    input: Parameters<LiveCommittedDeliveryStore["openOwnerDelivery"]>[0],
  ): OwnerDeliveryCapture | null {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const exists = this.#storage.readTx(() => {
      this.#standing(host);
      const current = currentLiveDocumentBinding(
        this.#storage,
        { document, actor: input.actor },
        this.activation,
      );
      integrity(current.kind === "current" && isDeepStrictEqual(current.host, host));
      return this.#ownerRow(host, document) !== undefined;
    });
    return exists ? this.openOwnerDelivery({ ...input, host, document }) : null;
  }
  #ownerDelivery(capture: OwnerDeliveryCapture) {
    const saved = this.#ownerDeliveries.get(capture);
    integrity(saved);
    capture.assertCurrent();
    return saved;
  }
  /**
   * `sequence` is the greatest native sequence delivery proved. `adoptionSequence`
   * is the native head the host adopted at, as its adoption ACK confirmed.
   */
  ownerDeliveryProgress(capture: OwnerDeliveryCapture): {
    terminal: LiveUpdateReceipt | null;
    sequence: number;
    adoptionId: string;
    adoptionSequence: number;
    adoptionTerminal: LiveUpdateReceipt | null;
  } {
    const { host, document } = this.#ownerDelivery(capture),
      row = this.#ownerRow(host, document);
    integrity(row);
    const parsed = this.#ownerTip(row);
    integrity(authorityInteger(row.tip_application_sequence) <= authorityInteger(row.tip_sequence));
    const origin = JSON.parse(String(row.origin_json));
    return {
      terminal: parsed,
      sequence: authorityInteger(row.tip_sequence),
      adoptionId: parseLiveUpdateIdentifier(origin.adoptionId),
      adoptionSequence: authorityInteger(origin.expectedLocalSequence),
      adoptionTerminal:
        origin.terminalReceipt === null ? null : parseLiveUpdateReceipt(origin.terminalReceipt),
    };
  }
  /**
   * The adoption's owner delivery once its owner lost live authority, as after
   * Pause, Stop or the loss of the last Edit grant. It needs this connection's standing
   * and the adoption's exact binding, not the document's live authority, so
   * what the host already applied can settle. Null when the host never adopted it.
   */
  departedOwnerDelivery(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    adoptionId: string;
  }): DepartedOwnerDelivery | null {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID");
    return this.#storage.readTx(() => {
      const departed = this.#departed(host, document, adoptionId);
      return departed && { binding: departed.binding, tip: departed.tip, next: departed.next };
    });
  }
  /**
   * Records the host's ACK of the next row the journal accepted after the tip.
   * It accepts nothing: the ACK must match that row's whole receipt. An ACK of
   * the tip itself changes nothing. Returns the delivery after it.
   */
  recordDepartedApplication(
    input: {
      host: LiveHostConnectionCoordinate;
      document: LiveDocumentKey;
      adoptionId: string;
      binding: LiveObjectBinding;
    },
    value: unknown,
  ): DepartedOwnerDelivery {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID"),
      binding = parseLiveObjectBinding(input.binding);
    const ack = parseLiveUpdateHostApplicationAck(value);
    const acknowledged = {
      deliveryId: ack.deliveryId,
      updateDigest: ack.updateDigest,
      journalCursor: ack.journalCursor,
      acceptingHostEpoch: ack.acceptingHostEpoch,
    };
    return this.#storage.tx(() => {
      let departed = this.#departed(host, document, adoptionId);
      integrity(departed && isDeepStrictEqual(departed.binding, binding));
      if (sameReceipt(departed.tip, acknowledged))
        integrity(departed.owner.tip_application_sequence === ack.localYDocSequence);
      else {
        integrity(departed.next && sameReceipt(departed.next, acknowledged));
        this.#advanceOwnerTip(host, document, departed.owner, departed.next, ack);
        departed = this.#departed(host, document, adoptionId)!;
      }
      return { binding: departed.binding, tip: departed.tip, next: departed.next };
    });
  }
  #departed(host: LiveHostConnectionCoordinate, document: LiveDocumentKey, adoptionId: string) {
    this.#standing(host);
    const owner = this.#ownerRow(host, document);
    if (!owner) return null;
    const { origin, row, originalBinding } = this.#ownerOrigin(document, owner);
    integrity(origin.adoptionId === adoptionId);
    const binding = parseLiveObjectBinding({
      ...originalBinding,
      currentPath: row.current_path,
      restoreFenceGeneration: row.restore_fence_generation,
    });
    integrity(isDeepStrictEqual(originalBinding, binding));
    const tip = this.#ownerTip(owner);
    const raw = this.#storage.db
      .prepare(
        `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor>? ORDER BY journal_cursor LIMIT 1`,
      )
      .get(...documentParams(document), tip?.journalCursor ?? 0);
    let next: LiveUpdateReceipt | null = null;
    if (raw) {
      const decoded = decodeJournalRow(this.#storage.db, raw);
      assertJournalCheckpointPosition(this.#storage.db, decoded);
      verifyJournalRow(decoded);
      next = decoded.admitted.metadata.accepted.receipt;
    }
    return { owner, binding, tip, next };
  }
  #ownerTip(row: Record<string, unknown>): LiveUpdateReceipt | null {
    const terminal = JSON.parse(String(row.tip_receipt_json)),
      parsed = terminal === null ? null : parseLiveUpdateReceipt(terminal);
    integrity((parsed?.journalCursor ?? 0) === row.tip_cursor);
    return parsed;
  }
  nextOwnerApplication(capture: OwnerDeliveryCapture): AdmittedLiveUpdate | undefined {
    const { document, highWater } = this.#ownerDelivery(capture),
      progress = this.ownerDeliveryProgress(capture);
    const raw = this.#storage.db
      .prepare(
        `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`,
      )
      .get(...documentParams(document), progress.terminal?.journalCursor ?? 0, highWater);
    if (!raw) {
      integrity((progress.terminal?.journalCursor ?? 0) === highWater);
      return undefined;
    }
    const row = decodeJournalRow(this.#storage.db, raw);
    assertJournalCheckpointPosition(this.#storage.db, row);
    verifyJournalRow(row);
    return row.admitted;
  }
  /**
   * Whether the journal admitted a seed for the pending service activation
   * this delivery adopted for. It reads only relay rows.
   */
  hasPendingActivationSeed(capture: OwnerDeliveryCapture): boolean {
    const { document } = this.#ownerDelivery(capture),
      { adoptionId } = this.ownerDeliveryProgress(capture);
    return this.#storage.readTx(() => {
      const row = readServiceActivation(this.#storage, document);
      return (
        serviceActivationState(row) === "pending" &&
        row!.activation_id === adoptionId &&
        row!.relay_database_namespace === this.#history.namespace &&
        serviceActivationSeed(this.#storage, row!) !== null
      );
    });
  }
  acknowledgeOwnerDeliveryApplication(capture: OwnerDeliveryCapture, value: unknown): void {
    this.#acknowledgeOwnerApplication(capture, value);
  }
  #acknowledgeOwnerApplication(
    capture: OwnerDeliveryCapture,
    value: unknown,
    predecessor?: LiveUpdateReceipt | null,
  ): void {
    const ack = parseLiveUpdateHostApplicationAck(value),
      { host, document } = this.#ownerDelivery(capture);
    this.#storage.tx(() => {
      const acknowledged = {
        deliveryId: ack.deliveryId,
        updateDigest: ack.updateDigest,
        journalCursor: ack.journalCursor,
        acceptingHostEpoch: ack.acceptingHostEpoch,
      };
      if (predecessor !== undefined) {
        const progress = this.ownerDeliveryProgress(capture);
        if (sameReceipt(progress.terminal, acknowledged)) {
          const row = this.#ownerRow(host, document);
          integrity(row && row.tip_application_sequence === ack.localYDocSequence);
          const previous = this.#storage.db
            .prepare(
              `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<? ORDER BY journal_cursor DESC LIMIT 1`,
            )
            .get(...documentParams(document), ack.journalCursor);
          if (previous) {
            const decoded = decodeJournalRow(this.#storage.db, previous);
            assertJournalCheckpointPosition(this.#storage.db, decoded);
            verifyJournalRow(decoded);
            integrity(sameReceipt(decoded.admitted.metadata.accepted.receipt, predecessor));
          } else integrity(predecessor === null);
          return;
        }
        integrity(sameReceipt(progress.terminal, predecessor));
      }
      const next = this.nextOwnerApplication(capture);
      integrity(next);
      const receipt = next.metadata.accepted.receipt;
      integrity(sameReceipt(receipt, acknowledged));
      const row = this.#ownerRow(host, document);
      integrity(row);
      this.#advanceOwnerTip(host, document, row, receipt, ack);
    }, document);
  }
  // Moves the owner tip to the next accepted receipt, whose ACK the caller matched.
  #advanceOwnerTip(
    host: LiveHostConnectionCoordinate,
    document: LiveDocumentKey,
    row: Record<string, unknown>,
    receipt: LiveUpdateReceipt,
    ack: ReturnType<typeof parseLiveUpdateHostApplicationAck>,
  ): void {
    // Content dedupe reports the original native update sequence. Retain the
    // greatest sequence already proved by an authenticated application ACK.
    const sequence = Math.max(authorityInteger(row.tip_sequence), ack.localYDocSequence);
    const tip = JSON.stringify(receipt),
      values = [
        this.#history.namespace,
        ...documentParams(document),
        host.hostId,
        row.origin_json,
        tip,
        ack.journalCursor,
        sequence,
        ack.localYDocSequence,
      ];
    const charge = Buffer.byteLength(JSON.stringify(values)),
      previousCharge = authorityInteger(row.accounted_bytes, 1),
      delta = Math.max(1, charge - previousCharge);
    consumeLiveDeliveryReservation(
      this.#storage,
      document,
      host.hostId,
      ack.journalCursor,
      delta,
      true,
    );
    const refund = previousCharge + delta - charge;
    if (refund) this.#refundOwner(document.workspaceId, refund);
    const changed = this.#storage.db
      .prepare(
        `UPDATE ${OWNERS} SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,tip_application_sequence=?,accounted_bytes=? WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`,
      )
      .run(
        tip,
        ack.journalCursor,
        sequence,
        ack.localYDocSequence,
        charge,
        this.#history.namespace,
        ...documentParams(document),
        host.hostId,
      );
    integrity(changed.changes === 1);
  }
  captureOwnerBinding(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    actor: import("./types").CurrentLiveBindingRequest["actor"];
  }) {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document),
      actor = structuredClone(input.actor);
    const read = () => {
      this.#standing(host);
      const current = currentLiveDocumentBinding(
        this.#storage,
        { document, actor },
        this.activation,
      );
      integrity(current.kind === "current" && isDeepStrictEqual(current.host, host));
      return current;
    };
    const initial = this.#storage.readTx(read);
    return {
      binding: structuredClone(initial.binding),
      assertCurrent: () => {
        integrity(isDeepStrictEqual(this.#storage.readTx(read), initial));
      },
    };
  }
  captureOwnerCut(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
    adoptionId: string;
    expectedLocalSequence: number;
    maxBytes: number;
    maxEvents: number;
    throughCursor?: number;
    actor?: import("./types").CurrentLiveBindingRequest["actor"];
    retirement?: RetirementKey;
  }): OwnerCutCapture {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID");
    const sequence = authorityInteger(input.expectedLocalSequence),
      maxBytes = authorityInteger(input.maxBytes, 1),
      maxEvents = authorityInteger(input.maxEvents, 1);
    const requestedCursor =
      input.throughCursor === undefined ? undefined : authorityInteger(input.throughCursor);
    const captured = this.#storage.readTx(() => {
      this.#standing(host);
      const result = liveJournalCut(this.#storage, document, input.retirement);
      if (result.kind !== "cut") throw new Error(`Owner adoption ${result.reason}.`);
      const authority = result.cut.authorityHistory.find((row) => row.current)!;
      const authorized = input.actor
        ? currentLiveDocumentBinding(
            this.#storage,
            { document, actor: input.actor },
            this.activation,
          )
        : undefined;
      if (
        authorized &&
        (authorized.kind !== "current" || !isDeepStrictEqual(authorized.host, host))
      )
        throw new Error("Owner standing changed.");
      const source = this.#ownerSource(document, adoptionId, authority);
      // Without an actor, as when a retirement recovers an adoption whose ACK was lost, a service activation keeps the binding it was granted.
      const binding =
        authorized?.kind === "current"
          ? authorized.binding
          : (source.activation?.binding ?? authority.binding);
      integrity(!source.activation || source.activation.source.nativeHeadSequence === sequence);
      const prefix = this.#retainedPrefix(source.activation?.source);
      const events: AdmittedLiveUpdate[] = [];
      let bytes = authority.baselineBytes.byteLength;
      if (prefix) {
        // A successor adopts at its predecessor's released boundary; ordinary delivery then brings what the journal accepted after it.
        // Before adoption the engine reports no cursor of its own.
        integrity(
          requestedCursor === undefined ||
            requestedCursor === 0 ||
            requestedCursor === (prefix.terminalReceipt?.journalCursor ?? 0),
        );
      } else {
        const count = this.#storage.db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(length(update_bytes)),0) AS bytes FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=?`,
          )
          .get(...documentParams(document), requestedCursor ?? Number.MAX_SAFE_INTEGER)!;
        if (authorityInteger(count.count) > maxEvents || authorityInteger(count.bytes) > maxBytes)
          throw new Error(
            `Owner adoption cut exceeds configured bounds: ${count.count} journal events / ${maxEvents} allowed; ${count.bytes} journal bytes / ${maxBytes} allowed.`,
          );
        for (const raw of this.#storage.db
          .prepare(
            `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=? ORDER BY journal_cursor`,
          )
          .iterate(...documentParams(document), requestedCursor ?? Number.MAX_SAFE_INTEGER)) {
          const row = decodeJournalRow(this.#storage.db, raw);
          assertJournalCheckpointPosition(this.#storage.db, row);
          verifyJournalRow(row);
          bytes +=
            row.admitted.updateBytes.byteLength +
            Buffer.byteLength(JSON.stringify(row.admitted.metadata)) +
            8;
          if (bytes > maxBytes || events.length === maxEvents)
            throw new Error("Owner adoption cut exceeds its configured bounds.");
          events.push(row.admitted);
        }
        integrity(
          (events.at(-1)?.metadata.accepted.receipt.journalCursor ?? 0) ===
            (requestedCursor ?? result.cut.highWater ?? 0) && events.length === count.count,
        );
      }
      const terminal = prefix
        ? prefix.terminalReceipt
        : (events.at(-1)?.metadata.accepted.receipt ?? null);
      const cut: LiveOwnerAdoptionCut = {
        relayDatabaseNamespace: this.#history.namespace,
        adoptionId,
        sourceMomentId: source.sourceMomentId,
        sourceDigest: source.sourceDigest,
        sourceByteLength: source.sourceByteLength,
        baselineMomentRelaySequence: authority.baselineSequence,
        baselineRegisteredAtMs: authority.registeredAtMs,
        expectedLocalSequence: sequence,
        terminalReceipt: terminal,
        retainedPrefix: prefix,
        baselineBytes: new Uint8Array(authority.baselineBytes),
        events,
      };
      const { events: _events, baselineBytes: _baseline, ...header } = cut;
      if (
        bytes + Buffer.byteLength(JSON.stringify({ ...header, eventCount: events.length })) + 8 >
        maxBytes
      )
        throw new Error("Owner adoption cut exceeds its configured bounds.");
      return {
        journal: result.cut,
        authority: structuredClone(authority),
        binding: structuredClone(binding),
        source: { ...source },
        cut,
      };
    });
    verifyJournalCut(captured.journal);
    const assertCurrent = (): void => {
      this.#standing(host);
      const raw = this.#storage.db
        .prepare(`SELECT * FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`)
        .get(...documentParams(document));
      integrity(
        raw &&
          isDeepStrictEqual(
            decodeLiveDocumentAuthorityStructure(this.#storage.db, document, raw),
            captured.authority,
          ),
      );
      const source = this.#ownerSource(document, adoptionId, captured.authority);
      integrity(isDeepStrictEqual(source, captured.source));
      if (input.actor) {
        const authorized = currentLiveDocumentBinding(
          this.#storage,
          { document, actor: input.actor },
          this.activation,
        );
        integrity(
          authorized.kind === "current" &&
            isDeepStrictEqual(authorized.binding, captured.binding) &&
            isDeepStrictEqual(authorized.host, host),
        );
      }
    };
    assertCurrent();
    const capture = {
      binding: structuredClone(captured.binding),
      cut: captured.cut,
      assertCurrent,
    };
    this.#ownerCuts.set(capture, {
      host,
      document,
      digest: ownerCutDigest(capture),
      activation: captured.source.activation?.source ?? null,
    });
    return capture;
  }
  #ownerCapture(capture: OwnerCutCapture) {
    const saved = this.#ownerCuts.get(capture);
    integrity(saved && saved.digest === ownerCutDigest(capture));
    capture.assertCurrent();
    return saved;
  }
  #ownerRow(host: LiveHostConnectionCoordinate, document: LiveDocumentKey) {
    return this.#storage.db
      .prepare(
        `SELECT * FROM ${OWNERS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`,
      )
      .get(this.#history.namespace, ...documentParams(document), host.hostId);
  }
  acknowledgeOwnerAdoption(capture: OwnerCutCapture, value: unknown): void {
    const { host, document, activation } = this.#ownerCapture(capture),
      cut = capture.cut;
    const ack = baselineRecord(value, [
      "adoptionId",
      "localYDocSequence",
      "terminalCursor",
      "adoptionReplayed",
    ]);
    integrity(
      ack.adoptionId === cut.adoptionId &&
        ack.localYDocSequence === cut.expectedLocalSequence &&
        ack.terminalCursor === (cut.terminalReceipt?.journalCursor ?? 0) &&
        typeof ack.adoptionReplayed === "boolean",
    );
    // The evidence digest binds a successor's prefix, so the origin keeps only its count and history.
    const { baselineBytes: _baseline, events: _events, retainedPrefix: prefix, ...header } = cut;
    const cutEvidenceDigest = ownerAdoptionCutEvidenceDigest(capture.binding, cut);
    // Native adoption of an ordinary service activation also binds its retained source, as native evidence does.
    const originEvidenceDigest =
      activation === null
        ? cutEvidenceDigest
        : createHash("sha256")
            .update(JSON.stringify(["ordinary-replication", cutEvidenceDigest, activation]))
            .digest("hex");
    const originEventCount = prefix ? prefix.eventCount : cut.events.length;
    const originHistoryEvidenceDigest = prefix
      ? prefix.historyEvidenceDigest
      : cut.events.reduce(
          (previous, event, index) =>
            nextVersionedAcceptedHistoryDigest(previous, index + 1, event.metadata),
          initialAcceptedHistoryDigest(this.#history.namespace, document),
        );
    const origin = JSON.stringify({
      ...header,
      bindingDigest: createHash("sha256").update(JSON.stringify(capture.binding)).digest("hex"),
      originEvidenceDigest,
      originEventCount,
      originHistoryEvidenceDigest,
      originalBinding: structuredClone(capture.binding),
    });
    this.#storage.tx(() => {
      this.#ownerCapture(capture);
      if (cut.terminalReceipt) {
        const endpoint = this.#storage.db
          .prepare(`SELECT relay_database_namespace,accepted_event_count,accepted_evidence_digest FROM ${LIVE_JOURNAL_TABLE}
          WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`)
          .get(...documentParams(document), cut.terminalReceipt.journalCursor);
        integrity(
          endpoint &&
            endpoint.relay_database_namespace === this.#history.namespace &&
            endpoint.accepted_event_count === originEventCount &&
            endpoint.accepted_evidence_digest === originHistoryEvidenceDigest,
        );
      }
      bindLiveDeliveryHostNamespace(
        this.#storage,
        document.workspaceId,
        host.hostId,
        this.#history.namespace,
      );
      integrity(
        !this.#storage.db
          .prepare(
            `SELECT 1 FROM ${BOOTSTRAPS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`,
          )
          .get(this.#history.namespace, ...documentParams(document), host.hostId),
      );
      const previous = this.#ownerRow(host, document);
      if (previous) {
        integrity(
          previous.origin_json === origin &&
            Number(previous.tip_cursor) >= Number(ack.terminalCursor),
        );
        return;
      }
      // A service activation adopts on one host, once: it retires only there.
      if (
        activation &&
        this.#storage.db
          .prepare(`SELECT 1 FROM ${OWNERS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id<>?
          AND json_extract(origin_json,'$.adoptionId')=? LIMIT 1`)
          .get(this.#history.namespace, ...documentParams(document), host.hostId, cut.adoptionId)
      ) {
        throw new Error("Service activation adopted on another host.");
      }
      const tip = JSON.stringify(cut.terminalReceipt),
        cursor = cut.terminalReceipt?.journalCursor ?? 0;
      const values = [
        this.#history.namespace,
        ...documentParams(document),
        host.hostId,
        origin,
        tip,
        cursor,
        cut.expectedLocalSequence,
        cut.expectedLocalSequence,
      ];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage, document, host.hostId, 0, charge, true);
      if (prefix) adoptLiveDeliveryPrefix(this.#storage, document, host.hostId, cursor);
      for (const event of cut.events) {
        consumeLiveDeliveryReservation(
          this.#storage,
          document,
          host.hostId,
          event.metadata.accepted.receipt.journalCursor,
          1,
          true,
        );
        this.#refundOwner(document.workspaceId, 1);
      }
      this.#storage.db
        .prepare(
          `INSERT INTO ${OWNERS}(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,origin_json,tip_receipt_json,tip_cursor,tip_sequence,tip_application_sequence,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values, charge);
    });
  }
  #refundOwner(workspaceId: string, amount: number) {
    integrity(
      this.#storage.db
        .prepare(
          "UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?",
        )
        .run(amount, workspaceId, amount).changes === 1,
    );
  }
  #standing(host: LiveHostConnectionCoordinate): void {
    requireLiveJournalHistory(this.#storage, this.#history);
    const standing = journalHost(this.#storage.db, host);
    if ("kind" in standing) throw new Error(`Committed delivery ${standing.reason}.`);
  }
  #capture(drain: CommittedDeliveryDrain): DrainCapture {
    const capture = this.#drains.get(drain);
    if (!capture) throw new TypeError("Unknown committed delivery drain.");
    this.#standing(capture.host);
    const raw = this.#storage.db
      .prepare(
        `SELECT workspace_id,main_version_id,object_id,lineage_claim_id,current_path,
          restore_fence_generation,replaces_lineage_claim_id,registered_at_ms,lineage_state,
          admission_state,retired_at_ms,baseline_digest,baseline_projected_sha256,
          baseline_projected_byte_length,baseline_moment_relay_seq,baseline_bytes=? AS baseline_matches
          FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`,
      )
      .get(capture.authority.baselineBytes, ...documentParams(capture.document));
    integrity(raw && raw.baseline_matches === 1);
    const authority = decodeLiveDocumentAuthorityStructure(this.#storage.db, capture.document, {
      ...raw,
      baseline_bytes: capture.authority.baselineBytes,
    });
    integrity(isDeepStrictEqual(authority, capture.authority));
    if (capture.terminal) {
      const terminal = this.#storage.db
        .prepare(
          `SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
        )
        .get(...documentParams(capture.document), capture.terminal.journalCursor);
      integrity(terminal && sameReceipt(receipt(terminal), capture.terminal));
    }
    return capture;
  }
  #bootstrapRow(capture: DrainCapture): Record<string, unknown> {
    const row = this.#storage.db
      .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
      .get(this.#history.namespace, ...documentParams(capture.document), capture.host.hostId);
    integrity(row);
    const b = capture.baseline;
    integrity(
      isDeepStrictEqual(parseLiveObjectBinding(JSON.parse(String(row.binding_json))), b.binding),
    );
    integrity(
      row.bootstrap_id === b.bootstrapId &&
        row.bootstrap_moment_id === b.bootstrapMomentId &&
        row.baseline_digest === b.baselineDigest &&
        row.baseline_byte_length === b.baselineBytes.byteLength &&
        row.baseline_moment_relay_seq === b.baselineMomentRelaySequence &&
        row.baseline_registered_at_ms === b.baselineRegisteredAtMs &&
        row.projected_markdown_digest === b.projectedMarkdownDigest &&
        row.projected_markdown_byte_length === b.projectedMarkdownByteLength,
    );
    authorityInteger(row.accounted_bytes, 1);
    if (row.local_ydoc_sequence === null) {
      integrity(
        [row.ack_host_mode, row.ack_host_epoch, row.ack_instance_id, row.ack_connection_id].every(
          (x) => x === null,
        ),
      );
    } else {
      authorityInteger(row.local_ydoc_sequence);
      snapshotHostCoordinate({
        mode: row.ack_host_mode,
        hostId: row.host_id,
        hostEpoch: row.ack_host_epoch,
        instanceId: row.ack_instance_id,
        connectionId: row.ack_connection_id,
      });
    }
    return row;
  }
  open(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
  }): CommittedDeliveryDrain {
    return this.#open(input, true);
  }
  /** Whether `host` acknowledged the document's bootstrap. It only reads: it opens no drain and writes nothing. */
  bootstrapApplied(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
  }): boolean {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    return this.#storage.readTx(() => {
      const row = this.#storage.db
        .prepare(`SELECT local_ydoc_sequence FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
        .get(this.#history.namespace, ...documentParams(document), host.hostId);
      return row !== undefined && row.local_ydoc_sequence !== null;
    });
  }
  openSettlement(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
  }): CommittedDeliveryDrain {
    return this.#open(input, false);
  }
  #open(
    input: {
      host: LiveHostConnectionCoordinate;
      document: LiveDocumentKey;
    },
    createBootstrap: boolean,
  ): CommittedDeliveryDrain {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const read = this.#storage.readTx(() => {
      this.#standing(host);
      const cut = liveJournalCut(this.#storage, document);
      if (cut.kind !== "cut") throw new Error(`Committed delivery ${cut.reason}.`);
      const authority = cut.cut.authorityHistory.find((row) => row.current)!;
      const terminalRaw =
        cut.cut.highWater === null
          ? null
          : this.#storage.db
              .prepare(
                `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
              )
              .get(...documentParams(document), cut.cut.highWater);
      integrity(cut.cut.highWater === null || terminalRaw);
      const terminal = terminalRaw ? decodeJournalRow(this.#storage.db, terminalRaw) : null;
      return { cut: cut.cut, authority, terminal };
    });
    verifyJournalCut(read.cut);
    if (read.terminal) verifyJournalRow(read.terminal);
    return this.#createDrain(
      host,
      document,
      read.authority,
      read.terminal?.admitted.metadata.accepted.receipt ?? null,
      createBootstrap,
    );
  }
  #createDrain(
    host: LiveHostConnectionCoordinate,
    document: LiveDocumentKey,
    authority: StoredLiveDocumentAuthority,
    terminal: LiveUpdateReceipt | null,
    createBootstrap: boolean,
  ): CommittedDeliveryDrain {
    const baseline: CommittedBootstrap = {
      bootstrapId: randomUUID(),
      bootstrapMomentId: randomUUID(),
      binding: structuredClone(authority.binding),
      baselineMomentRelaySequence: authority.baselineSequence,
      baselineRegisteredAtMs: authority.registeredAtMs,
      baselineDigest: authority.baselineDigest,
      projectedMarkdownDigest: authority.projectedDigest,
      projectedMarkdownByteLength: authority.projectedLength,
      baselineBytes: new Uint8Array(authority.baselineBytes),
    };
    const capture: DrainCapture = {
      host,
      document,
      authority: structuredClone(authority),
      baseline,
      terminal,
    };
    const drain: CommittedDeliveryDrain = Object.freeze({
      get baseline() {
        return copiedBaseline(capture.baseline);
      },
      get terminalReceipt() {
        return capture.terminal ? { ...capture.terminal } : null;
      },
    });
    this.#drains.set(drain, capture);
    try {
      this.#storage.tx(() => {
        this.#capture(drain);
        bindLiveDeliveryHostNamespace(
          this.#storage,
          document.workspaceId,
          host.hostId,
          this.#history.namespace,
        );
        const row = this.#storage.db
          .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
          .get(this.#history.namespace, ...documentParams(document), host.hostId);
        if (row) {
          capture.baseline = {
            ...baseline,
            bootstrapId: parseLiveUpdateIdentifier(row.bootstrap_id, "bootstrap ID"),
            bootstrapMomentId: parseLiveUpdateIdentifier(
              row.bootstrap_moment_id,
              "bootstrap moment ID",
            ),
          };
          this.#bootstrapRow(capture);
          return;
        }
        if (!createBootstrap) throw new Error("Committed delivery must finish before settlement.");
        // A retired owner adoption on this host consumed the lineage's adoption reservation and covers what it applied.
        if (
          this.#storage.db
            .prepare(
              `SELECT 1 FROM ${LIVE_DELIVERY_OWNER_HISTORY} WHERE ${WHERE_DOCUMENT} AND host_id=?`,
            )
            .get(...documentParams(document), host.hostId)
        ) {
          throw new Error("Committed delivery follows a retired owner adoption.");
        }
        // A service activation's lineage is delivered only through its owner adoption, and is funded only for that.
        if (hasServiceActivation(this.#storage, document)) {
          throw new Error("Committed delivery cannot bootstrap a service activation's lineage.");
        }
        const values = [
          baseline.bootstrapId,
          baseline.bootstrapMomentId,
          this.#history.namespace,
          ...documentParams(document),
          host.hostId,
          JSON.stringify(baseline.binding),
          baseline.baselineMomentRelaySequence,
          baseline.baselineRegisteredAtMs,
          baseline.baselineDigest,
          baseline.baselineBytes.byteLength,
          baseline.projectedMarkdownDigest,
          baseline.projectedMarkdownByteLength,
        ];
        const charge = Buffer.byteLength(JSON.stringify(values));
        consumeLiveDeliveryReservation(this.#storage, document, host.hostId, 0, charge, false);
        this.#storage.db
          .prepare(
            `INSERT INTO ${BOOTSTRAPS}(bootstrap_id,bootstrap_moment_id,relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,
          binding_json,baseline_moment_relay_seq,baseline_registered_at_ms,baseline_digest,baseline_byte_length,projected_markdown_digest,projected_markdown_byte_length,accounted_bytes)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(...values, charge);
        this.#bootstrapRow(capture);
      });
      return drain;
    } catch (error) {
      this.#drains.delete(drain);
      throw error;
    }
  }
  #nextReceipt(capture: DrainCapture, after: number): LiveUpdateReceipt | null {
    const row = this.#storage.db
      .prepare(
        `SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE}
      WHERE ${WHERE_DOCUMENT} AND journal_cursor>? AND journal_cursor<=? ORDER BY journal_cursor LIMIT 1`,
      )
      .get(...documentParams(capture.document), after, capture.terminal?.journalCursor ?? 0);
    return row ? receipt(row) : null;
  }
  #progress(capture: DrainCapture): {
    bootstrap: Record<string, unknown>;
    predecessor: LiveUpdateReceipt | null;
  } {
    const bootstrap = this.#bootstrapRow(capture);
    const tip =
      this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor<=? ORDER BY journal_cursor DESC LIMIT 1`,
        )
        .get(capture.baseline.bootstrapId, capture.terminal?.journalCursor ?? 0) ?? null;
    if (capture.progress && isDeepStrictEqual(tip, capture.progress.tip)) {
      return { bootstrap, predecessor: capture.progress.predecessor };
    }
    capture.checkpoint = undefined;
    const edges = this.#storage.db
      .prepare(
        `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor<=? ORDER BY journal_cursor`,
      )
      .all(capture.baseline.bootstrapId, capture.terminal?.journalCursor ?? 0);
    if (bootstrap.local_ydoc_sequence === null) integrity(edges.length === 0);
    let predecessor: LiveUpdateReceipt | null = null;
    for (const edge of edges) {
      integrity(
        bootstrap.local_ydoc_sequence !== null &&
          edge.workspace_id === capture.document.workspaceId &&
          edge.predecessor_cursor === (predecessor?.journalCursor ?? 0),
      );
      const expected = this.#nextReceipt(capture, predecessor?.journalCursor ?? 0);
      integrity(expected && sameReceipt(receipt(edge), expected));
      authorityInteger(edge.local_ydoc_sequence, 1);
      authorityInteger(edge.accounted_bytes, 1);
      snapshotHostCoordinate({
        mode: edge.ack_host_mode,
        hostId: capture.host.hostId,
        hostEpoch: edge.ack_host_epoch,
        instanceId: edge.ack_instance_id,
        connectionId: edge.ack_connection_id,
      });
      predecessor = expected;
    }
    capture.progress = { predecessor, tip };
    return { bootstrap, predecessor };
  }
  #checkpointPosition(
    capture: DrainCapture,
    row: ReturnType<typeof decodeJournalRow>,
  ): NonNullable<DrainCapture["checkpoint"]> {
    const current = row.admitted.metadata.accepted.receipt,
      prior = capture.checkpoint;
    const rowBytes = row.admitted.updateBytes.byteLength,
      hasCheckpoint = row.checkpoint !== null;
    if (prior && sameReceipt(prior.receipt, current)) {
      integrity(prior.rowBytes === rowBytes && prior.hasCheckpoint === hasCheckpoint);
      return prior;
    }
    let position;
    if (prior && sameReceipt(this.#nextReceipt(capture, prior.receipt.journalCursor), current)) {
      const count = (prior.hasCheckpoint ? 0 : prior.count) + 1;
      const bytes = (prior.hasCheckpoint ? 0 : prior.bytes) + rowBytes;
      integrity(
        count <= 4095 &&
          hasCheckpoint ===
            (row.admitted.metadata.checkpointCoverage !== undefined ||
              liveJournalCheckpointDue(count, bytes)),
      );
      position = { count, bytes };
    } else {
      position = assertJournalCheckpointPosition(this.#storage.db, row);
    }
    return { receipt: current, ...position, rowBytes, hasCheckpoint };
  }
  next(drain: CommittedDeliveryDrain): CommittedDeliveryStep {
    const result = this.#storage.readTx(() => {
      const capture = this.#capture(drain),
        progress = this.#progress(capture);
      if (progress.bootstrap.local_ydoc_sequence === null)
        return {
          kind: "bootstrap" as const,
          baseline: copiedBaseline(capture.baseline),
        };
      const next = this.#nextReceipt(capture, progress.predecessor?.journalCursor ?? 0);
      if (!next) {
        integrity(sameReceipt(progress.predecessor, capture.terminal));
        return {
          kind: "done" as const,
          terminalReceipt: capture.terminal ? { ...capture.terminal } : null,
        };
      }
      const raw = this.#storage.db
        .prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`)
        .get(...documentParams(capture.document), next.journalCursor);
      integrity(raw);
      const row = decodeJournalRow(this.#storage.db, raw),
        checkpoint = this.#checkpointPosition(capture, row);
      return {
        kind: "next" as const,
        row,
        predecessor: progress.predecessor,
        capture,
        checkpoint,
      };
    });
    if (result.kind !== "next") return result;
    verifyJournalRow(result.row);
    result.capture.checkpoint = result.checkpoint;
    return {
      kind: "next",
      admitted: result.row.admitted,
      predecessor: result.predecessor ? { ...result.predecessor } : null,
    };
  }

  settlement(drain: CommittedDeliveryDrain): {
    binding: LiveObjectBinding;
    terminalReceipt: LiveUpdateReceipt | null;
  } {
    const next = this.next(drain);
    if (next.kind !== "done") throw new Error("Committed delivery must finish before settlement.");
    const capture = this.#drains.get(drain)!;
    return {
      binding: structuredClone(capture.authority.binding),
      terminalReceipt: next.terminalReceipt,
    };
  }
  acknowledgeBootstrap(drain: CommittedDeliveryDrain, input: unknown): void {
    const ack = parseBootstrapAck(input);
    this.#storage.tx(() => {
      const capture = this.#capture(drain),
        b = capture.baseline,
        row = this.#bootstrapRow(capture);
      integrity(
        ack.bootstrapId === b.bootstrapId &&
          ack.bootstrapMomentId === b.bootstrapMomentId &&
          ack.baselineDigest === b.baselineDigest &&
          ack.baselineMomentRelaySequence === b.baselineMomentRelaySequence,
      );
      if (row.local_ydoc_sequence !== null) {
        integrity(row.local_ydoc_sequence === ack.localYDocSequence);
        return;
      }
      const h = capture.host,
        charge = Buffer.byteLength(
          JSON.stringify([
            ack.localYDocSequence,
            h.mode,
            h.hostEpoch,
            h.instanceId,
            h.connectionId,
          ]),
        );
      consumeLiveDeliveryReservation(this.#storage, capture.document, h.hostId, 0, charge, true);
      this.#storage.db
        .prepare(
          `UPDATE ${BOOTSTRAPS} SET local_ydoc_sequence=?,ack_host_mode=?,ack_host_epoch=?,ack_instance_id=?,ack_connection_id=?,accounted_bytes=accounted_bytes+? WHERE bootstrap_id=? AND local_ydoc_sequence IS NULL`,
        )
        .run(
          ack.localYDocSequence,
          h.mode,
          h.hostEpoch,
          h.instanceId,
          h.connectionId,
          charge,
          b.bootstrapId,
        );
      integrity(this.#bootstrapRow(capture).local_ydoc_sequence === ack.localYDocSequence);
    });
  }
  acknowledge(
    drain: CommittedDeliveryDrain,
    predecessor: LiveUpdateReceipt | null,
    input: unknown,
  ): void {
    const ack = parseLiveUpdateHostApplicationAck(input),
      previous = predecessor === null ? null : parseLiveUpdateReceipt(predecessor),
      scope = this.#drains.get(drain);
    this.#storage.tx(() => {
      const capture = this.#capture(drain),
        progress = this.#progress(capture);
      integrity(progress.bootstrap.local_ydoc_sequence !== null);
      integrity(capture.terminal && ack.journalCursor <= capture.terminal.journalCursor);
      const repeated = this.#storage.db
        .prepare(`SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`)
        .get(capture.baseline.bootstrapId, ack.journalCursor);
      if (repeated) {
        integrity(
          sameReceipt(
            receipt(repeated),
            parseLiveUpdateReceipt({
              deliveryId: ack.deliveryId,
              updateDigest: ack.updateDigest,
              journalCursor: ack.journalCursor,
              acceptingHostEpoch: ack.acceptingHostEpoch,
            }),
          ) &&
            repeated.predecessor_cursor === (previous?.journalCursor ?? 0) &&
            repeated.local_ydoc_sequence === ack.localYDocSequence,
        );
        if (previous) {
          const original = this.#storage.db
            .prepare(`SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`)
            .get(capture.baseline.bootstrapId, previous.journalCursor);
          integrity(original && sameReceipt(receipt(original), previous));
        }
        return;
      }
      integrity(sameReceipt(progress.predecessor, previous));
      const expected = this.#nextReceipt(capture, previous?.journalCursor ?? 0);
      integrity(
        expected &&
          expected.deliveryId === ack.deliveryId &&
          expected.updateDigest === ack.updateDigest &&
          expected.journalCursor === ack.journalCursor &&
          expected.acceptingHostEpoch === ack.acceptingHostEpoch,
      );
      const h = capture.host,
        values = [
          capture.baseline.bootstrapId,
          capture.document.workspaceId,
          ack.journalCursor,
          previous?.journalCursor ?? 0,
          ack.deliveryId,
          ack.updateDigest,
          ack.acceptingHostEpoch,
          ack.localYDocSequence,
          h.mode,
          h.hostEpoch,
          h.instanceId,
          h.connectionId,
        ];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(
        this.#storage,
        capture.document,
        h.hostId,
        ack.journalCursor,
        charge,
        true,
      );
      this.#storage.db
        .prepare(
          `INSERT INTO ${EDGES}(bootstrap_id,workspace_id,journal_cursor,predecessor_cursor,delivery_id,update_digest,accepting_host_epoch,local_ydoc_sequence,ack_host_mode,ack_host_epoch,ack_instance_id,ack_connection_id,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values, charge);
      const inserted = this.#storage.db
        .prepare(`SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`)
        .get(capture.baseline.bootstrapId, ack.journalCursor);
      integrity(
        inserted &&
          sameReceipt(receipt(inserted), expected) &&
          inserted.predecessor_cursor === (previous?.journalCursor ?? 0) &&
          inserted.local_ydoc_sequence === ack.localYDocSequence,
      );
      capture.progress = { predecessor: expected, tip: inserted };
    }, scope?.document);
  }
  close(drain: CommittedDeliveryDrain): void {
    this.#drains.delete(drain);
  }
}
