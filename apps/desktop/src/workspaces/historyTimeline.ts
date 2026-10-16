import { RELAY_FETCH_TIMEOUT_MS } from "./sharedChannels";
import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import type { DatasetHistoryPage } from "@dohc/cli/dataset";
import { HISTORY_MAX_SOURCES, HISTORY_CURSOR_BYTES, TimelineCursor as CursorSchema, type TimelineCursor, type TimelineEntry, type ListHistoryPayload, type ListHistoryResult } from "../ipc/bridgeContract";
import { engineMomentForIpc, type EngineMomentAuthorNames } from "../ipc/engineHistoryIpc";
import type { WorkspaceEngineCapture, WorkspaceEngineMomentPage } from "./workspaceEngineCapture";

export const HISTORY_REMOTE_DEADLINE_MS = 750;
export const HISTORY_REMOTE_CONCURRENCY = 4;
const PAGE_LIMIT = 50;
const PAGE_BYTES = 256 * 1024;
type CollectionPage = DatasetHistoryPage & { deleted?: boolean };
type Source = TimelineCursor["collections"][number];
export interface HistoryHeads {
  transferred: string[];
  sourceIds: string[];
  sourceCount: number;
  pages: Array<CollectionPage & { name: string; lineage: string }>;
}
export interface TimelineReads {
  scope: string;
  signal: AbortSignal;
  assertCurrent(): void;
  engine: Pick<WorkspaceEngineCapture, "listMoments">;
  local(positions?: Array<{ datasetId: string; beforeRevision: number }>, limit?: number, sourceIds?: string[]): Promise<HistoryHeads> | HistoryHeads;
  // Each call owns its authority operation, including background reads after a page returns.
  remote(datasetId: string, beforeRevision: number | undefined, signal: AbortSignal): Promise<CollectionPage>;
  names: EngineMomentAuthorNames;
  admitted?(path: string): boolean;
}
class Deadline extends Error {}
class LineageChanged extends Error {
  constructor() { super("History lineage changed. Refresh History."); }
}
async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, timeoutMs = HISTORY_REMOTE_DEADLINE_MS): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Deadline()), timeoutMs);
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(controller.signal), stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onAbort); }
}
type Order = { time: number | null; kind: number; id: string; position: number };
function order(row: TimelineEntry): Order {
  if (row.kind === "file") return { time: row.moment.recordedAtMs, kind: row.moment.protected ? 1 : 0, id: "", position: row.moment.momentOrder };
  if (row.kind === "version") return { time: row.version.createdAtMs, kind: 2, id: row.version.id, position: 0 };
  return { time: row.sortAtMs, kind: 3, id: row.datasetId, position: row.change.revision };
}
function compare(a: Order, b: Order): number {
  if (a.time !== b.time) return a.time === null ? 1 : b.time === null ? -1 : b.time - a.time;
  const identity = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.kind - b.kind || (a.kind === 2 ? -identity : identity) || b.position - a.position;
}
export const compareTimelineEntries = (a: TimelineEntry, b: TimelineEntry) => compare(order(a), order(b));
function sourceOrder(source: Source): Order | null {
  return source.head && { time: source.head.sortAtMs, kind: 3, id: source.datasetId, position: source.head.revision };
}
function collectionEntry(source: Source, page: CollectionPage): TimelineEntry | null {
  const change = page.entries[0];
  if (!change) return null;
  const { undo: _, ...summary } = change;
  return { kind: "collection", datasetId: source.datasetId, name: page.name ?? source.datasetId,
    sortAtMs: change.recordedAtMs ?? source.timeHint ?? page.olderRecordedAtMs ?? null, change: summary };
}
function setHead(source: Source, page: CollectionPage) {
  const row = collectionEntry(source, page);
  source.head = row?.kind === "collection" ? { revision: row.change.revision, sortAtMs: row.sortAtMs } : null;
  if (!row && page.nextBeforeRevision === null) source.done = true;
}
function checkLineage(source: Source, page: CollectionPage) {
  if (page.lineage !== source.lineage || page.headRevision < source.fenceRevision) throw new LineageChanged();
}

