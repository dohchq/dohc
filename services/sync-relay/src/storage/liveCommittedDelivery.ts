import { randomUUID, createHash } from "node:crypto";
import type { LiveOwnerAdoptionCut } from "@dohc/workspace-engine-client/daemon";
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
import type {
  LiveHostConnectionCoordinate,
  StoredLiveDocumentAuthority,
} from "./types";
import { snapshotHostCoordinate } from "../liveTicketInputs";
import {
  authorityInteger,
  baselineRecord,
  decodeLiveDocumentAuthorityStructure,
  currentLiveDocumentBinding,
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
import { bindLiveDeliveryHostNamespace, consumeLiveDeliveryReservation } from "./liveDeliveryReservations";

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
  if (!condition)
    throw new Error("Committed delivery evidence is damaged or conflicts.");
}
function receipt(row: Record<string, unknown>): LiveUpdateReceipt {
  return parseLiveUpdateReceipt({
    deliveryId: row.delivery_id,
    updateDigest: row.update_digest,
    journalCursor: row.journal_cursor,
    acceptingHostEpoch: row.accepting_host_epoch,
  });
}
function sameReceipt(
  a: LiveUpdateReceipt | null,
  b: LiveUpdateReceipt | null,
): boolean {
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
    bootstrapMomentId: parseLiveUpdateIdentifier(
      row.bootstrapMomentId,
      "bootstrap moment ID",
    ),
    baselineDigest: parseLiveUpdateDigest(row.baselineDigest),
    baselineMomentRelaySequence: authorityInteger(
      row.baselineMomentRelaySequence,
      1,
    ),
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
  const { baselineBytes,events,...header } = capture.cut;
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  return digest(Buffer.from(JSON.stringify({ binding: capture.binding,...header,baselineDigest: digest(baselineBytes),
    events: events.map(event => ({ metadata: event.metadata,digest: digest(event.updateBytes) })) })));
}

