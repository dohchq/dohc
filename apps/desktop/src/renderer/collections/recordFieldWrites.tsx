import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  frontmatterEditsRefused,
  setFrontmatterValue,
} from "@dohc/ydoc-projection/frontmatter";
import { FRONTMATTER_EDIT_REFUSED_MESSAGE } from "../markdown/frontmatter";
import type { CollectionCellChange } from "@dohc/collection-views";
import type { CollectionValue } from "@dohc/workspace-contracts";
import { useEngineDoc } from "../collab/useEngineDoc";
import { SecondaryButton } from "../ui/controls";
import { addSelectOption } from "./schemaAuthoring";
import { rewriteCollectionSchema } from "./schemaWrite";

// The global host keeps accepted edits alive when navigation unmounts a page.
// It writes through one live document at a time, preserving engine history.

// The live document field PropertiesPanel writes; one name for one thing.
const FRONTMATTER_FIELD = "frontmatter";

// Main's settle retries grow from 800 ms to a 10 s cap. Report a persistent
// lock after that retry window; the engine already holds the edit durably.
export const FILE_LOCKED_REPORT_MS = 15_000;

export const COLLECTION_WRITE_STALL_MS = 20_000;

/**
 * Frontmatter values are what js-yaml round-trips. The one indexed shape it
 * cannot carry as-is is bigint (the engine's wire marker for big integers):
 * write it back as a number when exact, else as its decimal text.
 */
export function frontmatterWriteValue(value: CollectionValue): unknown {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= max && value >= -max ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) return value.map(frontmatterWriteValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        frontmatterWriteValue(entry),
      ]),
    );
  }
  return value;
}

/**
 * Applies a cell edit and holds its lease until the asynchronous save settles.
 * A `createOption` edit first writes its option to the collection's schema —
 * under the queue's ownership, so lineage gates wait for the whole edit and a
 * preparation failure retains it whole. A persistent file lock releases the
 * queue once the engine owns the edit.
 */
