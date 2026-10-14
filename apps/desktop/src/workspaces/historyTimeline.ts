import { isWorkspaceUpdatingRefusal } from "@dohc/workspace-engine-client";
import type { DatasetHistoryPage } from "@dohc/cli/dataset";
import { TimelineCursor as CursorSchema, type TimelineCursor, type TimelineEntry, type ListHistoryPayload, type ListHistoryResult } from "../ipc/bridgeContract";
import { engineMomentForIpc, type EngineMomentAuthorNames } from "../ipc/engineHistoryIpc";
import type { WorkspaceEngineCapture, WorkspaceEngineMomentPage } from "./workspaceEngineCapture";

export const HISTORY_REMOTE_DEADLINE_MS = 750;
const PAGE_LIMIT = 50;
const PAGE_BYTES = 256 * 1024;
type CollectionPage = DatasetHistoryPage & { name?: string };
export interface HistoryHeads {
  transferred: string[];
  pages: Array<CollectionPage & { name: string; lineage: string }>;
}
export interface TimelineReads {
  scope: string;
  signal: AbortSignal;
  assertCurrent(): void;
  engine: Pick<WorkspaceEngineCapture, "listMoments">;
  local(positions?: Array<{ datasetId: string; beforeRevision: number }>, limit?: number): Promise<HistoryHeads> | HistoryHeads;
  remote(datasetId: string, beforeRevision: number | undefined, signal: AbortSignal): Promise<CollectionPage>;
  names: EngineMomentAuthorNames;
  admitted?(path: string): boolean;
}
class Deadline extends Error {}
async function bounded<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Deadline()), HISTORY_REMOTE_DEADLINE_MS);
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([work(controller.signal), stopped]); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onAbort); }
}
const time = (row: TimelineEntry) => row.kind === "file" ? row.moment.recordedAtMs : row.kind === "version" ? row.version.createdAtMs : row.sortAtMs;
const kind = (row: TimelineEntry) => row.kind === "file" ? row.moment.protected ? 1 : 0 : row.kind === "version" ? 2 : 3;
const id = (row: TimelineEntry) => row.kind === "file" ? "" : row.kind === "version" ? row.version.id : row.datasetId;
const position = (row: TimelineEntry) => row.kind === "file" ? row.moment.momentOrder : row.kind === "collection" ? row.change.revision : 0;
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  const at = time(a), bt = time(b);
  if (at !== bt) return at === null ? 1 : bt === null ? -1 : bt - at;
  const identity = id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
  return kind(a) - kind(b) || (a.kind === "version" ? -identity : identity) || position(b) - position(a);
}