/** Internal storage consumer. Authentication and namespace provisioning belong to its caller. */
export class LiveCommittedDeliveryStore {
  readonly #drains = new WeakMap<CommittedDeliveryDrain, DrainCapture>();
  readonly #storage: StorageContext;
  readonly #history: LiveJournalHistoryAuthority;
  readonly #ownerCuts = new WeakMap<OwnerCutCapture,{ host: LiveHostConnectionCoordinate; document: LiveDocumentKey; digest: string }>();
  constructor(storage: StorageContext, history: LiveJournalHistoryAuthority) {
    this.#storage = storage;
    this.#history = history;
    attachLiveJournalHistory(storage, history);
  }
  captureOwnerCut(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey; adoptionId: string;
    expectedLocalSequence: number; maxBytes: number; maxEvents: number; throughCursor?: number;
    actor?: import("./types").CurrentLiveBindingRequest["actor"] }): OwnerCutCapture {
    const host = snapshotHostCoordinate(input.host), document = journalDocument(input.document);
    const adoptionId = parseLiveUpdateIdentifier(input.adoptionId, "adoption ID");
    const sequence = authorityInteger(input.expectedLocalSequence), maxBytes = authorityInteger(input.maxBytes, 1), maxEvents = authorityInteger(input.maxEvents, 1);
    const requestedCursor = input.throughCursor === undefined ? undefined : authorityInteger(input.throughCursor);
    const captured = this.#storage.readTx(() => {
      this.#standing(host);
      const count = this.#storage.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(update_bytes)),0) AS bytes FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=?`).get(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)!;
      if (authorityInteger(count.count) > maxEvents || authorityInteger(count.bytes) > maxBytes) throw new Error("Owner adoption cut exceeds its configured bounds.");
      const result = liveJournalCut(this.#storage, document);
      if (result.kind !== "cut") throw new Error(`Owner adoption ${result.reason}.`);
      const authority = result.cut.authorityHistory.find(row => row.current)!;
      const authorized = input.actor ? currentLiveDocumentBinding(this.#storage,{document,actor: input.actor}) : undefined;
      if (authorized && (authorized.kind !== "current" || !isDeepStrictEqual(authorized.host,host))) throw new Error("Owner standing changed.");
      const binding = authorized?.kind === "current" ? authorized.binding : authority.binding;
      const source = this.#storage.db.prepare(`SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?`)
        .get(document.workspaceId, document.objectId, authority.baselineSequence);
      integrity(source && source.version_id === document.mainVersionId && source.path === authority.binding.currentPath && source.content_kind === "text" &&
        source.blob_sha256 === authority.projectedDigest && source.byte_length === authority.projectedLength);
      const events: AdmittedLiveUpdate[] = [];
      let bytes = authority.baselineBytes.byteLength;
      for (const raw of this.#storage.db.prepare(`SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor<=? ORDER BY journal_cursor`).iterate(...documentParams(document),requestedCursor ?? Number.MAX_SAFE_INTEGER)) {
        const row = decodeJournalRow(this.#storage.db, raw);
        assertJournalCheckpointPosition(this.#storage.db, row);
        verifyJournalRow(row);
        bytes += row.admitted.updateBytes.byteLength + Buffer.byteLength(JSON.stringify(row.admitted.metadata)) + 8;
        if (bytes > maxBytes || events.length === maxEvents) throw new Error("Owner adoption cut exceeds its configured bounds.");
        events.push(row.admitted);
      }
      const terminal = events.at(-1)?.metadata.accepted.receipt ?? null;
      integrity((terminal?.journalCursor ?? 0) === (requestedCursor ?? result.cut.highWater ?? 0) && events.length === count.count);
      const cut: LiveOwnerAdoptionCut = { relayDatabaseNamespace: this.#history.namespace, adoptionId,
        sourceMomentId: parseLiveUpdateIdentifier(source.moment_id, "source moment ID"), sourceDigest: authority.projectedDigest,
        sourceByteLength: authority.projectedLength, baselineMomentRelaySequence: authority.baselineSequence,
        baselineRegisteredAtMs: authority.registeredAtMs, expectedLocalSequence: sequence,
        terminalReceipt: terminal, baselineBytes: new Uint8Array(authority.baselineBytes), events };
      const { events: _events, baselineBytes: _baseline, ...header } = cut;
      if (bytes + Buffer.byteLength(JSON.stringify({ ...header, eventCount: events.length })) + 8 > maxBytes) throw new Error("Owner adoption cut exceeds its configured bounds.");
      return { journal: result.cut, authority: structuredClone(authority), binding: structuredClone(binding), source: { ...source }, cut };
    });
    verifyJournalCut(captured.journal);
    const assertCurrent = (): void => {
      this.#standing(host);
      const raw = this.#storage.db.prepare(`SELECT * FROM sync_relay_live_documents WHERE ${WHERE_DOCUMENT}`).get(...documentParams(document));
      integrity(raw && isDeepStrictEqual(decodeLiveDocumentAuthorityStructure(this.#storage.db, document, raw), captured.authority));
      const source = this.#storage.db.prepare(`SELECT moment_id,version_id,path,content_kind,blob_sha256,byte_length FROM sync_relay_object_moments WHERE workspace_id=? AND object_id=? AND relay_seq=?`)
        .get(document.workspaceId, document.objectId, captured.authority.baselineSequence);
      integrity(source && isDeepStrictEqual({ ...source }, captured.source));
      if (input.actor) {
        const authorized = currentLiveDocumentBinding(this.#storage,{document,actor: input.actor});
        integrity(authorized.kind === "current" && isDeepStrictEqual(authorized.binding,captured.binding) && isDeepStrictEqual(authorized.host,host));
      }
    };
    assertCurrent();
    const capture = { binding: structuredClone(captured.binding), cut: captured.cut, assertCurrent };
    this.#ownerCuts.set(capture,{ host,document,digest: ownerCutDigest(capture) });
    return capture;
  }
  #ownerCapture(capture: OwnerCutCapture) {
    const saved = this.#ownerCuts.get(capture);
    integrity(saved && saved.digest === ownerCutDigest(capture));
    capture.assertCurrent();
    return saved;
  }
  #ownerRow(host: LiveHostConnectionCoordinate,document: LiveDocumentKey) {
    return this.#storage.db.prepare(`SELECT * FROM ${OWNERS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`)
      .get(this.#history.namespace,...documentParams(document),host.hostId);
  }
  ownerProgress(capture: OwnerCutCapture): { terminal: LiveUpdateReceipt | null; sequence: number } {
    const { host,document } = this.#ownerCapture(capture), row = this.#ownerRow(host,document);
    integrity(row);
    const terminal = JSON.parse(String(row.tip_receipt_json));
    const parsed = terminal === null ? null : parseLiveUpdateReceipt(terminal);
    integrity((parsed?.journalCursor ?? 0) === row.tip_cursor);
    return { terminal: parsed,sequence: authorityInteger(row.tip_sequence) };
  }
  acknowledgeOwnerAdoption(capture: OwnerCutCapture, value: unknown): void {
    const { host,document } = this.#ownerCapture(capture), cut = capture.cut;
    const ack = baselineRecord(value,["adoptionId","localYDocSequence","terminalCursor","adoptionReplayed"]);
    integrity(ack.adoptionId === cut.adoptionId && ack.localYDocSequence === cut.expectedLocalSequence && ack.terminalCursor === (cut.terminalReceipt?.journalCursor ?? 0) && typeof ack.adoptionReplayed === "boolean");
    const { baselineBytes: _baseline,events: _events,...header } = cut;
    const origin = JSON.stringify({ ...header,bindingDigest: createHash("sha256").update(JSON.stringify(capture.binding)).digest("hex") });
    this.#storage.tx(() => {
      this.#ownerCapture(capture);
      bindLiveDeliveryHostNamespace(this.#storage,document.workspaceId,host.hostId,this.#history.namespace);
      integrity(!this.#storage.db.prepare(`SELECT 1 FROM ${BOOTSTRAPS} WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`).get(this.#history.namespace,...documentParams(document),host.hostId));
      const previous = this.#ownerRow(host,document);
      if (previous) { integrity(previous.origin_json === origin && Number(previous.tip_cursor) >= Number(ack.terminalCursor)); return; }
      const tip = JSON.stringify(cut.terminalReceipt), cursor = cut.terminalReceipt?.journalCursor ?? 0;
      const values = [this.#history.namespace,...documentParams(document),host.hostId,origin,tip,cursor,cut.expectedLocalSequence];
      const charge = Buffer.byteLength(JSON.stringify(values));
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,0,charge,true);
      for (const event of cut.events) {
        consumeLiveDeliveryReservation(this.#storage,document,host.hostId,event.metadata.accepted.receipt.journalCursor,1,true);
        this.#refundOwner(document.workspaceId,1);
      }
      this.#storage.db.prepare(`INSERT INTO ${OWNERS}(relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id,origin_json,tip_receipt_json,tip_cursor,tip_sequence,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...values,charge);
    });
  }
  acknowledgeOwnerApplication(capture: OwnerCutCapture, value: unknown): void {
    const ack = parseLiveUpdateHostApplicationAck(value), { host,document } = this.#ownerCapture(capture);
    const acknowledged = { deliveryId: ack.deliveryId,updateDigest: ack.updateDigest,journalCursor: ack.journalCursor,acceptingHostEpoch: ack.acceptingHostEpoch };
    this.#storage.tx(() => {
      this.#ownerCapture(capture);
      const row = this.#ownerRow(host,document); integrity(row);
      const cursor = authorityInteger(row.tip_cursor), previousSequence = authorityInteger(row.tip_sequence);
      const next = capture.cut.events.find(event => event.metadata.accepted.receipt.journalCursor > cursor);
      if (ack.journalCursor === cursor) { integrity(sameReceipt(JSON.parse(String(row.tip_receipt_json)),acknowledged) && ack.localYDocSequence === previousSequence); return; }
      integrity(next && sameReceipt(next.metadata.accepted.receipt,acknowledged) && ack.localYDocSequence >= previousSequence);
      const tip = JSON.stringify(next.metadata.accepted.receipt), values = [this.#history.namespace,...documentParams(document),host.hostId,row.origin_json,tip,ack.journalCursor,ack.localYDocSequence];
      const charge = Buffer.byteLength(JSON.stringify(values)), previousCharge = authorityInteger(row.accounted_bytes,1), delta = Math.max(1,charge-previousCharge);
      consumeLiveDeliveryReservation(this.#storage,document,host.hostId,ack.journalCursor,delta,true);
      const refund = previousCharge + delta - charge;
      if (refund) this.#refundOwner(document.workspaceId,refund);
      this.#storage.db.prepare(`UPDATE ${OWNERS} SET tip_receipt_json=?,tip_cursor=?,tip_sequence=?,accounted_bytes=? WHERE relay_database_namespace=? AND ${WHERE_DOCUMENT} AND host_id=?`)
        .run(tip,ack.journalCursor,ack.localYDocSequence,charge,this.#history.namespace,...documentParams(document),host.hostId);
    });
  }
  #refundOwner(workspaceId: string, amount: number) {
    integrity(this.#storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=? AND usage_bytes>=?").run(amount,workspaceId,amount).changes === 1);
  }
  #standing(host: LiveHostConnectionCoordinate): void {
    requireLiveJournalHistory(this.#storage, this.#history);
    const standing = journalHost(this.#storage.db, host);
    if ("kind" in standing)
      throw new Error(`Committed delivery ${standing.reason}.`);
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
    const authority = decodeLiveDocumentAuthorityStructure(
      this.#storage.db,
      capture.document,
      { ...raw, baseline_bytes: capture.authority.baselineBytes },
    );
    integrity(isDeepStrictEqual(authority, capture.authority));
    if (capture.terminal) {
      const terminal = this.#storage.db
        .prepare(
          `SELECT delivery_id,update_digest,journal_cursor,accepting_host_epoch FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
        )
        .get(
          ...documentParams(capture.document),
          capture.terminal.journalCursor,
        );
      integrity(terminal && sameReceipt(receipt(terminal), capture.terminal));
    }
    return capture;
  }
  #bootstrapRow(capture: DrainCapture): Record<string, unknown> {
    const row = this.#storage.db
      .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
      .get(
        this.#history.namespace,
        ...documentParams(capture.document),
        capture.host.hostId,
      );
    integrity(row);
    const b = capture.baseline;
    integrity(
      row.bootstrap_id === b.bootstrapId &&
        row.bootstrap_moment_id === b.bootstrapMomentId &&
        row.baseline_digest === b.baselineDigest &&
        row.baseline_byte_length === b.baselineBytes.byteLength &&
        row.baseline_moment_relay_seq === b.baselineMomentRelaySequence &&
        row.baseline_registered_at_ms === b.baselineRegisteredAtMs &&
        row.projected_markdown_digest === b.projectedMarkdownDigest &&
        row.projected_markdown_byte_length === b.projectedMarkdownByteLength &&
        isDeepStrictEqual(
          parseLiveObjectBinding(JSON.parse(String(row.binding_json))),
          b.binding,
        ),
    );
    authorityInteger(row.accounted_bytes, 1);
    if (row.local_ydoc_sequence === null) {
      integrity(
        [
          row.ack_host_mode,
          row.ack_host_epoch,
          row.ack_instance_id,
          row.ack_connection_id,
        ].every((x) => x === null),
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
  open(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey }): CommittedDeliveryDrain {
    return this.#open(input, true);
  }
  openSettlement(input: { host: LiveHostConnectionCoordinate; document: LiveDocumentKey }): CommittedDeliveryDrain {
    return this.#open(input, false);
  }
  #open(input: {
    host: LiveHostConnectionCoordinate;
    document: LiveDocumentKey;
  }, createBootstrap: boolean): CommittedDeliveryDrain {
    const host = snapshotHostCoordinate(input.host),
      document = journalDocument(input.document);
    const read = this.#storage.readTx(() => {
      this.#standing(host);
      const cut = liveJournalCut(this.#storage, document);
      if (cut.kind !== "cut")
        throw new Error(`Committed delivery ${cut.reason}.`);
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
      const terminal = terminalRaw
        ? decodeJournalRow(this.#storage.db, terminalRaw)
        : null;
      return { cut: cut.cut, authority, terminal };
    });
    verifyJournalCut(read.cut);
    if (read.terminal) verifyJournalRow(read.terminal);
    const baseline: CommittedBootstrap = {
      bootstrapId: randomUUID(),
      bootstrapMomentId: randomUUID(),
      binding: structuredClone(read.authority.binding),
      baselineMomentRelaySequence: read.authority.baselineSequence,
      baselineRegisteredAtMs: read.authority.registeredAtMs,
      baselineDigest: read.authority.baselineDigest,
      projectedMarkdownDigest: read.authority.projectedDigest,
      projectedMarkdownByteLength: read.authority.projectedLength,
      baselineBytes: new Uint8Array(read.authority.baselineBytes),
    };
    const capture: DrainCapture = {
      host,
      document,
      authority: structuredClone(read.authority),
      baseline,
      terminal: read.terminal?.admitted.metadata.accepted.receipt ?? null,
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
        bindLiveDeliveryHostNamespace(this.#storage, document.workspaceId, host.hostId, this.#history.namespace);
        const row = this.#storage.db
          .prepare(`SELECT * FROM ${BOOTSTRAPS} WHERE ${WHERE_BOOTSTRAP}`)
          .get(
            this.#history.namespace,
            ...documentParams(document),
            host.hostId,
          );
        if (row) {
          capture.baseline = {
            ...baseline,
            bootstrapId: parseLiveUpdateIdentifier(
              row.bootstrap_id,
              "bootstrap ID",
            ),
            bootstrapMomentId: parseLiveUpdateIdentifier(
              row.bootstrap_moment_id,
              "bootstrap moment ID",
            ),
          };
          this.#bootstrapRow(capture);
          return;
        }
        if (!createBootstrap) throw new Error("Committed delivery must finish before settlement.");
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
      .get(
        ...documentParams(capture.document),
        after,
        capture.terminal?.journalCursor ?? 0,
      );
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
        .get(
          capture.baseline.bootstrapId,
          capture.terminal?.journalCursor ?? 0,
        ) ?? null;
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
      const expected = this.#nextReceipt(
        capture,
        predecessor?.journalCursor ?? 0,
      );
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
    row: Parameters<typeof assertJournalCheckpointPosition>[1],
  ): NonNullable<DrainCapture["checkpoint"]> {
    const current = row.admitted.metadata.accepted.receipt,
      prior = capture.checkpoint;
    const rowBytes = row.admitted.updateBytes.byteLength,
      hasCheckpoint = row.checkpoint !== null;
    if (prior && sameReceipt(prior.receipt, current)) {
      integrity(
        prior.rowBytes === rowBytes && prior.hasCheckpoint === hasCheckpoint,
      );
      return prior;
    }
    let position;
    if (
      prior &&
      sameReceipt(
        this.#nextReceipt(capture, prior.receipt.journalCursor),
        current,
      )
    ) {
      const count = (prior.hasCheckpoint ? 0 : prior.count) + 1;
      const bytes = (prior.hasCheckpoint ? 0 : prior.bytes) + rowBytes;
      integrity(
        count <= 4095 &&
          hasCheckpoint === (count === 4095 || bytes >= 20_971_520),
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
      const next = this.#nextReceipt(
        capture,
        progress.predecessor?.journalCursor ?? 0,
      );
      if (!next) {
        integrity(sameReceipt(progress.predecessor, capture.terminal));
        return {
          kind: "done" as const,
          terminalReceipt: capture.terminal ? { ...capture.terminal } : null,
        };
      }
      const raw = this.#storage.db
        .prepare(
          `SELECT * FROM ${LIVE_JOURNAL_TABLE} WHERE ${WHERE_DOCUMENT} AND journal_cursor=?`,
        )
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
    return { binding: structuredClone(capture.authority.binding), terminalReceipt: next.terminalReceipt };
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
      integrity(
        this.#bootstrapRow(capture).local_ydoc_sequence ===
          ack.localYDocSequence,
      );
    });
  }
  acknowledge(
    drain: CommittedDeliveryDrain,
    predecessor: LiveUpdateReceipt | null,
    input: unknown,
  ): void {
    const ack = parseLiveUpdateHostApplicationAck(input),
      previous =
        predecessor === null ? null : parseLiveUpdateReceipt(predecessor);
    this.#storage.tx(() => {
      const capture = this.#capture(drain),
        progress = this.#progress(capture);
      integrity(progress.bootstrap.local_ydoc_sequence !== null);
      integrity(
        capture.terminal && ack.journalCursor <= capture.terminal.journalCursor,
      );
      const repeated = this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
        )
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
            .prepare(
              `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
            )
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
      consumeLiveDeliveryReservation(this.#storage, capture.document, h.hostId, ack.journalCursor, charge, true);
      this.#storage.db
        .prepare(
          `INSERT INTO ${EDGES}(bootstrap_id,workspace_id,journal_cursor,predecessor_cursor,delivery_id,update_digest,accepting_host_epoch,local_ydoc_sequence,ack_host_mode,ack_host_epoch,ack_instance_id,ack_connection_id,accounted_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...values, charge);
      const inserted = this.#storage.db
        .prepare(
          `SELECT * FROM ${EDGES} WHERE bootstrap_id=? AND journal_cursor=?`,
        )
        .get(capture.baseline.bootstrapId, ack.journalCursor);
      integrity(
        inserted &&
          sameReceipt(receipt(inserted), expected) &&
          inserted.predecessor_cursor === (previous?.journalCursor ?? 0) &&
          inserted.local_ydoc_sequence === ack.localYDocSequence,
      );
      capture.progress = { predecessor: expected, tip: inserted };
    });
  }
  close(drain: CommittedDeliveryDrain): void {
    this.#drains.delete(drain);
  }
}
