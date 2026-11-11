import { parseAppBackendJson, type AppBackendJson } from "@dohc/security-contract/app-backend";
import type { DatasetOperation } from "@dohc/security-contract/dataset";
import type { TableCellStatus, TableCellStatuses } from "@dohc/collection-views/table";
import type { CollectionRecord, CollectionValue } from "@dohc/workspace-contracts";
import { isCollectionRulesReplaced } from "../ipc/errorWords";
import { closeCollectionChangeShellsForTests, collectionChangeShell, onCollectionChangesResumed, type CollectionChangeReports } from "./collectionChangeShells";
import { cannotTake, emptyValue, fieldShape, isEmptyValue, object, parsePage, type TransactionalField, type TransactionalRow } from "./transactionalCollectionModel";
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
  readonly baseVersion: number;
  readonly key: string;
  /** What a notice says once the change saved with no page open. */
  readonly label: string;
  readonly undo: boolean;
  state: "queued" | "sending" | "unconfirmed";
  /** The request as first sent. Try again sends it unchanged. */
  request?: TransactionalInvoke;
}

/** The Collection's rules as a page has them, which the queue checks and sends changes under. */
export interface WriteQueueRules {
  workspaceId: string;
  datasetId: string;
  revision: number;
  revisionSha256: string;
  tableName: string;
  fields: readonly TransactionalField[];
  /** The field a read finds one record by, when the table has one. */
  primaryKeyFieldId?: string;
  /** The operations that may run now. An offline copy has none that change records. */
  operations: readonly DatasetOperation[];
  offline: boolean;
  invoke(request: TransactionalInvoke, signal: AbortSignal): Promise<{ result: AppBackendJson }>;
}

/**
 * What one page gives the queue, read again at each step: the rules as the
 * page has them, where it reports a failure while it is open, and how it
 * shows what became of a change.
 */
export interface WriteQueueHost extends WriteQueueRules, Pick<CollectionChangeReports, "onError" | "onSettled"> {
  confirmed(write: QueuedWrite, receipt: AppBackendJson): void;
  /**
   * A change that will not be sent again. True when the page's form shows
   * what it held and why, so nothing else does. `refused`: the Collection
   * answered no, so a page may open a new record's form again for it.
   */
  dropped(write: QueuedWrite, reason: string, refused: boolean): boolean;
  unconfirmed(write: QueuedWrite): void;
  /** The records the page shows are older than a change, so it reads them again. */
  read(): void;
  /** The host answered under other rules than the page's, so the page describes the Collection again. */
  describe(): void;
}

/** A change that needs the person, for the page to list when no cell shows it. */
export type WriteAttention =
  | { kind: "unconfirmed"; write: QueuedWrite }
  | { kind: "waiting"; write: QueuedWrite; reason: string }
  | { kind: "held"; recordKey: string; recordId: string | number; fieldId: string; fieldName: string; value: AppBackendJson; reason: string }
  | { kind: "record"; id: number; values: Readonly<Record<string, Typed>>; reason: string };

/** One open page's view of its table's queue. */
export interface WriteQueuePage {
  /** The table's view of each cell's change. One object for the page's life. */
  readonly statuses: TableCellStatuses;
  /** The highest change to this cell that its record's value already shows. */
  acknowledged(record: CollectionRecord, field: string): number;
  /**
   * Gives the page's rules and handlers. The page gives them before it opens,
   * and again at each commit. The queue takes its own rules from the newest
   * revision a page has given, so a page on an older one never replaces them.
   */
  sync(host: WriteQueueHost): void;
  /** The page opened. Returns what closes it. */
  open(): () => void;
  /** Call when a read of records starts, and pass what it returns to `readShown`. A saved offline page shows no change. */
  readStarted(): number;
  /** The page shows the records a read returned. */
  readShown(token: number, rows: readonly TransactionalRow[]): void;
}