export function CollectionRecordFieldWrite({
  workspaceId,
  collectionPath,
  change,
  createOption,
  onPrepared,
  onPreparationStarted,
  onMutationStarted,
  onApplied,
  onDurabilityConfirmed,
  onSettled,
  onHeldDurably,
  onFailed,
}: {
  workspaceId: string;
  collectionPath: string;
  change: CollectionCellChange;
  // A select option the schema must contain before the cell value writes;
  // undefined for a plain edit or once the schema write landed.
  createOption?: string;
  // The option's schema write landed: the queue clears it from the entry so
  // a later failure's retry does not redo a landed schema write.
  onPrepared: () => void;
  onPreparationStarted?: (controller: AbortController) => () => void;
  onMutationStarted?: () => () => void;
  onApplied?: () => void;
  onDurabilityConfirmed?: (message: string) => void;
  // The engine confirmed the save settled: the change is on disk.
  onSettled: () => void;
  // The settle committed but the file is locked: the engine holds the write
  // durably and retries, so the queue reports and moves on — NOT a failure.
  onHeldDurably: (message: string) => void;
  // The change did NOT reach the engine: the queue must retain it. The full
  // state line to show, or null for the generic one.
  onFailed: (message: string | null, recoveryOnly?: boolean) => void;
}) {
  const docState = useEngineDoc({
    workspaceId,
    path: change.recordPath,
    enabled: true,
  });
  const applied = useRef(false);
  const sawSaving = useRef(false);
  const prepStarted = useRef(false);
  const alive = useRef(true);
  const [preparationAbort] = useState(() => new AbortController());
  const releasePreparation = useRef<(() => void) | undefined>(undefined);
  const lockedReport = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      alive.current = false;
      preparationAbort.abort();
      releasePreparation.current?.();
      if (lockedReport.current !== null) clearTimeout(lockedReport.current);
    },
    [],
  );

  useEffect(() => {
    if (createOption === undefined || prepStarted.current || docState.opening) return;
    if (!docState.available || !docState.doc) {
      onFailed(null);
      return;
    }
    if (docState.doc.getMap(FRONTMATTER_FIELD).get("id") !== change.recordId) {
      onFailed(
        "This file no longer contains the original record. Your change is still here.",
      );
      return;
    }
    prepStarted.current = true;
    if (selectionChangedSinceEdit(docState.doc.getMap(FRONTMATTER_FIELD).get(change.field), change.previousValues, change.value)) {
      onFailed(CHANGED_SELECTION_MESSAGE, true);
      return;
    }
    releasePreparation.current = onPreparationStarted?.(preparationAbort);
    let selectionChanged = false;
    void rewriteCollectionSchema({
      workspaceId,
      collectionPath,
      mutate: (schema) => {
        selectionChanged = selectionChangedSinceEdit(docState.doc?.getMap(FRONTMATTER_FIELD).get(change.field), change.previousValues, change.value);
        if (selectionChanged) throw new Error(CHANGED_SELECTION_MESSAGE);
        const next = addSelectOption(schema, change.field, createOption);
        const field = next.fields.find((entry) => entry.name === change.field);
        const valueMatches = field?.type === "select"
          ? change.value === createOption
          : field?.type === "multi-select" && Array.isArray(change.value) &&
            change.value.every((value) => typeof value === "string") &&
            change.value.includes(createOption);
        if (!field || (field.type !== "select" && field.type !== "multi-select") ||
          !valueMatches || !field.options.includes(createOption)) {
          throw new Error("This field changed. Copy your value, or retry after restoring the field.");
        }
        return next;
      },
      signal: preparationAbort.signal,
      onMutationStarted,
    }).then((result) => {
      // An unmounted writer's result must not settle a write it no longer
      // owns. A retry belongs to a fresh writer.
      if (!alive.current) return;
      if (selectionChanged) {
        onFailed(CHANGED_SELECTION_MESSAGE, true);
        return;
      }
      if (result.status === "written") {
        onPrepared();
        return;
      }
      onFailed(
        result.status === "conflict"
          ? "This collection changed while you were editing. Try again."
          : result.detail
            ? `dohc could not update this collection. ${result.detail}`
            : null,
      );
    });
  }, [
    workspaceId,
    collectionPath,
    change.field,
    change.recordId,
    change.value,
    docState.opening,
    docState.available,
    docState.doc,
    createOption,
    onPrepared,
    onPreparationStarted,
    onMutationStarted,
    onFailed,
    preparationAbort,
    change.previousValues,
  ]);

  useEffect(() => {
    // An unprepared option edit must not touch the record yet: its value is
    // valid only once the schema write lands.
    if (applied.current || createOption !== undefined || docState.opening)
      return;
    if (!docState.available || !docState.doc) {
      // The open settled without a session (conflict, deletion, engine off).
      onFailed(null);
      return;
    }
    const doc = docState.doc;
    if (doc.getMap(FRONTMATTER_FIELD).get("id") !== change.recordId) {
      onFailed(
        "This file no longer contains the original record. Your change is still here.",
      );
      return;
    }
    if (selectionChangedSinceEdit(doc.getMap(FRONTMATTER_FIELD).get(change.field), change.previousValues, change.value)) {
      onFailed(CHANGED_SELECTION_MESSAGE, true);
      return;
    }
    if (frontmatterEditsRefused(doc)) {
      onFailed(FRONTMATTER_EDIT_REFUSED_MESSAGE);
      return;
    }
    applied.current = true;
    onApplied?.();
    setFrontmatterValue(doc, change.field, frontmatterWriteValue(change.value));
  }, [
    docState.opening,
    docState.available,
    docState.doc,
    change,
    createOption,
    onFailed,
    onApplied,
  ]);

  useEffect(() => {
    if (!applied.current) return;
    switch (docState.saveState) {
      case "saving":
        sawSaving.current = true;
        return;
      case "saved":
        // Only a "saved" AFTER our own edit was staged counts: the session
        // opens in "saved", and releasing on that one would race the flush.
        if (sawSaving.current) onSettled();
        return;
      case "file-locked":
        // The engine journal owns this edit and keeps retrying the file.
        // Arm once so intermediate "saving" events cannot restart the window.
        {
          const file = change.recordPath.split("/").at(-1) ?? change.recordPath;
          const message = `Another program has ${file} open, so dohc can't update it on disk. This change is saved and dohc retries until the file is free.`;
          onDurabilityConfirmed?.(message);
          if (lockedReport.current === null) {
            lockedReport.current = setTimeout(() => {
              onHeldDurably(message);
            }, FILE_LOCKED_REPORT_MS);
          }
        }
        return;
      case "saved-to-host":
        onDurabilityConfirmed?.("The session host accepted this change. The local file may still be updating.");
        onHeldDurably("The session host accepted this change. The local file may still be updating.");
        return;
      case "pending-share":
        onDurabilityConfirmed?.("Saved on this device. The shared file update is pending.");
        onHeldDurably("Saved on this device. The shared file update is pending.");
        return;
      case "error":
      case "read-only":
      case "changed-on-disk":
      case "deleted":
        onFailed(
          docState.saveError
            ? `dohc could not save this change. ${docState.saveError}`
            : null,
        );
        return;
    }
  }, [
    docState.saveState,
    docState.saveError,
    change.recordPath,
    onSettled,
    onHeldDurably,
    onDurabilityConfirmed,
    onFailed,
  ]);

  return null;
}

