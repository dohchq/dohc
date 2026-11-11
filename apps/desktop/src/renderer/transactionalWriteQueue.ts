import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { TableCellStatus, TableCellStatuses } from "@dohc/collection-views/table";
import type { CollectionRecord, CollectionValue } from "@dohc/workspace-contracts";
import { cannotTake, emptyValue, fieldShape, isEmptyValue, object, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";
import type { TransactionalInvoke } from "./TransactionalCollectionPage";

/** A value the person gave, with the field's definition they gave it under, so a later change to the field can tell whether it still fits. */
export type Typed = { value: AppBackendJson; under: TransactionalField };

/** One change the person made to a Data Collection, from when they made it until its host confirms or refuses it. */
export interface QueuedWrite {
  /** Rises with each change. The table knows a cell's saved edits by it. */
  readonly id: number;
  readonly kind: "edit" | "create" | "delete";
  /** The record changed. A new record has none yet. */
  readonly record: { readonly id: string | number; readonly key: string } | null;
  readonly operationId: string;
  /** What each field gets, by field id. A delete has none. */
  readonly values: Readonly<Record<string, Typed>>;
  /** The record's version when the person made the change. */
  baseVersion: number;
  readonly key: string;
  /** What a notice says once the change saved after its page closed. */
  readonly label: string;
  readonly undo: boolean;
  state: "queued" | "sending" | "unconfirmed";
  /** The request as first sent. Try again sends it unchanged. */
  request?: TransactionalInvoke;
}

/** What the queue needs from the page that shows it, read again at each step. */
export interface WriteQueueHost {
  workspaceId: string;
  datasetId: string;
  revision: number;
  revisionSha256: string;
  tableName: string;
  fields: readonly TransactionalField[];
  /** The operations that may run now. An offline copy has none that change records. */
  operations: readonly DatasetOperation[];
  offline: boolean;
  invoke(request: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
  onError(fallback: string, error: unknown, retry: (() => void) | null, identity?: string): void;
  onSettled?(identity: string): void;
  onNotice?(message: string): void;
  confirmed(write: QueuedWrite, receipt: AppBackendJson): void;
  /** A change that will not be sent again. True when an open form shows why, so no cell does. */
  dropped(write: QueuedWrite, reason: string): boolean;
  unconfirmed(write: QueuedWrite): void;
  /** The records the page shows are older than a change, so it reads them again. */
  read(): void;
}

/** A change that needs the person, for the page to list when no cell shows it. */
export type WriteAttention =
  | { kind: "unconfirmed"; write: QueuedWrite }
  | { kind: "held"; recordKey: string; recordId: string | number; fieldId: string; fieldName: string; value: AppBackendJson; reason: string };

export const NOT_CONFIRMED = "dohc could not confirm this change.";
const REFUSED = "The Collection refused this change.";
const WAITING_BEHIND = "Waiting for an earlier change to this record";
const WAITING_OFFLINE = "Waiting for the Collection to come back online";
export const RULES_DISALLOW = "The Collection's rules no longer allow this change, so dohc did not save it.";
const FIELD_CHANGED = "This field changed, so dohc did not save this value. Enter a value the field takes.";
const FIELD_REMOVED = "This field was removed, so dohc did not save this value.";
const RULES_CHANGED = "The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.";

type Held = { id: number; recordId: string | number; fieldName: string; value: AppBackendJson; reason: string };
type Settled = { id: number; value: AppBackendJson; seq: number };
type Shown = { signature: string; status: TableCellStatus };
type Flight = { write: QueuedWrite; abort: AbortController };
type CellMap<Value> = Map<string, Map<string, Value>>;

function put<Value>(cells: CellMap<Value>, record: string, field: string, value: Value): void {
  let fields = cells.get(record);
  if (!fields) cells.set(record, (fields = new Map()));
  fields.set(field, value);
}
function take<Value>(cells: CellMap<Value>, record: string, field: string): void {
  const fields = cells.get(record);
  if (fields?.delete(field) && fields.size === 0) cells.delete(record);
}

/** The record's version a receipt reports, or null when it reports none this record can use. */
function receiptVersion(write: QueuedWrite, raw: AppBackendJson): number | null {
  if (!write.record || write.kind !== "edit") return null;
  try {
    const result = object(parseAppBackendJson(raw));
    return typeof result.version === "number" && Number.isSafeInteger(result.version) && result.version >= 1 && JSON.stringify(result.id) === write.record.key ? result.version : null;
  } catch { return null; }
}

/**
 * The changes one table's page has made and its host has not confirmed.
 *
 * One request is in flight at a time, in the order the changes were made, so
 * a record's changes reach the host in order. A change dohc could not confirm
 * keeps its request and holds only its own record's later changes. Each
 * change after a confirmed one uses the version that receipt reports.
 *
 * The queue outlives its page: a request in flight ends without the page,
 * and what is unsent or unconfirmed waits for the page to open again.
 */
export class WriteQueue {
  private readonly writes: QueuedWrite[] = [];
  private flight: Flight | null = null;
  private host: WriteQueueHost | null = null;
  private attached = false;
  private nextId = 1;
  /** Rises with each outcome. A read that starts at or after an outcome's number shows it. */
  private seq = 0;
  /** The last outcome the page has not read past, or null. */
  private unread: number | null = null;
  private readAsked = false;
  /** The version each record's last receipt reported, for its next change. */
  private readonly versions = new Map<string, { version: number; seq: number }>();
  /** Records changed with no version reported, whose next change waits for a read. */
  private readonly unknown = new Map<string, number>();
  /** Confirmed values the page's records do not show yet. */
  private readonly settled: CellMap<Settled> = new Map();
  /** Values dohc did not save, kept for the person until they dismiss them. */
  private readonly held: CellMap<Held> = new Map();
  private shown: CellMap<Shown> = new Map();
  private readonly listeners = new Set<() => void>();
  private readonly discardListeners = new Set<(id: number) => void>();
  private changes = 0;

  constructor(private readonly scope: string) {}

  /** The table's view of each cell's change. One object for the queue's life. */
  readonly statuses: TableCellStatuses = {
    subscribe: listener => this.subscribe(listener),
    get: (recordId, field) => this.shown.get(recordId)?.get(field)?.status,
  };
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Rises whenever anything the queue shows changes. */
  readonly version = (): number => this.changes;
  readonly subscribeToDiscarded = (listener: (id: number) => void): (() => void) => {
    this.discardListeners.add(listener);
    return () => { this.discardListeners.delete(listener); };
  };
  /** The highest change to this cell that its record's value already shows. */
  readonly acknowledged = (record: CollectionRecord, field: string): number => {
    let lowest = this.nextId;
    for (const write of this.writes) if (write.record?.key === record.id && Object.hasOwn(write.values, field)) lowest = Math.min(lowest, write.id);
    const settled = this.settled.get(record.id)?.get(field);
    if (settled) lowest = Math.min(lowest, settled.id);
    return lowest - 1;
  };

  get size(): number { return this.writes.length; }
  /** The id the next change gets. */
  get nextWrite(): number { return this.nextId; }
  find(id: number): QueuedWrite | undefined { return this.writes.find(write => write.id === id); }

  /** The page opened. It gives its host first, with `sync`. */
  attach(): void {
    this.attached = true;
    // The queue is this page's alone while it is open: another page of the same table starts its own.
    if (queues.get(this.scope) === this) queues.delete(this.scope);
    // The rules may have changed while the page was closed.
    this.rulesChanged();
    this.changed();
    this.pump();
  }
  /** The page closed. A request in flight still ends, and reports through the page's last host. */
  detach(): void {
    this.attached = false;
    // A page that opens again reads its records afresh.
    this.settled.clear();
    // What is in flight, unsent, unconfirmed or unsaved waits here for the page to open again.
    if (this.keeps() && !queues.has(this.scope)) queues.set(this.scope, this);
  }
  sync(host: WriteQueueHost): void {
    const was = this.host;
    this.host = host;
    if (this.attached && was && was.offline !== host.offline) { this.changed(); this.pump(); }
  }

  /** Adds a change after every change made before it. */
  enqueue(change: { kind: QueuedWrite["kind"]; record: Pick<TransactionalRow, "id" | "version"> | null; operationId: string; values?: Record<string, Typed>; label: string; undo?: boolean }): number {
    const record = change.record ? { id: change.record.id, key: JSON.stringify(change.record.id) } : null;
    const write: QueuedWrite = { id: this.nextId++, kind: change.kind, record, operationId: change.operationId, values: change.values ?? {}, baseVersion: change.record?.version ?? 0,
      key: crypto.randomUUID(), label: change.label, undo: change.undo ?? false, state: "queued" };
    // A new change to a cell replaces the value dohc did not save there.
    if (record) for (const fieldId of Object.keys(write.values)) take(this.held, record.key, fieldId);
    this.writes.push(write);
    this.changed();
    this.pump();
    return write.id;
  }
  /** A change that saves nothing, such as a value the cell already has. */
  skip(): number { return this.nextId++; }
  /** Keeps a value dohc will not send, with why, on its cell. */
  hold(row: Pick<TransactionalRow, "id">, field: TransactionalField, value: AppBackendJson, reason: string): number {
    const id = this.nextId++;
    put(this.held, JSON.stringify(row.id), field.fieldId, { id, recordId: row.id, fieldName: field.name, value, reason });
    this.discard(id);
    this.changed();
    return id;
  }
  dismiss(recordKey: string, fieldId: string): void {
    take(this.held, recordKey, fieldId);
    this.changed();
    this.release();
  }
  /** Sends a change dohc could not confirm again, with the same request, while it still waits. An offline copy sends nothing, so the change keeps its Try again. */
  retry(id: number): void {
    const write = this.find(id);
    if (!write || write.state !== "unconfirmed" || this.host?.offline) return;
    write.state = "queued";
    this.changed();
    this.pump();
  }
  /** The changes that need the person: those dohc could not confirm, and the values it did not save. */
  attention(): WriteAttention[] {
    const waiting: WriteAttention[] = this.writes.filter(write => write.state === "unconfirmed").map(write => ({ kind: "unconfirmed", write }));
    for (const [recordKey, fields] of this.held) for (const [fieldId, held] of fields) waiting.push({ kind: "held", recordKey, fieldId, recordId: held.recordId, fieldName: held.fieldName, value: held.value, reason: held.reason });
    return waiting;
  }

  /** Call when a read of records starts, and pass what it returns to `readShown`. A saved offline page shows no change. */
  readStarted(): number { return this.host?.offline ? -1 : this.seq; }
  /** The page shows the records a read returned. */
  readShown(token: number, rows: readonly TransactionalRow[]): void {
    this.readAsked = false;
    for (const [recordKey, fields] of this.settled) {
      for (const [fieldId, settled] of fields) if (settled.seq <= token) fields.delete(fieldId);
      if (fields.size === 0) this.settled.delete(recordKey);
    }
    for (const [recordKey, seq] of this.unknown) {
      if (seq > token) continue;
      this.unknown.delete(recordKey);
      const row = rows.find(candidate => JSON.stringify(candidate.id) === recordKey);
      // The read shows the record after the change that reported no version.
      if (row) for (const write of this.writes) if (write.record?.key === recordKey && !write.request) write.baseVersion = row.version;
    }
    // A record with a change still queued keeps its receipt's version, which that change was made after.
    for (const [recordKey, known] of this.versions) if (known.seq <= token && !this.writes.some(write => write.record?.key === recordKey)) this.versions.delete(recordKey);
    if (this.unread !== null && this.unread <= token) this.unread = null;
    this.changed();
    this.pump();
  }

  /**
   * The Collection's rules changed. A request sent under the old rules can't
   * be confirmed or sent again, so its change goes, and its value stays on
   * its cell. A change not sent yet is checked against the new rules when it
   * goes.
   */
  rulesChanged(): void {
    const host = this.host;
    if (!host) return;
    const stale = this.writes.filter(write => write.request && (write.request.revision !== host.revision || write.request.revisionSha256 !== host.revisionSha256));
    if (stale.length === 0) return;
    if (this.flight && stale.includes(this.flight.write)) { this.flight.abort.abort(); this.flight = null; }
    this.outcome();
    for (const write of stale) {
      // The change may have landed, so its record's version is unknown until a read.
      if (write.record) { this.versions.delete(write.record.key); this.unknown.set(write.record.key, this.seq); }
      this.drop(write, RULES_CHANGED);
    }
    host.onError("The Collection's rules changed. Check the records before making another change.", new Error("The Collection's rules changed before this change was confirmed. Check the records before making another change."), null);
    this.changed();
    this.pump();
  }

  private pump(): void {
    const host = this.host;
    if (!this.attached || !host || this.flight || host.offline) return;
    let waitsForRead = false;
    const blocked = new Set<string>();
    for (const write of [...this.writes]) {
      const key = write.record?.key;
      if (key !== undefined && blocked.has(key)) continue;
      if (write.state === "unconfirmed") { if (key !== undefined) blocked.add(key); continue; }
      if (key !== undefined && this.unknown.has(key)) { blocked.add(key); waitsForRead = true; continue; }
      if (this.send(write, host)) return;
    }
    // Nothing more to send: the page reads once for every outcome since its last read.
    if ((waitsForRead || this.unread !== null) && !this.readAsked) { this.readAsked = true; host.read(); }
  }

  /** Why the rules now refuse a change made under earlier ones, or null. */
  private problem(write: QueuedWrite, host: WriteQueueHost): string | null {
    const operation = host.operations.find(candidate => candidate.operationId === write.operationId && !candidate.readOnly);
    if (!operation) return RULES_DISALLOW;
    for (const [fieldId, typed] of Object.entries(write.values)) {
      const now = host.fields.find(field => field.fieldId === fieldId);
      if (!now) return FIELD_REMOVED;
      if (cannotTake(typed.under, now, typed.value)) return FIELD_CHANGED;
      if (!operation.fieldIds.includes(fieldId)) return RULES_DISALLOW;
    }
    return null;
  }

  /** Sends the change. False when the rules no longer allow it, so it went. */
  private send(write: QueuedWrite, host: WriteQueueHost): boolean {
    if (!write.request) {
      const problem = this.problem(write, host);
      if (problem !== null) { this.drop(write, problem); this.changed(); return false; }
      // A value emptied under a field's old definition is empty in the new one's own way.
      const values = Object.fromEntries(Object.entries(write.values).map(([fieldId, typed]) => {
        const now = host.fields.find(field => field.fieldId === fieldId)!;
        return [fieldId, isEmptyValue(typed.value) && fieldShape(now) !== fieldShape(typed.under) ? emptyValue(now) : typed.value];
      }));
      const expectedVersion = write.record ? this.versions.get(write.record.key)?.version ?? write.baseVersion : 0;
      const input: AppBackendJson = write.kind === "create" ? { values } : write.kind === "delete" ? { id: write.record!.id, expectedVersion } : { id: write.record!.id, expectedVersion, values };
      write.request = { workspaceId: host.workspaceId, datasetId: host.datasetId, revision: host.revision, revisionSha256: host.revisionSha256, operationId: write.operationId, input, idempotencyKey: write.key };
    }
    write.state = "sending";
    const flight: Flight = { write, abort: new AbortController() };
    this.flight = flight;
    this.changed();
    let answer: Promise<{ result: AppBackendJson }>;
    try { answer = host.invoke(write.request, flight.abort.signal); } catch (cause) { answer = Promise.reject(cause); }
    answer.then(response => this.confirm(flight, response.result), cause => this.fail(flight, cause));
    return true;
  }

  private identity(write: QueuedWrite): string { return `collection-change:${this.scope}:${write.key}`; }

  /**
   * A change was confirmed, refused, or dropped, so the page's records are
   * older than it. The page may be asked to read again, even after a read it
   * was asked for failed.
   */
  private outcome(): void {
    this.seq++;
    this.unread = this.seq;
    this.readAsked = false;
  }

  private confirm(flight: Flight, receipt: AppBackendJson): void {
    // A request the rules made stale changes nothing.
    if (this.flight !== flight) return;
    this.flight = null;
    const { write } = flight, host = this.host!;
    const at = this.writes.indexOf(write);
    if (at >= 0) this.writes.splice(at, 1);
    this.outcome();
    if (write.record) {
      const version = receiptVersion(write, receipt);
      if (version !== null) this.versions.set(write.record.key, { version, seq: this.seq });
      else {
        this.versions.delete(write.record.key);
        if (write.kind === "edit") this.unknown.set(write.record.key, this.seq);
      }
      for (const [fieldId, typed] of Object.entries(write.values)) put(this.settled, write.record.key, fieldId, { id: write.id, value: typed.value, seq: this.seq });
    }
    // The page shows its own change. Once it has closed, a notice says the change saved, and in which Collection.
    if (this.attached) { host.confirmed(write, receipt); host.onSettled?.(this.identity(write)); }
    else host.onNotice?.(`${write.label} in ${host.tableName}`);
    this.changed();
    this.pump();
    this.release();
  }

  private fail(flight: Flight, cause: unknown): void {
    if (this.flight !== flight) return;
    this.flight = null;
    const { write } = flight, host = this.host!;
    const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
    if (refused) {
      const why = cause instanceof Error && cause.message ? `${REFUSED} ${cause.message}` : REFUSED;
      this.outcome();
      this.drop(write, why);
    } else write.state = "unconfirmed";
    // Once the page has closed, a failure still reaches a toast and Notices, and names the Collection.
    if (!this.attached) host.onError(refused ? `${host.tableName} refused the change. Open it to check its records.` : `dohc could not confirm the change to ${host.tableName}. Open it to check its records.`, cause, null);
    else if (refused) host.onError(REFUSED, cause, null);
    else {
      host.unconfirmed(write);
      // Try again sends the change only while it still waits, so a row left in Notices can't send it twice.
      host.onError(NOT_CONFIRMED, cause, () => this.retry(write.id), this.identity(write));
    }
    this.changed();
    this.pump();
    this.release();
  }

  /** Takes a change out for good. Its values stay on their cells unless an open form shows why. */
  private drop(write: QueuedWrite, reason: string): void {
    const at = this.writes.indexOf(write);
    if (at >= 0) this.writes.splice(at, 1);
    this.discard(write.id);
    if (this.attached && this.host?.dropped(write, reason)) return;
    if (!write.record) return;
    for (const [fieldId, typed] of Object.entries(write.values)) {
      const fieldName = this.host?.fields.find(field => field.fieldId === fieldId)?.name ?? typed.under.name;
      put(this.held, write.record.key, fieldId, { id: write.id, recordId: write.record.id, fieldName, value: typed.value, reason });
    }
  }

  private discard(id: number): void { for (const listener of this.discardListeners) listener(id); }

  /** Works out each cell's status again, keeps the object of each one that did not change, and tells the listeners. */
  private changed(): void {
    const next: CellMap<Shown> = new Map();
    const show = (record: string, field: string, signature: unknown[], status: () => TableCellStatus) => {
      const text = JSON.stringify(signature), before = this.shown.get(record)?.get(field);
      put(next, record, field, before?.signature === text ? before : { signature: text, status: status() });
    };
    for (const [record, fields] of this.settled) for (const [field, settled] of fields) show(record, field, ["pending", settled.id, settled.value], () => ({ state: "pending", value: settled.value as CollectionValue }));
    for (const [record, fields] of this.held) for (const [field, held] of fields) {
      show(record, field, ["refused", held.id, held.value, held.reason], () => ({ state: "refused", value: held.value as CollectionValue, reason: held.reason, dismiss: () => this.dismiss(record, field) }));
    }
    // Later changes to a cell show over earlier ones. A record's first change dohc could not confirm holds the rest.
    const blocked = new Set<string>();
    for (const write of this.writes) {
      if (!write.record) continue;
      const record = write.record.key;
      const state = write.state === "unconfirmed" && !blocked.has(record) ? "unconfirmed" : blocked.has(record) ? "behind" : this.host?.offline && write.state === "queued" ? "offline" : "pending";
      if (state === "unconfirmed") blocked.add(record);
      for (const [field, typed] of Object.entries(write.values)) {
        const value = typed.value as CollectionValue;
        show(record, field, [state, write.id, typed.value], () => state === "unconfirmed" ? { state, value, reason: NOT_CONFIRMED, retry: () => this.retry(write.id) }
          : state === "pending" ? { state, value } : { state: "waiting", value, reason: state === "behind" ? WAITING_BEHIND : WAITING_OFFLINE });
      }
    }
    this.shown = next;
    this.changes++;
    for (const listener of [...this.listeners]) listener();
  }

  private keeps(): boolean { return this.flight !== null || this.writes.length > 0 || this.held.size > 0; }
  /** A closed page's queue with nothing left to keep goes. */
  private release(): void {
    if (!this.attached && !this.keeps() && queues.get(this.scope) === this) queues.delete(this.scope);
  }
}

// The queues of closed pages that still hold changes, by workspace, Collection and table. A page that
// opens finds its table's queue here, and takes it out while it is open.
const queues = new Map<string, WriteQueue>();
/** The queue a table's page left when it closed, or a new one. Reading it changes nothing, so a render may ask twice. */
export function writeQueueFor(scope: string): WriteQueue {
  return queues.get(scope) ?? new WriteQueue(scope);
}
/** Tests start without changes an earlier test's page kept. */
export function resetWriteQueuesForTests(): void {
  queues.clear();
}