export const NOT_CONFIRMED = "dohc could not confirm this change.";
const REFUSED = "The Collection refused this change.";
const WAITING_BEHIND = "Waiting for an earlier change to this record";
const WAITING_OFFLINE = "Waiting for the Collection to come back online";
const WAITING_READ = "Waiting for dohc to read this record again";
export const RULES_DISALLOW = "The Collection's rules no longer allow this change, so dohc did not save it.";
const FIELD_CHANGED = "This field changed, so dohc did not save this value. Enter a value the field takes.";
const FIELD_REMOVED = "This field was removed, so dohc did not save this value.";
const RULES_CHANGED = "The Collection's rules changed before dohc confirmed this change. Check the record, then make the change again.";
const RECORD_GONE = "This record is no longer in the Collection, so dohc did not save this change.";
const DISCARDED = "dohc could not confirm this change, and you discarded it. Check the record before you make the change again.";

type Held = { id: number; recordId: string | number; fieldName: string; value: AppBackendJson; reason: string };
type Settled = { id: number; seq: number; status: TableCellStatus };
type Shown = { signature: string; status: TableCellStatus };
/** The one request in flight: a change, or a read of one record for its version. */
type Flight = { abort: AbortController; revisionSha256: string; write?: QueuedWrite };
/** A record whose version no receipt reported. `lookup`: a page's read left it out, so the queue reads it by its key. `stuck`: that read can't run, or failed. */
type Unknown = { seq: number; lookup: boolean; stuck: boolean };
type Page = {
  /** The page's view, by which a change knows the page that made it. */
  view: WriteQueuePage | null;
  host: WriteQueueHost | null;
  /** Confirmed values this page's records do not show yet. */
  settled: CellMap<Settled>;
  /** The last outcome this page's records show. */
  seen: number;
  /** The last outcome this page has not read past, or null. */
  unread: number | null;
  readAsked: boolean;
};
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
 * The changes made to one table that its host has not confirmed. Every page
 * that shows the table shares the one queue, and it sends without them.
 *
 * One request is in flight at a time, in the order the changes were made, so
 * a record's changes reach the host in order. A change dohc could not confirm
 * keeps its request and holds only its own record's later changes. Each
 * change after a confirmed one uses the version that receipt reports, or the
 * version a read returns when the receipt reports none.
 *
 * With no page open, an outcome goes to the toast and Notices of the
 * workspace's open shell. While the window shows another workspace the
 * queue sends nothing, and goes on when its workspace's shell opens again.
 * Changes still unsent or unconfirmed when dohc quits are lost.
 */
export class WriteQueue {
  private readonly writes: QueuedWrite[] = [];
  private flight: Flight | null = null;
  /** The rules changes are checked against and sent under: those of the newest revision a page has given. They stay once every page has closed. */
  private rules: WriteQueueRules | null = null;
  /** The page that gave them, which may always give them again. */
  private rulesFrom: Page | null = null;
  /** The page that made each change, which hears first what became of it. */
  private readonly madeBy = new WeakMap<QueuedWrite, WriteQueuePage>();
  /** Whether Notices holds this queue's row for the changes that need the person. */
  private reminded = false;
  private readonly pages = new Set<Page>();
  private nextId = 1;
  /** Rises with each outcome. A read that starts at or after an outcome's number shows it. */
  private seq = 0;
  /** The newest version the queue knows of a record, from a receipt or a read, for the record's next change. */
  private readonly versions = new Map<string, { version: number; seq: number }>();
  /** Records changed with no version reported, whose next change waits for a read. */
  private readonly unknown = new Map<string, Unknown>();
  /** Values dohc did not save, kept for the person until they dismiss them. */
  private readonly held: CellMap<Held> = new Map();
  /** New records dohc did not save, kept the same way. */
  private readonly records: Array<{ id: number; values: Readonly<Record<string, Typed>>; reason: string }> = [];
  private shown: CellMap<Shown> = new Map();
  /** Why each change that waits does, by its id. */
  private waits = new Map<number, string>();
  private readonly listeners = new Set<() => void>();
  private readonly retiredListeners = new Set<(id: number) => void>();
  private changes = 0;

  constructor(private readonly scope: string) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** Rises whenever anything the queue shows changes. */
  readonly version = (): number => this.changes;
  /** Tells the table which changes will never save, so it forgets what it carried for them. */
  readonly subscribeToDiscarded = (listener: (id: number) => void): (() => void) => {
    this.retiredListeners.add(listener);
    return () => { this.retiredListeners.delete(listener); };
  };