export type CollectionFieldWrite = {
  id: number;
  workspaceId: string;
  collectionPath: string;
  change: CollectionCellChange;
  lineage: number;
  // Settlement committed the index; a query started after this callback can
  // acknowledge the edit. An already-running query cannot.
  onIndexed?: () => void;
  onDiscarded?: () => void;
  // A select option the collection's schema must gain before the cell value
  // writes. Cleared when that schema write lands, so a retry after a later
  // failure replays only what did not land. Undefined for a plain edit.
  createOption?: string;
};

// A write that did NOT reach the engine, retained whole: the accepted value
// belongs to the user until a retry lands it or the user discards it. A
// file-locked settle is NOT one of these — the engine already holds that
// write durably.
export type CollectionWriteFailure = CollectionFieldWrite & {
  // The state line the failure row shows.
  message: string;
  superseded?: boolean;
  recoveryOnly?: boolean;
};

export type CollectionWriteStatus = {
  // The failure line the page's state slot shows, or null. A new write for
  // the collection clears it; a failed settle repaints it.
  error: string | null;
  // Grows once per settled write. The engine's index updates when a settled
  // write applies, so a mounted page re-reads on change instead of waiting
  // for the activity event.
  settled: number;
};

const EMPTY_STATUS: CollectionWriteStatus = Object.freeze({
  error: null,
  settled: 0,
});

// A memory bound, not a UX target (MAX_COLLECTION_VIEWS posture): at the
// bound the oldest idle status gives way. Entries with a queued write or a
// visible failure stay.
export const MAX_COLLECTION_WRITE_STATUSES = 100;

let queue: readonly CollectionFieldWrite[] = [];
let failures: readonly CollectionWriteFailure[] = [];
let nextWriteId = 0;
let appliedWrite: { id: number; durableMessage: string | null; stalled: boolean } | null = null;
const statuses = new Map<string, CollectionWriteStatus>();
// Workspaces whose cell edits a path/lineage operation paused, refcounted:
// Explorer's runChanges and a version restore can overlap, and editing
// resumes only when the LAST operation releases.
const pausedWorkspaces = new Map<string, number>();
const workspaceLineages = new Map<string, number>();
const schemaMutations = new Map<symbol, { workspaceId: string }>();
const schemaPreparations = new Map<number, AbortController>();
const listeners = new Set<() => void>();

function retainSchemaMutation(workspaceId: string): () => void {
  const id = Symbol();
  schemaMutations.set(id, { workspaceId });
  notify();
  return () => {
    schemaMutations.delete(id);
    notify();
  };
}

// What an edit refused during a pause shows; the failure row's Retry is the
// next step once the operation finishes.
const PAUSED_REFUSAL_MESSAGE =
  "dohc did not save this change because a file operation was in progress.";
const STALE_LINEAGE_MESSAGE =
  "This workspace changed versions or restored earlier work. Copy your unsaved value before discarding it.";
const SUPERSEDED_MESSAGE =
  "A newer edit replaced this value. Copy your unsaved value before discarding it.";
const SAVE_UNCONFIRMED_MESSAGE =
  "dohc has not confirmed this save yet. Keep dohc open until saving finishes.";
const CHANGED_SELECTION_MESSAGE =
  "This selection changed since your edit. Copy your unsaved value before discarding it.";

function sameCollectionValue(left: unknown, right: CollectionValue): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(right)) {
    return Array.isArray(left) && left.length === right.length &&
      right.every((value, index) => sameCollectionValue(left[index], value));
  }
  if (Array.isArray(left)) return false;
  const keys = Object.keys(right);
  return keys.length === Object.keys(left).length && keys.every((key) =>
    Object.hasOwn(left, key) && sameCollectionValue((left as Record<string, unknown>)[key], right[key]!),
  );
}