/** Canonical source positions live in the cursor. Prefetch is disposable acceleration. */
export function createHistoryTimeline() {
  const prefetch = new Map<string, Promise<CollectionPage>>();
  const key = (reads: TimelineReads, datasetId: string, before: number | undefined) => JSON.stringify([reads.scope, datasetId, before]);
  function remotePage(reads: TimelineReads, datasetId: string, before: number | undefined) {
    const cacheKey = key(reads, datasetId, before), saved = prefetch.get(cacheKey);
    prefetch.delete(cacheKey);
    return bounded(reads.signal, signal => saved ?? reads.remote(datasetId, before, signal));
  }
  function ahead(reads: TimelineReads, page: CollectionPage) {
    if (page.nextBeforeRevision === null) return;
    const cacheKey = key(reads, page.datasetId, page.nextBeforeRevision);
    if (prefetch.has(cacheKey)) return;
    const pending = bounded(reads.signal, signal => reads.remote(page.datasetId, page.nextBeforeRevision!, signal));
    // Rejections remain visible when this source needs the page, without an unhandled rejection.
    void pending.catch(() => {});
    prefetch.set(cacheKey, pending);
    if (prefetch.size > 512) prefetch.delete(prefetch.keys().next().value!);
  }
  return async function listHistory(input: ListHistoryPayload, reads: TimelineReads): Promise<ListHistoryResult> {
    const current = () => { reads.signal.throwIfAborted(); reads.assertCurrent(); };
    current();
    const requestedObject = input.object ?? null;
    let cursor = input.cursor ? structuredClone(CursorSchema.parse(input.cursor)) : null;
    if (cursor && (cursor.workspaceId !== input.workspaceId || cursor.versionId !== (input.versionId ?? cursor.versionId) || JSON.stringify(cursor.object) !== JSON.stringify(requestedObject))) throw new Error("History cursor scope changed. Refresh History.");
    const engineRows: TimelineEntry[] = [];
    const engineState: { page: WorkspaceEngineMomentPage | null } = { page: null };
    const readEngine = async () => {
      current();
      engineState.page = await reads.engine.listMoments({ limit: PAGE_LIMIT, ...(input.versionId ? { versionId: input.versionId } : {}),
        ...(requestedObject?.kind === "file" ? { objectId: requestedObject.objectId } : {}), ...(cursor?.engine ? { cursor: cursor.engine } : {}) });
      current();
      reads.names.prepare?.(engineState.page.moments.flatMap(m => m.authors ?? []));
      engineRows.push(...engineState.page.moments.map(moment => ({ kind: "file" as const, moment: engineMomentForIpc(moment, reads.names) })),
        ...engineState.page.versionMarkers.map(version => ({ kind: "version" as const, version })));
      engineRows.sort(compareTimelineEntries);
      return engineState.page;
    };
    let initialEngine: WorkspaceEngineMomentPage | null = null;
    try {
      if (requestedObject?.kind !== "dataset" && !cursor?.engineDone) initialEngine = await readEngine();
    } catch (error) { current(); if (isWorkspaceUpdatingRefusal(error)) return { status: "updating" }; throw error; }
    cursor ??= { format: 1, workspaceId: input.workspaceId, versionId: initialEngine?.startCursor.versionId ?? input.versionId ?? "main", object: requestedObject,
      engine: initialEngine?.startCursor ?? null, engineDone: requestedObject?.kind === "dataset", collections: [] };
    const state = cursor;
    if (initialEngine) state.engine = initialEngine.startCursor;
    const includeCollections = state.versionId === "main" && requestedObject?.kind !== "file";
    const local = includeCollections ? await reads.local(input.cursor ? state.collections.filter(s => !s.remote && !s.done && !s.excluded).map(s => ({ datasetId: s.datasetId, beforeRevision: s.beforeRevision })) : undefined, 1) : { transferred: [], pages: [] };
    current();
    const pages = new Map<string, CollectionPage>(local.pages.map(p => [p.datasetId, p]));
    if (!input.cursor && includeCollections) {
      const ids = [...new Set([...local.pages.map(p => p.datasetId), ...local.transferred])].sort();
      for (const datasetId of ids) {
        if (requestedObject?.kind === "dataset" && requestedObject.datasetId !== datasetId) continue;
        const p = pages.get(datasetId);
        state.collections.push({ datasetId, remote: local.transferred.includes(datasetId), fenceRevision: p?.headRevision ?? 0,
          beforeRevision: p ? p.headRevision + 1 : Number.MAX_SAFE_INTEGER, lineage: p?.lineage ?? null,
          timeHint: p?.olderRecordedAtMs ?? null, done: false, excluded: null });
      }
    }
    const fetchRemote = async (source: TimelineCursor["collections"][number], before: number | undefined) => {
      try {
        const page = await remotePage(reads, source.datasetId, before); current();
        if (page.archived) { source.done = true; pages.delete(source.datasetId); return; }
        if (!page.lineage) throw new Error("Collection history lineage is unavailable.");
        if (source.lineage !== null && page.lineage !== source.lineage) throw new Error("History lineage changed. Refresh History.");
        if (source.lineage === null) { source.lineage = page.lineage; source.fenceRevision = page.headRevision; source.beforeRevision = page.headRevision + 1; source.timeHint = page.olderRecordedAtMs ?? null; }
        pages.set(source.datasetId, { ...page, entries: [...page.entries] }); ahead(reads, page);
      } catch (error) {
        current();
        if (error instanceof Error && error.message === "History lineage changed. Refresh History.") throw error;
        source.excluded = error instanceof Deadline ? "deadline" : "unavailable";
        pages.delete(source.datasetId);
      }
    };
    await Promise.all(state.collections.filter(s => s.remote && !s.done && !s.excluded).map(s => fetchRemote(s, input.cursor ? s.beforeRevision : undefined)));
    current();
    for (const source of state.collections) {
      const page = pages.get(source.datasetId);
      if (source.done || source.excluded) continue;
      if (!page) { source.done = true; continue; }
      if (page.lineage !== source.lineage || page.headRevision < source.fenceRevision) throw new Error("History lineage changed. Refresh History.");
      if (!source.remote && local.transferred.includes(source.datasetId)) { source.excluded = "unavailable"; pages.delete(source.datasetId); }
    }
    // Only sources that can enter this page need more than their metadata head.
    const windowHeads: TimelineEntry[] = engineRows.filter(row => row.kind !== "file" || row.moment.protected || !reads.admitted || reads.admitted(row.moment.path));
    const localHeads = new Map<string, TimelineEntry>();
    for (const source of state.collections) {
      const page = pages.get(source.datasetId), change = page?.entries[0];
      if (source.done || source.excluded || !change) continue;
      const { undo: _, ...summary } = change;
      const head: TimelineEntry = { kind: "collection", datasetId: source.datasetId, name: page!.name ?? source.datasetId,
        sortAtMs: change.recordedAtMs ?? source.timeHint ?? page?.olderRecordedAtMs ?? null, change: summary };
      windowHeads.push(head);
      if (!source.remote) localHeads.set(source.datasetId, head);
    }
    windowHeads.sort(compareTimelineEntries);
    const boundary = windowHeads[(input.limit ?? PAGE_LIMIT) - 1];
    const needed = state.collections.filter(s => localHeads.has(s.datasetId) && (!boundary || compareTimelineEntries(localHeads.get(s.datasetId)!, boundary) <= 0));
    if (needed.length) {
      const expanded = await reads.local(needed.map(s => ({ datasetId: s.datasetId, beforeRevision: s.beforeRevision })), PAGE_LIMIT + 1);
      current();
      for (const source of needed) {
        const page = expanded.pages.find(p => p.datasetId === source.datasetId);
        if (!page) { source.done = true; pages.delete(source.datasetId); continue; }
        if (page.lineage !== source.lineage || page.headRevision < source.fenceRevision) throw new Error("History lineage changed. Refresh History.");
        pages.set(source.datasetId, page);
      }
    }
    const entries: TimelineEntry[] = [];
    // Reserve the cursor, missing-source disclosure, and bounded position growth.
    let bytes = Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(state.collections.filter(s => s.excluded !== null).map(s => ({ datasetId: s.datasetId, reason: s.excluded })))) + 2048;
    const advanceEngine = (row: TimelineEntry) => {
      if (!state.engine) throw new Error("History engine cursor is unavailable.");
      if (row.kind === "file") state.engine[row.moment.protected ? "protected" : "text"] = { recordedAtMs: row.moment.recordedAtMs, momentOrder: row.moment.momentOrder };
      else if (row.kind === "version") state.engine.marker = { createdAtMs: row.version.createdAtMs, versionId: row.version.id };
      engineRows.shift();
    };
    let scannedEnginePages = 0;
    while (entries.length < (input.limit ?? PAGE_LIMIT)) {
      current();
      if (!state.engineDone && !engineRows.length && engineState.page) {
        if (engineState.page.nextCursor === null) state.engineDone = true;
        else {
          state.engine = engineState.page.nextCursor;
          if (++scannedEnginePages > 40) break;
          await readEngine();
          continue;
        }
      }
      const candidates: TimelineEntry[] = engineRows.length ? [engineRows[0]!] : [];
      for (const source of state.collections) {
        if (source.done || source.excluded) continue;
        let page = pages.get(source.datasetId);
        if (!page) continue;
        if (!page.entries.length && page.nextBeforeRevision !== null) {
          if (source.remote) { await fetchRemote(source, source.beforeRevision); page = pages.get(source.datasetId); }
          else {
            const refill = await reads.local([{ datasetId: source.datasetId, beforeRevision: source.beforeRevision }], PAGE_LIMIT + 1);
            current(); page = refill.pages.find(p => p.datasetId === source.datasetId);
            if (page && (page.lineage !== source.lineage || page.headRevision < source.fenceRevision)) throw new Error("History lineage changed. Refresh History.");
            if (page) pages.set(source.datasetId, page); else pages.delete(source.datasetId);
          }
        }
        const change = page?.entries[0];
        if (!change) { if (!source.excluded) source.done = true; continue; }
        if (change.revision > source.fenceRevision || change.revision >= source.beforeRevision) throw new Error("Collection history position changed. Refresh History.");
        const { undo: _, ...summary } = change;
        candidates.push({ kind: "collection", datasetId: source.datasetId, name: page!.name ?? source.datasetId, sortAtMs: change.recordedAtMs ?? source.timeHint ?? page?.olderRecordedAtMs ?? null, change: summary });
      }
      candidates.sort(compareTimelineEntries);
      const row = candidates[0];
      if (!row) break;
      if (row.kind === "file" && !row.moment.protected && reads.admitted && !reads.admitted(row.moment.path)) { advanceEngine(row); continue; }
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > PAGE_BYTES) {
        if (!entries.length) throw new Error("History summary exceeds the page byte limit.");
        break;
      }
      entries.push(row); bytes += size;
      if (row.kind === "collection") {
        const source = state.collections.find(s => s.datasetId === row.datasetId)!;
        source.beforeRevision = row.change.revision; source.timeHint = row.sortAtMs;
        const page = pages.get(row.datasetId)!; page.entries.shift();
        if (!page.entries.length && page.nextBeforeRevision === null) source.done = true;
      } else advanceEngine(row);
    }
    if (!engineRows.length && engineState.page?.nextCursor === null) state.engineDone = true;
    current();
    const unavailableSources = state.collections.filter(s => s.excluded !== null).map(s => ({ datasetId: s.datasetId, reason: s.excluded! }));
    return { status: "ready", workspaceId: state.workspaceId, versionId: state.versionId, entries,
      nextCursor: state.engineDone && state.collections.every(s => s.done || s.excluded) ? null : state,
      unavailableSources, completeness: unavailableSources.length ? "partial" : "complete" };
  };
}