  get size(): number { return this.writes.length; }
  /** The id the next change gets. */
  get nextWrite(): number { return this.nextId; }
  find(id: number): QueuedWrite | undefined { return this.writes.find(write => write.id === id); }

  /** A page's view of the queue. It shows nothing of its own until the page opens it. */
  page(): WriteQueuePage {
    const page: Page = { view: null, host: null, settled: new Map(), seen: 0, unread: null, readAsked: false };
    return page.view = {
      statuses: {
        subscribe: this.subscribe,
        get: (recordId, field) => this.shown.get(recordId)?.get(field)?.status ?? page.settled.get(recordId)?.get(field)?.status,
      },
      acknowledged: (record, field) => {
        let lowest = this.nextId;
        for (const write of this.writes) if (write.record?.key === record.id && Object.hasOwn(write.values, field)) lowest = Math.min(lowest, write.id);
        const settled = page.settled.get(record.id)?.get(field);
        if (settled) lowest = Math.min(lowest, settled.id);
        return lowest - 1;
      },
      sync: host => {
        const was = this.rules;
        page.host = host;
        // Another page's rules replace the queue's only when they are newer, or as new once the page that gave the queue's has closed.
        const givenByOpenPage = this.rulesFrom !== null && this.pages.has(this.rulesFrom);
        if (was && this.rulesFrom !== page && (host.revision < was.revision || (host.revision === was.revision && givenByOpenPage))) return;
        this.rules = host;
        this.rulesFrom = page;
        if (was && was.offline !== host.offline) { this.changed(); this.pump(); }
      },
      open: () => {
        this.pages.add(page);
        // A page that opens reads its records afresh.
        page.seen = this.seq;
        this.retain();
        for (const pending of this.unknown.values()) pending.stuck = false;
        // The rules may have changed since a page last gave them.
        this.rulesChanged();
        return () => {
          this.pages.delete(page);
          page.settled.clear(); page.unread = null; page.readAsked = false;
          this.changed();
          // What waited for this page's read goes on without it.
          this.pump();
        };
      },
      readStarted: () => page.host?.offline ? -1 : this.seq,
      readShown: (token, rows) => {
        page.readAsked = false;
        page.seen = Math.max(page.seen, token);
        for (const [recordKey, fields] of page.settled) {
          for (const [fieldId, settled] of fields) if (settled.seq <= token) fields.delete(fieldId);
          if (fields.size === 0) page.settled.delete(recordKey);
        }
        for (const [recordKey, pending] of this.unknown) {
          if (pending.seq > token) continue;
          const row = rows.find(candidate => JSON.stringify(candidate.id) === recordKey);
          // The read shows the record after the change that reported no version. A read that leaves the record out says nothing of it.
          if (row) { this.unknown.delete(recordKey); this.versions.set(recordKey, { version: row.version, seq: pending.seq }); }
          else { pending.lookup = true; pending.stuck = false; }
        }
        // A read that started after a record's last receipt shows the record no older than that receipt left it.
        for (const shown of rows) { const known = this.versions.get(JSON.stringify(shown.id)); if (known && known.seq <= token) known.version = shown.version; }
        if (page.unread !== null && page.unread <= token) page.unread = null;
        this.changed();
        this.pump();
      },
    };
  }