function sameSelectionValue(left: unknown, right: CollectionValue): boolean {
  const a = left ?? [];
  const b = right ?? [];
  // Flagged values can still be repaired. An unchanged raw value is safe
  // to replace even when it is not a valid selection yet.
  if (sameCollectionValue(a, b)) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const expected = new Set(b);
  return a.length === b.length && new Set(a).size === a.length &&
    expected.size === b.length && a.every((value) => typeof value === "string" && expected.has(value));
}

function selectionChangedSinceEdit(current: unknown, previousValues: readonly CollectionValue[] | undefined, desired: CollectionValue): boolean {
  return previousValues !== undefined && !previousValues.some((base) => sameSelectionValue(current, base)) &&
    !sameSelectionValue(current, desired);
}

function sameField(left: CollectionFieldWrite, right: CollectionFieldWrite): boolean {
  return left.workspaceId === right.workspaceId &&
    left.lineage === right.lineage &&
    left.change.recordId === right.change.recordId &&
    left.change.recordPath === right.change.recordPath &&
    left.change.field === right.change.field;
}

// Every retained or queued input takes the same ordering boundary, including
// callbacks refused during a pause. Keep the marker after newer work settles.
function recordWriteOrder(write: CollectionFieldWrite): boolean {
  const superseded = queue.some((later) => later.id > write.id && sameField(write, later)) ||
    failures.some((later) => later.id > write.id && sameField(write, later));
  failures = failures.map((failure) =>
    !failure.superseded && write.id > failure.id && sameField(failure, write)
      ? { ...failure, superseded: true }
      : failure,
  );
  return superseded;
}

function retainFailure(write: CollectionFieldWrite, message: string, recoveryOnly = false): void {
  const superseded = recordWriteOrder(write);
  failures = [...failures, { ...write, message, superseded, recoveryOnly }];
}

function collectionWriteLineage(workspaceId: string): number {
  return workspaceLineages.get(workspaceId) ?? 0;
}

// Called at the shell's confirmed version/restore boundary, before its
// operation releases the pause. A failed preflight never advances it.
export function advanceCollectionWriteLineage(workspaceId: string): void {
  workspaceLineages.set(workspaceId, collectionWriteLineage(workspaceId) + 1);
  notify();
}

export function useCollectionWriteLineage(workspaceId: string): number {
  return useSyncExternalStore(subscribe, () => collectionWriteLineage(workspaceId));
}