/** Cursor positions are canonical. Bounded caches only accelerate the same read. */
export function createHistoryTimeline() {
  type Prefetch = { promise: Promise<CollectionPage>; controller: AbortController; started: boolean };
  const prefetch = new Map<string, Prefetch>();
  type Waiter = { background: boolean; grant(): void };
  const queues = new Map<string, { active: number; background: number; waiting: Waiter[] }>();
  async function slot(scope: string, signal: AbortSignal, background: boolean) {
    signal.throwIfAborted();
    let queue = queues.get(scope);
    if (!queue) { queue = { active: 0, background: 0, waiting: [] }; queues.set(scope, queue); }
    const state = queue;
    const drain = () => {
      while (state.active < HISTORY_REMOTE_CONCURRENCY) {
        const foreground = state.waiting.findIndex(w => !w.background);
        const index = foreground >= 0 ? foreground : state.background < 1 ? 0 : -1;
        if (index < 0 || !state.waiting.length) break;
        state.waiting.splice(index, 1)[0]!.grant();
      }
      if (!state.active && !state.waiting.length) queues.delete(scope);
    };
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { background, grant() {
        signal.removeEventListener("abort", abort);
        state.active++; if (background) state.background++;
        resolve();
      } };
      const abort = () => {
        const index = state.waiting.indexOf(waiter);
        if (index >= 0) state.waiting.splice(index, 1);
        reject(signal.reason); drain();
      };
      state.waiting.push(waiter); signal.addEventListener("abort", abort, { once: true }); drain();
    });
    return () => { state.active--; if (background) state.background--; drain(); };
  }
  async function remoteRead(reads: TimelineReads, datasetId: string, before: number | undefined, signal: AbortSignal, background?: Prefetch, queueSignal = signal) {
    const release = await slot(reads.scope, queueSignal, !!background);
    try {
      signal.throwIfAborted();
      if (background) background.started = true;
      // A source gets its full deadline only after it can send its request.
      return await bounded(signal, signal => reads.remote(datasetId, before, signal), background ? RELAY_FETCH_TIMEOUT_MS : HISTORY_REMOTE_DEADLINE_MS);
    } finally { release(); }
  }
  const key = (reads: TimelineReads, id: string, before: number | undefined) => JSON.stringify([reads.scope, id, before]);
  async function remotePage(reads: TimelineReads, id: string, before: number | undefined, queueSignal: AbortSignal) {
    const cacheKey = key(reads, id, before), saved = prefetch.get(cacheKey);
    prefetch.delete(cacheKey);
    if (!saved) return remoteRead(reads, id, before, reads.signal, undefined, queueSignal);
    if (!saved.started) {
      // Promote queued work instead of waiting behind background reads.
      saved.controller.abort();
      return remoteRead(reads, id, before, reads.signal, undefined, queueSignal);
    }
    return bounded(reads.signal, async signal => {
      const abort = () => saved.controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        try { return await saved.promise; }
        catch {
          signal.throwIfAborted();
          // Idle transport failures are retried once while this page waits.
          return await remoteRead(reads, id, before, signal, undefined, AbortSignal.any([signal, queueSignal]));
        }
      } finally { signal.removeEventListener("abort", abort); }
    });
  }
  function ahead(reads: TimelineReads, source: Source, page: CollectionPage, consumed: boolean) {
    const cacheKey = key(reads, source.datasetId, source.beforeRevision);
    if (prefetch.has(cacheKey)) return;
    const controller = new AbortController();
    const saved: Prefetch = { controller, started: !consumed, promise: Promise.resolve(page) };
    if (consumed) saved.promise = remoteRead(reads, source.datasetId, source.beforeRevision, controller.signal, saved);
    void saved.promise.catch(() => {});
    prefetch.set(cacheKey, saved);
    if (prefetch.size > HISTORY_MAX_SOURCES) {
      const oldest = prefetch.keys().next().value!;
      prefetch.get(oldest)!.controller.abort(); prefetch.delete(oldest);
    }
  }
  async function page(input: ListHistoryPayload, reads: TimelineReads): Promise<ListHistoryResult> {
    const current = () => { reads.signal.throwIfAborted(); reads.assertCurrent(); };
    current();
    const requestedObject = input.object ?? null, limit = input.limit ?? PAGE_LIMIT;
    let cursor = input.cursor ? structuredClone(CursorSchema.parse(input.cursor)) : null;
    if (cursor && (cursor.workspaceId !== input.workspaceId || input.versionId !== undefined && cursor.versionId !== input.versionId || JSON.stringify(cursor.object) !== JSON.stringify(requestedObject))) throw new Error("History cursor scope changed. Refresh History.");
    const engineRows: TimelineEntry[] = [];
    const engineState: { page: WorkspaceEngineMomentPage | null } = { page: null };
    let scannedEnginePages = 0;
    const readEngine = async () => {
      current(); scannedEnginePages++;
      engineState.page = await reads.engine.listMoments({ limit: PAGE_LIMIT, ...(input.versionId ? { versionId: input.versionId } : {}),
        ...(requestedObject?.kind === "file" ? { objectId: requestedObject.objectId } : {}), ...(cursor?.engine ? { cursor: structuredClone(cursor.engine) } : {}) });
      current();
      reads.names.prepare?.(engineState.page.moments.flatMap(m => m.authors ?? []));
      engineRows.push(...engineState.page.moments.map(moment => ({ kind: "file" as const, moment: engineMomentForIpc(moment, reads.names) })),
        ...engineState.page.versionMarkers.map(version => ({ kind: "version" as const, version })));
      engineRows.sort(compareTimelineEntries);
      return engineState.page;
    };
    const initialEngine = requestedObject?.kind !== "dataset" && !cursor?.engineDone ? await readEngine() : null;
    cursor ??= { format: 1, workspaceId: input.workspaceId, versionId: initialEngine?.startCursor.versionId ?? input.versionId ?? "main", object: requestedObject,
      engine: initialEngine?.startCursor ?? null, engineDone: requestedObject?.kind === "dataset", collections: [], omittedSources: 0 };
    const state = cursor;
    if (initialEngine) { state.engine = structuredClone(initialEngine.startCursor); if (state.versionId !== state.engine.versionId) throw new Error("History cursor scope changed. Refresh History."); }
    const includeCollections = state.versionId === "main" && requestedObject?.kind !== "file";
    const live = () => state.collections.filter(source => !source.done && !source.excluded);
    const boundary = () => [...engineRows.filter(row => row.kind !== "file" || row.moment.protected || !reads.admitted || reads.admitted(row.moment.path)).map(order),
      ...live().flatMap(source => sourceOrder(source) ?? [])].sort(compare)[limit - 1];
    const canEnter = (source: Source, edge: Order | undefined) => !edge || !source.head || compare(sourceOrder(source)!, edge) <= 0;
    const edge = boundary();
    const selected = live().filter(source => !source.remote && canEnter(source, edge));
    const positions = input.cursor ? selected.map(source => ({ datasetId: source.datasetId, beforeRevision: source.beforeRevision }))
      : requestedObject?.kind === "dataset" ? [{ datasetId: requestedObject.datasetId, beforeRevision: Number.MAX_SAFE_INTEGER }] : undefined;
    const local = includeCollections ? await reads.local(positions, 1, input.cursor ? state.collections.map(source => source.datasetId) : requestedObject?.kind === "dataset" ? [requestedObject.datasetId] : undefined) : { transferred: [], sourceIds: [], sourceCount: 0, pages: [] };
    current();
    const pages = new Map<string, CollectionPage>(local.pages.map(p => [p.datasetId, { ...p, entries: [...p.entries] }]));
    if (!input.cursor && includeCollections) {
      const ids = [...new Set(local.sourceIds)].filter(id => requestedObject?.kind !== "dataset" || requestedObject.datasetId === id);
      state.omittedSources = requestedObject?.kind === "dataset" ? 0 : Math.max(0, local.sourceCount - HISTORY_MAX_SOURCES);
      for (const datasetId of ids.slice(0, HISTORY_MAX_SOURCES)) {
        const p = pages.get(datasetId);
        const source: Source = { datasetId, remote: local.transferred.includes(datasetId), fenceRevision: p?.headRevision ?? 0,
          beforeRevision: p ? p.headRevision + 1 : Number.MAX_SAFE_INTEGER, lineage: p?.lineage ?? null,
          timeHint: p?.olderRecordedAtMs ?? null, head: null, done: false, excluded: null };
        if (p) setHead(source, p);
        state.collections.push(source);
      }
    }
    function acceptLocal(sources: Source[], result: HistoryHeads) {
      for (const source of sources) {
        if (result.transferred.includes(source.datasetId)) { source.excluded = "unavailable"; pages.delete(source.datasetId); continue; }
        const p = result.pages.find(p => p.datasetId === source.datasetId);
        if (!p) { source.done = true; pages.delete(source.datasetId); continue; }
        checkLineage(source, p); pages.set(source.datasetId, { ...p, entries: [...p.entries] }); setHead(source, p);
      }
    }
    for (const source of live()) if (!source.remote && local.transferred.includes(source.datasetId)) { source.excluded = "unavailable"; pages.delete(source.datasetId); }
    if (input.cursor) acceptLocal(selected.filter(s => !s.excluded), local);
    const pageDeadline = new AbortController();
    const queueSignal = AbortSignal.any([reads.signal, pageDeadline.signal]);
    const fetchRemote = async (source: Source, before: number | undefined) => {
      try {
        const p = await remotePage(reads, source.datasetId, before, queueSignal); current();
        if (p.archived || p.deleted) { source.done = true; pages.delete(source.datasetId); return; }
        if (!p.lineage) throw new Error("Collection history lineage is unavailable.");
        if (source.lineage === null) { source.lineage = p.lineage; source.fenceRevision = p.headRevision; source.beforeRevision = p.headRevision + 1; source.timeHint = p.olderRecordedAtMs ?? null; }
        checkLineage(source, p); pages.set(source.datasetId, { ...p, entries: [...p.entries] }); setHead(source, p);
      } catch (error) {
        current(); if (error instanceof LineageChanged) throw error;
        // Stop this page's queued reads; active reads keep their per-slot deadline.
        if (error instanceof Deadline) pageDeadline.abort(error);
        source.excluded = error instanceof Deadline ? "deadline" : "unavailable"; pages.delete(source.datasetId);
      }
    };
    const remoteEdge = boundary();
    await Promise.all(live().filter(source => source.remote && canEnter(source, remoteEdge)).map(source => fetchRemote(source, input.cursor ? source.beforeRevision : undefined)));
    current();
    const localEdge = boundary();
    const needed = live().filter(source => !source.remote && pages.has(source.datasetId) && canEnter(source, localEdge));
    if (needed.length) {
      const expanded = await reads.local(needed.map(source => ({ datasetId: source.datasetId, beforeRevision: source.beforeRevision })), PAGE_LIMIT + 1, state.collections.map(source => source.datasetId));
      current(); acceptLocal(needed, expanded);
    }
    const refill = async (source: Source) => {
      if (source.remote) await fetchRemote(source, source.beforeRevision);
      else {
        const result = await reads.local([{ datasetId: source.datasetId, beforeRevision: source.beforeRevision }], PAGE_LIMIT + 1, state.collections.map(s => s.datasetId));
        current(); acceptLocal([source], result);
      }
    };
    const consumed = new Set<string>();
    const entries: TimelineEntry[] = [];
    const cursorBytes = Math.min(HISTORY_CURSOR_BYTES, Buffer.byteLength(JSON.stringify(state)) + state.collections.length * 128);
    let bytes = cursorBytes + state.collections.length * 96 + 2048;
    const advanceEngine = (row: TimelineEntry) => {
      if (!state.engine) throw new Error("History engine cursor is unavailable.");
      if (row.kind === "file") state.engine[row.moment.protected ? "protected" : "text"] = { recordedAtMs: row.moment.recordedAtMs, momentOrder: row.moment.momentOrder };
      else if (row.kind === "version") state.engine.marker = { createdAtMs: row.version.createdAtMs, versionId: row.version.id };
      engineRows.shift();
    };
    while (entries.length < limit) {
      current();
      if (!state.engineDone && !engineRows.length && engineState.page) {
        if (engineState.page.nextCursor === null) state.engineDone = true;
        else {
          state.engine = engineState.page.nextCursor;
          if (scannedEnginePages >= 40) break;
          await readEngine(); continue;
        }
      }
      for (const source of live().filter(source => !source.head)) await refill(source);
      const heads = live().flatMap(source => { const order = sourceOrder(source); return order ? [{ source, order }] : []; });
      heads.sort((a, b) => compare(a.order, b.order));
      const winner = heads[0];
      let row = engineRows[0];
      if (winner && (!row || compare(winner.order, order(row)) < 0)) {
        const source = winner.source;
        let p = pages.get(source.datasetId);
        if (!p?.entries.length) {
          await refill(source);
          continue;
        }
        row = collectionEntry(source, p)!;
        if (row.kind === "collection" && (row.change.revision > source.fenceRevision || row.change.revision >= source.beforeRevision)) throw new Error("Collection history position changed. Refresh History.");
      }
      if (!row) break;
      if (row.kind === "file" && !row.moment.protected && reads.admitted && !reads.admitted(row.moment.path)) { advanceEngine(row); continue; }
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > PAGE_BYTES) { if (!entries.length) throw new Error("History summary exceeds the page byte limit."); break; }
      entries.push(row); bytes += size;
      if (row.kind === "collection") {
        const source = winner!.source;
        source.beforeRevision = row.change.revision; source.timeHint = row.sortAtMs;
        const p = pages.get(row.datasetId)!; p.entries.shift(); setHead(source, p); consumed.add(source.datasetId);
      } else advanceEngine(row);
    }
    if (!engineRows.length && engineState.page?.nextCursor === null) state.engineDone = true;
    state.collections = state.collections.filter(source => !source.done);
    current(); CursorSchema.parse(state);
    for (const source of live().filter(source => source.remote)) {
      const p = pages.get(source.datasetId);
      if (p) ahead(reads, source, p, consumed.has(source.datasetId));
    }
    const unavailableSources = state.collections.filter(s => s.excluded !== null).map(s => ({ datasetId: s.datasetId, reason: s.excluded! }));
    return { status: "ready", workspaceId: state.workspaceId, versionId: state.versionId, entries,
      nextCursor: state.engineDone && state.collections.every(s => s.excluded) ? null : state,
      unavailableSources, omittedSources: state.omittedSources, completeness: unavailableSources.length || state.omittedSources ? "partial" : "complete" };
  }
  return async (input: ListHistoryPayload, reads: TimelineReads): Promise<ListHistoryResult> => {
    try { return await page(input, reads); }
    catch (error) { reads.signal.throwIfAborted(); reads.assertCurrent(); if (isWorkspaceUpdatingRefusal(error)) return { status: "updating" }; throw error; }
  };
}