  /** Adds a change after every change made before it. `from`: the page that made it. */
  enqueue(change: { kind: QueuedWrite["kind"]; record: Pick<TransactionalRow, "id" | "version"> | null; operationId: string; values?: Record<string, Typed>; label: string; undo?: boolean }, from?: WriteQueuePage): number {
    const record = change.record ? { id: change.record.id, key: JSON.stringify(change.record.id) } : null;
    const write: QueuedWrite = { id: this.nextId++, kind: change.kind, record, operationId: change.operationId, values: change.values ?? {}, baseVersion: change.record?.version ?? 0,
      key: crypto.randomUUID(), label: change.label, undo: change.undo ?? false, state: "queued" };
    if (from) this.madeBy.set(write, from);
    // A new change to a cell replaces the value dohc did not save there.
    if (record) for (const fieldId of Object.keys(write.values)) take(this.held, record.key, fieldId);
    this.writes.push(write);
    this.retain();
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
    this.retire(id);
    this.retain();
    this.changed();
    return id;
  }
  dismiss(recordKey: string, fieldId: string): void {
    take(this.held, recordKey, fieldId);
    this.changed();
  }
  /** Lets go of a new record dohc did not save. */
  dismissRecord(id: number): void {
    const at = this.records.findIndex(entry => entry.id === id);
    if (at >= 0) this.records.splice(at, 1);
    this.changed();
  }
  /** Sends a change dohc could not confirm again, with the same request, while it still waits. An offline copy sends nothing, so the change keeps its Try again. */
  retry(id: number): void {
    const write = this.find(id);
    if (!write || write.state !== "unconfirmed" || this.rules?.offline) return;
    write.state = "queued";
    this.changed();
    this.pump();
  }
  /**
   * Gives up a change dohc could not confirm. Its request is never sent
   * again. The change may have landed, so its record's next change waits for
   * a read, and what the person gave stays for them to check.
   */
  discard(id: number): void {
    const write = this.find(id);
    if (!write || write.state !== "unconfirmed") return;
    this.outcome();
    if (write.record) this.forget(write.record.key);
    this.drop(write, DISCARDED);
    this.changed();
    this.pump();
  }
  /** The changes that need the person: those dohc could not confirm, those that wait, and the values and new records it did not save. */
  attention(): WriteAttention[] {
    const waiting: WriteAttention[] = [];
    for (const write of this.writes) {
      const reason = this.waits.get(write.id);
      if (write.state === "unconfirmed") waiting.push({ kind: "unconfirmed", write });
      else if (reason !== undefined) waiting.push({ kind: "waiting", write, reason });
    }
    for (const [recordKey, fields] of this.held) for (const [fieldId, held] of fields) waiting.push({ kind: "held", recordKey, fieldId, recordId: held.recordId, fieldName: held.fieldName, value: held.value, reason: held.reason });
    for (const record of this.records) waiting.push({ kind: "record", ...record });
    return waiting;
  }

  /**
   * The shell of the queue's workspace opened, so the window shows that
   * workspace again. One row in Notices says what here needs the person,
   * since no page may be open to show it, and the changes not sent yet go on.
   */
  resume(workspaceId: string): void {
    const rules = this.rules, shell = collectionChangeShell(workspaceId);
    if (!rules || rules.workspaceId !== workspaceId || !shell) return;
    const waiting = this.attention();
    if (waiting.length > 0) {
      const unconfirmed = waiting.filter(item => item.kind === "unconfirmed").length, unsaved = waiting.length - unconfirmed;
      const count = (changes: number) => changes === 1 ? "a change" : `${changes} changes`;
      const words = `${unconfirmed === 0 ? `dohc did not save ${count(unsaved)} to ${rules.tableName}`
        : unsaved === 0 ? `dohc could not confirm ${count(unconfirmed)} to ${rules.tableName}`
        : `dohc could not confirm ${count(unconfirmed)} to ${rules.tableName}, and did not save ${unsaved} more`}. Open it to check its records.`;
      // Try again sends what dohc could not confirm, and reads again the records it could not read.
      const again = !rules.offline && waiting.some(item => item.kind === "unconfirmed" || (item.kind === "waiting" && item.reason === WAITING_READ));
      this.reminded = true;
      shell.onError(words, new Error(words), again ? () => {
        for (const pending of this.unknown.values()) pending.stuck = false;
        for (const write of [...this.writes]) this.retry(write.id);
        this.changed();
        this.pump();
      } : null, this.reminder());
    }
    this.pump();
  }
  private reminder(): string { return `collection-changes:${this.scope}`; }