function keyFor(workspaceId: string, collectionPath: string): string {
  // JSON quotes each part, so two different keys cannot collide.
  return JSON.stringify([workspaceId, collectionPath]);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function trimStatuses(): void {
  if (statuses.size <= MAX_COLLECTION_WRITE_STATUSES) return;
  for (const [key, status] of statuses) {
    if (statuses.size <= MAX_COLLECTION_WRITE_STATUSES) return;
    if (status.error !== null) continue;
    const queued = queue.some(
      (write) => keyFor(write.workspaceId, write.collectionPath) === key,
    );
    if (!queued) statuses.delete(key);
  }
}

/**
 * Queues an edit, or retains it as a failure if a file operation paused edits.
 * A callback already in flight can arrive after its control was disabled.
 * `createOption` hands the queue the whole option-create edit before any
 * schema IPC: a paused workspace refuses it without starting a schema write.
 */
export function enqueueCollectionFieldWrite(
  workspaceId: string,
  collectionPath: string,
  change: CollectionCellChange,
  createOption?: string,
  lineage = collectionWriteLineage(workspaceId),
  onIndexed?: () => void,
  onDiscarded?: () => void,
): boolean {
  nextWriteId += 1;
  const key = keyFor(workspaceId, collectionPath);
  const current = statuses.get(key) ?? EMPTY_STATUS;
  const write = { id: nextWriteId, workspaceId, collectionPath, change, createOption, lineage, onIndexed, onDiscarded };
  if (pausedWorkspaces.has(workspaceId) || lineage !== collectionWriteLineage(workspaceId)) {
    const message = lineage !== collectionWriteLineage(workspaceId)
      ? STALE_LINEAGE_MESSAGE
      : PAUSED_REFUSAL_MESSAGE;
    retainFailure(write, message);
    statuses.set(key, { ...current, error: message });
    trimStatuses();
    notify();
    return false;
  }
  // A new write is a new attempt: clear the stale failure.
  statuses.set(key, { ...current, error: null });
  recordWriteOrder(write);
  queue = [
    ...queue,
    write,
  ];
  trimStatuses();
  notify();
  return true;
}

// The head's option landed in the schema: drop it from the entry, so a later
// failure's retry replays only the cell write. Late-callback safe: only the
// current head's own id may clear it.
function completeCollectionFieldWritePreparation(id: number): void {
  const head = queue[0];
  if (head?.id !== id || head.createOption === undefined) return;
  queue = [{ ...head, createOption: undefined }, ...queue.slice(1)];
  notify();
}

// The host's settle callbacks carry the head's id so a late or repeated
// callback from an unmounting writer cannot pop a write it does not own.
function completeCollectionFieldWrite(id: number): void {
  const head = queue[0];
  if (head?.id !== id) return;
  if (appliedWrite?.id === id) appliedWrite = null;
  queue = queue.slice(1);
  const key = keyFor(head.workspaceId, head.collectionPath);
  const current = statuses.get(key) ?? EMPTY_STATUS;
  statuses.set(key, { ...current, settled: current.settled + 1 });
  head.onIndexed?.();
  notify();
}

// The write leaves the queue but NOT the app: it moves to the retained
// failures whole, so a retry can replay the exact accepted value and only an
// explicit discard may drop it. The collection's status line repaints too,
// for a page that is still mounted.
function failCollectionFieldWrite(id: number, message: string | null, recoveryOnly = false): void {
  const head = queue[0];
  if (head?.id !== id) return;
  if (appliedWrite?.id === id) appliedWrite = null;
  queue = queue.slice(1);
  const line = message ?? "dohc could not save this change.";
  retainFailure(head, line, recoveryOnly);
  const key = keyFor(head.workspaceId, head.collectionPath);
  const current = statuses.get(key) ?? EMPTY_STATUS;
  statuses.set(key, { ...current, error: line });
  notify();
}

// A file-locked settle: the engine holds the write durably and retries, so
// the queue reports the lock on the status line and completes — retaining it
// here would offer a retry of a write that is not lost.
function holdCollectionFieldWriteDurably(id: number, message: string): void {
  const head = queue[0];
  if (head?.id !== id) return;
  const key = keyFor(head.workspaceId, head.collectionPath);
  const current = statuses.get(key) ?? EMPTY_STATUS;
  statuses.set(key, { ...current, error: message });
  completeCollectionFieldWrite(id);
}

/** Replays a retained failure with its original value: back onto the queue. */
export function retryCollectionFieldWrite(id: number): void {
  const failure = failures.find((entry) => entry.id === id);
  if (!failure) return;
  // While the workspace's edits are paused the retry button is disabled;
  // this guard covers a programmatic caller. The failure stays retained.
  if (pausedWorkspaces.has(failure.workspaceId)) return;
  if (failure.superseded || failure.recoveryOnly || failure.lineage !== collectionWriteLineage(failure.workspaceId)) return;
  failures = failures.filter((entry) => entry.id !== id);
  enqueueCollectionFieldWrite(failure.workspaceId, failure.collectionPath, failure.change,
    failure.createOption, failure.lineage, failure.onIndexed, failure.onDiscarded);
}

/** The user's explicit decision to drop a retained failure's value. */
export function discardCollectionFieldWrite(id: number): void {
  const discarded = failures.find((entry) => entry.id === id);
  if (!discarded) return;
  failures = failures.filter((entry) => entry.id !== id);
  discarded.onDiscarded?.();
  const key = keyFor(discarded.workspaceId, discarded.collectionPath);
  const current = statuses.get(key);
  if (current?.error === discarded.message) {
    const remaining = failures.find(
      (entry) => keyFor(entry.workspaceId, entry.collectionPath) === key,
    );
    statuses.set(key, { ...current, error: remaining?.message ?? null });
  }
  notify();
}

/** True while an accepted cell edit has not reached its record's document. */
export function hasPendingCollectionFieldWrites(): boolean {
  return queue.length > 0 || schemaMutations.size > 0;
}

/** The retained failures — writes that need a retry or an explicit discard. */
export function collectionWriteFailures(): readonly CollectionWriteFailure[] {
  return failures;
}

export function useCollectionWriteFailures(): readonly CollectionWriteFailure[] {
  return useSyncExternalStore(subscribe, collectionWriteFailures);
}

/** Admission waits for work owned by other workspaces, including retained input. */
export function useCollectionWritesBlockingAdmission(workspaceId: string): boolean {
  return useSyncExternalStore(subscribe, () => {
    const otherWorkspace = (entry: { workspaceId: string }) => entry.workspaceId !== workspaceId;
    return queue.some(otherWorkspace) || failures.some(otherWorkspace) ||
      [...schemaMutations.values()].some(otherWorkspace);
  });
}

// Unapplied input can become a retained failure. An applied head stays under
// its writer until a real save result; a timeout cannot prove it is unsaved.
// The exclusion matches the workspace-admission drain.
export function abandonPendingCollectionFieldWrites(message: string, exceptWorkspaceId?: string): void {
  if (queue.length === 0) return;
  const abandoned = queue.filter((write) =>
    write.workspaceId !== exceptWorkspaceId && write.id !== appliedWrite?.id,
  );
  for (const write of abandoned) schemaPreparations.get(write.id)?.abort();
  for (const write of abandoned) retainFailure(write, message);
  const abandonedIds = new Set(abandoned.map((write) => write.id));
  queue = queue.filter((write) => !abandonedIds.has(write.id));
  if (appliedWrite && queue[0]?.workspaceId !== exceptWorkspaceId) {
    if (appliedWrite.durableMessage !== null) {
      holdCollectionFieldWriteDurably(appliedWrite.id, appliedWrite.durableMessage);
      return;
    }
    appliedWrite.stalled = true;
  }
  notify();
}

/**
 * Rename/move remap (remapWorkbenchPaths precedent): queued and retained
 * writes name their record and collection by PATH, so they follow the same
 * projection as tabs — otherwise a write replays against the path the move
 * vacated. A null projection (deletion) keeps the original path: the write
 * then fails there and is retained for the user to discard.
 */
export function remapCollectionFieldWritePaths(
  workspaceId: string,
  project: (path: string) => string | null,
): void {
  const remap = <T extends CollectionFieldWrite>(write: T): T => {
    if (write.workspaceId !== workspaceId) return write;
    const recordPath =
      project(write.change.recordPath) ?? write.change.recordPath;
    const collectionPath =
      project(write.collectionPath) ?? write.collectionPath;
    if (
      recordPath === write.change.recordPath &&
      collectionPath === write.collectionPath
    ) {
      return write;
    }
    return { ...write, collectionPath, change: { ...write.change, recordPath } };
  };
  queue = queue.map(remap);
  failures = failures.map(remap);
  // Completed file-locked writes still have a status after leaving the queue.
  const movedStatuses: Array<[string, CollectionWriteStatus]> = [];
  for (const [key, status] of statuses) {
    const [statusWorkspaceId, collectionPath] = JSON.parse(key) as [string, string];
    if (statusWorkspaceId !== workspaceId) continue;
    const projectedPath = project(collectionPath);
    if (projectedPath === collectionPath) continue;
    statuses.delete(key);
    if (projectedPath !== null) movedStatuses.push([keyFor(workspaceId, projectedPath), status]);
  }
  for (const [key, status] of movedStatuses) statuses.set(key, status);
  notify();
}

export type CollectionWriteSettleReport = {
  // EVERY retained failure in scope at resolution — including ones from
  // before the wait — so a boundary that must not continue over an
  // unresolved failure sees all of them, not only fresh ones.
  failed: number;
  // The queue stopped moving for `stallMs` with writes still queued; the
  // caller decides what a stuck queue means.
  stalled: boolean;
};

function settleWrites(
  inScope: (entry: { workspaceId: string }) => boolean,
  options?: { stallMs?: number },
): Promise<CollectionWriteSettleReport> {
  const queuePending = () =>
    queue.some(inScope) || [...schemaMutations.values()].some(inScope);
  const failedCount = () => failures.filter(inScope).length;
  if (!queuePending()) {
    return Promise.resolve({ failed: failedCount(), stalled: false });
  }
  return new Promise((resolve) => {
    let lastQueue = queue;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (stalled: boolean) => {
      if (stallTimer !== null) clearTimeout(stallTimer);
      unsubscribe();
      resolve({ failed: failedCount(), stalled });
    };
    const armStall = () => {
      if (options?.stallMs === undefined) return;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => finish(true), options.stallMs);
    };
    const unsubscribe = subscribe(() => {
      if (!queuePending()) {
        finish(false);
        return;
      }
      // Any queue movement is progress; status-only notifies are not.
      if (queue !== lastQueue) {
        lastQueue = queue;
        armStall();
      }
    });
    armStall();
  });
}

/**
 * Resolves once every queued write has settled — or, with `exceptWorkspaceId`,
 * once no queued write needs a DIFFERENT workspace's renderer session (the
 * admission gate: `openWorkspace` revokes the previous workspace's session,
 * so that workspace's accepted writes must land first; the new workspace's
 * own writes settle fine after admission).
 */
export function settleCollectionFieldWrites(
  exceptWorkspaceId?: string,
  options?: { stallMs?: number },
): Promise<CollectionWriteSettleReport> {
  return settleWrites(
    (entry) =>
      exceptWorkspaceId === undefined ||
      entry.workspaceId !== exceptWorkspaceId,
    options,
  );
}

export type CollectionWriteOperationGuard = {
  // Resolves once no queued write targets the workspace; `failed` counts its
  // retained failures at that point, old and new. The caller reads it before
  // mutating paths.
  settled: Promise<CollectionWriteSettleReport>;
  // Resumes accepting the workspace's cell edits. Idempotent.
  release: () => void;
};

/**
 * Pauses new edits while queued edits settle before a path or version change.
 * Hold the pause through the operation and path projection, then release it.
 */
export function beginCollectionWriteOperation(
  workspaceId: string,
  options?: { stallMs?: number },
): CollectionWriteOperationGuard {
  pausedWorkspaces.set(workspaceId, (pausedWorkspaces.get(workspaceId) ?? 0) + 1);
  notify();
  let released = false;
  return {
    settled: settleWrites((entry) => entry.workspaceId === workspaceId, options),
    release: () => {
      if (released) return;
      released = true;
      const count = pausedWorkspaces.get(workspaceId) ?? 0;
      if (count <= 1) pausedWorkspaces.delete(workspaceId);
      else pausedWorkspaces.set(workspaceId, count - 1);
      notify();
    },
  };
}