  /**
   * The Collection's rules changed. A request sent under the old rules can't
   * be confirmed or sent again, so its change goes, and its value stays on
   * its cell. A change not sent yet is checked against the new rules when it
   * goes.
   */
  rulesChanged(): void {
    const rules = this.rules;
    if (!rules) return;
    const stale = this.writes.filter(write => write.request && (write.request.revision !== rules.revision || write.request.revisionSha256 !== rules.revisionSha256));
    if (this.flight && this.flight.revisionSha256 !== rules.revisionSha256 && (!this.flight.write || stale.includes(this.flight.write))) { this.flight.abort.abort(); this.flight = null; }
    if (stale.length > 0) {
      this.outcome();
      for (const write of stale) {
        // The change may have landed, so its record's version is unknown until a read.
        if (write.record) this.forget(write.record.key);
        this.drop(write, RULES_CHANGED);
      }
      this.reports()?.onError("The Collection's rules changed. Check the records before making another change.", new Error("The Collection's rules changed before this change was confirmed. Check the records before making another change."), null);
    }
    this.changed();
    this.pump();
  }

  /** Where an outcome is reported: an open page, or with none open the shell of the queue's workspace while that is open. */
  private reports(): Pick<CollectionChangeReports, "onError" | "onSettled"> | undefined {
    for (const page of this.pages) if (page.host) return page.host;
    return this.rules ? collectionChangeShell(this.rules.workspaceId) : undefined;
  }

  private pump(): void {
    const rules = this.rules;
    // While the window shows another workspace, main refuses this one's changes, so they wait unsent.
    if (!rules || this.flight || rules.offline || !collectionChangeShell(rules.workspaceId)) return;
    let waitsForRead = false, stuck = false;
    const blocked = new Set<string>();
    for (const write of [...this.writes]) {
      const key = write.record?.key;
      if (key !== undefined && blocked.has(key)) continue;
      if (write.state === "unconfirmed") { if (key !== undefined) blocked.add(key); continue; }
      const pending = key === undefined ? undefined : this.unknown.get(key);
      if (pending) {
        blocked.add(key!);
        if (pending.stuck) continue;
        // An open page reads first. Its read may show the record, and it shows the person the change either way.
        if (!pending.lookup && this.pages.size > 0) { waitsForRead = true; continue; }
        if (this.lookup(write.record!, pending, rules)) return;
        stuck = pending.stuck = true;
        continue;
      }
      if (this.send(write, rules)) return;
    }
    if (stuck) this.changed();
    // Nothing more to send: each page reads once for every outcome since its last read.
    for (const page of this.pages) if ((waitsForRead || page.unread !== null) && !page.readAsked) { page.readAsked = true; page.host?.read(); }
  }

  /** Why the rules now refuse a change made under earlier ones, or null. */
  private problem(write: QueuedWrite, rules: WriteQueueRules): string | null {
    const operation = rules.operations.find(candidate => candidate.operationId === write.operationId && !candidate.readOnly);
    if (!operation) return RULES_DISALLOW;
    for (const [fieldId, typed] of Object.entries(write.values)) {
      const now = rules.fields.find(field => field.fieldId === fieldId);
      if (!now) return FIELD_REMOVED;
      if (cannotTake(typed.under, now, typed.value)) return FIELD_CHANGED;
      if (!operation.fieldIds.includes(fieldId)) return RULES_DISALLOW;
    }
    return null;
  }

  /** Sends the change. False when the rules no longer allow it, so it went. */
  private send(write: QueuedWrite, rules: WriteQueueRules): boolean {
    if (!write.request) {
      const problem = this.problem(write, rules);
      if (problem !== null) { this.dropUnsent(write, problem, rules); this.changed(); return false; }
      // A value emptied under a field's old definition is empty in the new one's own way.
      const values = Object.fromEntries(Object.entries(write.values).map(([fieldId, typed]) => {
        const now = rules.fields.find(field => field.fieldId === fieldId)!;
        return [fieldId, isEmptyValue(typed.value) && fieldShape(now) !== fieldShape(typed.under) ? emptyValue(now) : typed.value];
      }));
      const expectedVersion = write.record ? this.versions.get(write.record.key)?.version ?? write.baseVersion : 0;
      const input: AppBackendJson = write.kind === "create" ? { values } : write.kind === "delete" ? { id: write.record!.id, expectedVersion } : { id: write.record!.id, expectedVersion, values };
      write.request = { workspaceId: rules.workspaceId, datasetId: rules.datasetId, revision: rules.revision, revisionSha256: rules.revisionSha256, operationId: write.operationId, input, idempotencyKey: write.key };
    }
    write.state = "sending";
    const flight: Flight = { write, abort: new AbortController(), revisionSha256: write.request.revisionSha256 };
    this.flight = flight;
    this.changed();
    let answer: Promise<{ result: AppBackendJson }>;
    try { answer = rules.invoke(write.request, flight.abort.signal); } catch (cause) { answer = Promise.reject(cause); }
    answer.then(response => this.confirm(flight, write, response.result), cause => this.fail(flight, write, cause));
    return true;
  }

  /**
   * Reads one record by its key, as the page reads an open record, for the
   * version its next change needs. False when the table's read can't find a
   * record by its key.
   */
  private lookup(record: NonNullable<QueuedWrite["record"]>, pending: Unknown, rules: WriteQueueRules): boolean {
    const key = rules.primaryKeyFieldId;
    const read = rules.operations.find(operation => operation.kind === "read" && operation.readOnly);
    if (key === undefined || !read?.fieldIds.includes(key)) return false;
    const flight: Flight = { abort: new AbortController(), revisionSha256: rules.revisionSha256 };
    this.flight = flight;
    const request: TransactionalInvoke = { workspaceId: rules.workspaceId, datasetId: rules.datasetId, revision: rules.revision, revisionSha256: rules.revisionSha256, operationId: read.operationId,
      input: { limit: 1, filters: [{ fieldId: key, value: record.id }] }, idempotencyKey: crypto.randomUUID() };
    const failed = (cause: unknown) => {
      pending.stuck = true;
      // Try again reads the record once more, while its changes still wait for it.
      this.reports()?.onError(`dohc could not read record ${String(record.id)} in ${rules.tableName}, so its changes are waiting.`, cause, () => {
        if (this.unknown.get(record.key) !== pending) return;
        pending.stuck = false; this.changed(); this.pump();
      }, `collection-record:${this.scope}:${record.key}`);
    };
    const ended = (run: () => void) => {
      if (this.flight !== flight) return;
      this.flight = null;
      // A page's read, or a later change, has answered or replaced what this read was for, so its answer says nothing now.
      if (this.unknown.get(record.key) === pending) run();
      this.changed();
      this.pump();
    };
    let answer: Promise<{ result: AppBackendJson }>;
    try { answer = rules.invoke(request, flight.abort.signal); } catch (cause) { answer = Promise.reject(cause); }
    answer.then(response => ended(() => {
      let rows: TransactionalRow[];
      try { rows = parsePage(response.result, read.fieldIds).rows; } catch (cause) { failed(cause); return; }
      const row = rows.find(candidate => JSON.stringify(candidate.id) === record.key);
      this.unknown.delete(record.key);
      if (row) { this.versions.set(record.key, { version: row.version, seq: this.seq }); return; }
      // The record is gone, so nothing queued for it can save.
      for (const write of this.writes.filter(candidate => candidate.record?.key === record.key)) this.dropUnsent(write, RECORD_GONE, rules);
    }), cause => ended(() => failed(cause)));
    return true;
  }

  private identity(write: QueuedWrite): string { return `collection-change:${this.scope}:${write.key}`; }

  /**
   * A change was confirmed, refused, or dropped, so each page's records are
   * older than it. A page may be asked to read again, even after a read it
   * was asked for failed.
   */
  private outcome(): void {
    this.seq++;
    for (const page of this.pages) { page.unread = this.seq; page.readAsked = false; }
  }

  /** The record's version is not known until a read returns it. */
  private forget(recordKey: string): void {
    this.versions.delete(recordKey);
    this.unknown.set(recordKey, { seq: this.seq, lookup: false, stuck: false });
  }