/** True while an operation guard pauses the workspace's cell edits. */
export function collectionWritesPaused(workspaceId: string): boolean {
  return pausedWorkspaces.has(workspaceId);
}

/** The pause as page state: CollectionPage disables its cells and says why. */
export function useCollectionWritesPaused(workspaceId: string): boolean {
  return useSyncExternalStore(subscribe, () =>
    collectionWritesPaused(workspaceId),
  );
}

/** One collection's write status: the page's error line and settle count. */
export function useCollectionWriteStatus(
  workspaceId: string,
  collectionPath: string,
): CollectionWriteStatus {
  return useSyncExternalStore(
    subscribe,
    () => statuses.get(keyFor(workspaceId, collectionPath)) ?? EMPTY_STATUS,
  );
}

// Test seam: the queue is module state, so suites that enqueue writes reset
// it between tests instead of leaking a pending head into each other.
export function resetCollectionFieldWritesForTests(): void {
  queue = [];
  failures = [];
  statuses.clear();
  pausedWorkspaces.clear();
  workspaceLineages.clear();
  schemaMutations.clear();
  schemaPreparations.clear();
  nextWriteId = 0;
  appliedWrite = null;
  notify();
}

// Retry preserves the accepted value and waits until file operations finish.
function CollectionWriteFailureRow({
  failure,
}: {
  failure: CollectionWriteFailure;
}) {
  const paused = useCollectionWritesPaused(failure.workspaceId);
  const lineage = useCollectionWriteLineage(failure.workspaceId);
  const stale = failure.lineage !== lineage;
  const recoverOnly = stale || failure.superseded || failure.recoveryOnly;
  const [copyState, setCopyState] = useState<string | null>(null);
  const value = failure.change.value;
  const recoveryText = typeof value === "string"
    ? value
    : JSON.stringify(value, (_key, entry: unknown) =>
        typeof entry === "bigint" ? entry.toString() : entry, 2);
  const file =
    failure.change.recordPath.split("/").at(-1) ?? failure.change.recordPath;
  return (
    <div
      data-testid="collection-write-failure"
      className="flex flex-col gap-1.5 border-t border-line pt-2 first:border-t-0 first:pt-0"
    >
      <span className="truncate font-mono text-[11px] text-subtle">
        {failure.change.field} in {file}
      </span>
      <span className="text-[12px] text-ink">
        {stale ? STALE_LINEAGE_MESSAGE : failure.superseded ? SUPERSEDED_MESSAGE : failure.message}
      </span>
      <textarea
        aria-label="Unsaved collection value"
        readOnly
        value={recoveryText}
        className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink"
      />
      <span className="text-[12px] text-muted">
        Discard removes the input kept here. You cannot undo this.
      </span>
      <div className="flex gap-1.5">
        <SecondaryButton
          data-testid="collection-write-retry"
          className="disabled:opacity-50"
          disabled={paused || recoverOnly}
          onClick={() => retryCollectionFieldWrite(failure.id)}
        >
          Retry
        </SecondaryButton>
        <SecondaryButton
          data-testid="collection-write-copy"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(recoveryText))
              .then(() => setCopyState("Copied"))
              .catch(() => setCopyState("Could not copy. Select the value above to copy it."));
          }}
        >
          Copy value
        </SecondaryButton>
        <SecondaryButton
          data-testid="collection-write-discard"
          onClick={() => discardCollectionFieldWrite(failure.id)}
        >
          Discard unsaved change
        </SecondaryButton>
      </div>
      {copyState ? <span className="text-[12px] text-muted">{copyState}</span> : null}
    </div>
  );
}