  private confirm(flight: Flight, write: QueuedWrite, receipt: AppBackendJson): void {
    // A request the rules made stale changes nothing.
    if (this.flight !== flight) return;
    this.flight = null;
    const rules = this.rules!;
    const at = this.writes.indexOf(write);
    if (at >= 0) this.writes.splice(at, 1);
    this.outcome();
    if (write.record) {
      const version = receiptVersion(write, receipt);
      if (version !== null) this.versions.set(write.record.key, { version, seq: this.seq });
      else if (write.kind === "edit") this.forget(write.record.key);
      else this.versions.delete(write.record.key);
      for (const page of this.pages) for (const [fieldId, typed] of Object.entries(write.values)) {
        put(page.settled, write.record.key, fieldId, { id: write.id, seq: this.seq, status: { state: "pending", value: typed.value as CollectionValue } });
      }
    }
    // An open page shows its table's change. With none open, a notice in the workspace's open shell says the change saved, and in which Collection.
    if (this.pages.size === 0) collectionChangeShell(rules.workspaceId)?.onNotice?.(`${write.label} in ${rules.tableName}`);
    else for (const page of this.pages) page.host?.confirmed(write, receipt);
    // The row an earlier failure of this change left in Notices goes.
    this.reports()?.onSettled?.(this.identity(write));
    this.changed();
    this.pump();
  }

  private fail(flight: Flight, write: QueuedWrite, cause: unknown): void {
    if (this.flight !== flight) return;
    this.flight = null;
    // With no page open, a failure still reaches the toast and Notices of the workspace's open shell, and names the Collection.
    // With no shell open either, the change stays as it ended, and Notices says so when the shell opens.
    const rules = this.rules!, open = this.pages.size > 0, reports = this.reports();
    const refused = cause !== null && typeof cause === "object" && "code" in cause && cause.code === "operation_refused";
    if (refused) {
      this.outcome();
      this.drop(write, cause instanceof Error && cause.message ? `${REFUSED} ${cause.message}` : REFUSED, true);
      reports?.onError(open ? REFUSED : `${rules.tableName} refused the change. Open it to check its records.`, cause, null);
    } else if (isCollectionRulesReplaced(cause)) {
      // The host ran nothing: the request names rules it has replaced, so the same request can never save.
      this.outcome();
      if (write.record) this.forget(write.record.key);
      this.drop(write, RULES_CHANGED);
      reports?.onError(open ? "The Collection's rules changed. Check the records before making another change." : `The rules of ${rules.tableName} changed, so dohc did not save the change. Open it to check its records.`, cause, null);
      for (const page of this.pages) page.host?.describe();
    } else {
      write.state = "unconfirmed";
      for (const page of this.pages) page.host?.unconfirmed(write);
      // Try again sends the change only while it still waits, so a row left in Notices can't send it twice.
      reports?.onError(open ? NOT_CONFIRMED : `dohc could not confirm the change to ${rules.tableName}. Open it to check its records.`, cause, () => this.retry(write.id), this.identity(write));
    }
    this.changed();
    this.pump();
  }

  /** Drops a change that was never sent, and says so when no page is open to show why. */
  private dropUnsent(write: QueuedWrite, reason: string, rules: WriteQueueRules): void {
    this.drop(write, reason);
    if (this.pages.size === 0) this.reports()?.onError(`dohc did not save a change to ${rules.tableName}. Open it to check its records.`, new Error(reason), null);
  }

  /**
   * Takes a change out for good. What the person gave stays for them: in a
   * page's form that shows why, on its cells, or, for a new record, in the
   * page's list.
   */
  private drop(write: QueuedWrite, reason: string, refused = false): void {
    const at = this.writes.indexOf(write);
    if (at >= 0) this.writes.splice(at, 1);
    this.retire(write.id);
    // Its Try again in Notices has nothing left to send.
    this.reports()?.onSettled?.(this.identity(write));
    // The page that made the change shows how it ended. Another page takes it, as by opening a new record's form again, only once that page has closed.
    const from = this.madeBy.get(write), maker = from && [...this.pages].find(page => page.view === from);
    if (maker ? maker.host?.dropped(write, reason, refused) : [...this.pages].some(page => page.host?.dropped(write, reason, refused))) return;
    const fields = Object.entries(write.values);
    if (fields.length === 0) return;
    if (!write.record) { this.records.push({ id: write.id, values: write.values, reason }); return; }
    const { key, id } = write.record;
    for (const [fieldId, typed] of fields) {
      // A later change to the cell, or a later value kept on it, replaced this one.
      if ((this.held.get(key)?.get(fieldId)?.id ?? 0) > write.id || this.writes.some(later => later.id > write.id && later.record?.key === key && Object.hasOwn(later.values, fieldId))) continue;
      const fieldName = this.rules?.fields.find(field => field.fieldId === fieldId)?.name ?? typed.under.name;
      put(this.held, key, fieldId, { id: write.id, recordId: id, fieldName, value: typed.value, reason });
    }
  }