/**
 * Mount once above keyed views and the error boundary. Writes and recovery
 * controls must survive navigation and shell crashes.
 */
export function CollectionFieldWriteHost() {
  const head = useSyncExternalStore(subscribe, () => queue[0] ?? null);
  const retained = useCollectionWriteFailures();
  const saveUnconfirmed = useSyncExternalStore(subscribe, () => appliedWrite?.stalled ?? false);
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {retained.length > 0
          ? retained.length === 1
            ? "1 unsaved collection change needs attention."
            : `${retained.length} unsaved collection changes need attention.`
          : saveUnconfirmed ? SAVE_UNCONFIRMED_MESSAGE : ""}
      </span>
      {head === null ? null : (
        <CollectionRecordFieldWrite
          key={head.id}
          workspaceId={head.workspaceId}
          collectionPath={head.collectionPath}
          change={head.change}
          createOption={head.createOption}
          onPrepared={() => completeCollectionFieldWritePreparation(head.id)}
          onPreparationStarted={(controller) => {
            schemaPreparations.set(head.id, controller);
            return () => {
              if (schemaPreparations.get(head.id) === controller) {
                schemaPreparations.delete(head.id);
              }
            };
          }}
          onMutationStarted={() => retainSchemaMutation(head.workspaceId)}
          onApplied={() => {
            if (queue[0]?.id === head.id) {
              appliedWrite = { id: head.id, durableMessage: null, stalled: false };
            }
          }}
          onDurabilityConfirmed={(message) => {
            if (appliedWrite?.id !== head.id) return;
            appliedWrite.durableMessage = message;
            if (appliedWrite.stalled) holdCollectionFieldWriteDurably(head.id, message);
          }}
          onSettled={() => completeCollectionFieldWrite(head.id)}
          onHeldDurably={(message) =>
            holdCollectionFieldWriteDurably(head.id, message)
          }
          onFailed={(message, recoveryOnly) => failCollectionFieldWrite(head.id, message, recoveryOnly)}
        />
      )}
      {retained.length === 0 && !saveUnconfirmed ? null : (
        <div
          data-testid="collection-write-failures"
          className="dohc-popover fixed bottom-3 right-3 z-50 flex max-h-80 w-80 flex-col gap-2 overflow-auto rounded-xl border border-line bg-panel p-3"
        >
          <span className="text-sm font-semibold text-ink">
            {retained.length > 0 ? "Unsaved collection changes" : "Saving collection changes"}
          </span>
          {saveUnconfirmed ? (
            <span data-testid="collection-save-unconfirmed" className="text-[12px] text-ink">
              {SAVE_UNCONFIRMED_MESSAGE}
            </span>
          ) : null}
          {retained.map((failure) => (
            <CollectionWriteFailureRow key={failure.id} failure={failure} />
          ))}
        </div>
      )}
    </>
  );
}