  private retire(id: number): void { for (const listener of this.retiredListeners) listener(id); }

  /** Works out each cell's status again, keeps the object of each one that did not change, and tells the listeners. */
  private changed(): void {
    const next: CellMap<Shown> = new Map();
    const show = (record: string, field: string, signature: unknown[], status: () => TableCellStatus) => {
      const text = JSON.stringify(signature), before = this.shown.get(record)?.get(field);
      put(next, record, field, before?.signature === text ? before : { signature: text, status: status() });
    };
    for (const [record, fields] of this.held) for (const [field, held] of fields) {
      show(record, field, ["refused", held.id, held.value, held.reason], () => ({ state: "refused", value: held.value as CollectionValue, reason: held.reason, dismiss: () => this.dismiss(record, field) }));
    }
    // Later changes to a cell show over earlier ones. A record's first change dohc could not confirm holds the rest.
    const blocked = new Set<string>(), waits = new Map<number, string>();
    for (const write of this.writes) {
      const record = write.record?.key;
      const behind = record !== undefined && blocked.has(record);
      if (write.state === "unconfirmed" && record !== undefined) blocked.add(record);
      const reason = write.state === "unconfirmed" && !behind ? null : behind ? WAITING_BEHIND : record !== undefined && this.unknown.get(record)?.stuck ? WAITING_READ
        : this.rules?.offline && write.state === "queued" ? WAITING_OFFLINE : undefined;
      if (typeof reason === "string") waits.set(write.id, reason);
      if (record === undefined) continue;
      for (const [field, typed] of Object.entries(write.values)) {
        const value = typed.value as CollectionValue;
        show(record, field, [reason === null ? "unconfirmed" : reason ?? "pending", write.id, typed.value], () => reason === null ? { state: "unconfirmed", value, reason: NOT_CONFIRMED, retry: () => this.retry(write.id), discard: () => this.discard(write.id) }
          : reason === undefined ? { state: "pending", value } : { state: "waiting", value, reason });
      }
    }
    // A record with a change still queued keeps its version, which that change was made after.
    for (const [recordKey, known] of this.versions) {
      if (!this.writes.some(write => write.record?.key === recordKey) && [...this.pages].every(page => page.seen >= known.seq)) this.versions.delete(recordKey);
    }
    this.shown = next;
    this.waits = waits;
    this.changes++;
    // The row Notices holds for the changes that needed the person goes once none does.
    if (this.reminded && this.attention().length === 0) { this.reminded = false; this.reports()?.onSettled?.(this.reminder()); }
    for (const listener of [...this.listeners]) listener();
    // A queue with no page open and nothing left to keep goes.
    if (this.pages.size === 0 && this.flight === null && this.writes.length === 0 && this.held.size === 0 && this.records.length === 0 && queues.get(this.scope) === this) queues.delete(this.scope);
  }

  /** Stays in the list while a page is open or it holds anything. */
  private retain(): void {
    if (!queues.has(this.scope)) queues.set(this.scope, this);
  }
}

// The one queue of each table with a page open or changes to keep, by workspace, Collection and table.
const queues = new Map<string, WriteQueue>();
/**
 * A table's queue: the one its other pages share, or a new one. A render
 * that never commits leaves an empty queue here until a page of its table
 * opens and closes.
 */
export function writeQueueFor(scope: string): WriteQueue {
  let queue = queues.get(scope);
  if (!queue) queues.set(scope, (queue = new WriteQueue(scope)));
  return queue;
}
/** Whether a table has a queue, for tests of when one goes. */
export function hasWriteQueueForTests(scope: string): boolean {
  return queues.has(scope);
}
// A workspace's shell can list notices: its tables' queues say what needs the person, and send what waited.
onCollectionChangesResumed(workspaceId => { for (const queue of [...queues.values()]) queue.resume(workspaceId); });
/** Tests start without changes an earlier test's page kept, and with no shell open. */
export function resetWriteQueuesForTests(): void {
  queues.clear();
  closeCollectionChangeShellsForTests();
}
