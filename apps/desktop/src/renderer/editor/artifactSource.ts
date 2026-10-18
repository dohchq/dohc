import * as Y from 'yjs';
import {canPreserveMarkdownSource} from '@dohc/ydoc-projection/artifact-markdown-guard';

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
const documents = new WeakMap<Y.Doc, {projection?: Promise<string>}>();
type Request = {snapshot: Uint8Array; resolve: (text: string) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>};
const requests = new Map<number, Request>();

function stop(error: Error): void {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const request of requests.values()) {clearTimeout(request.timer); request.reject(error);}
  requests.clear();
}

/** Only the worker may decide whether a retained witness is fresh and verified. */
export function prepareArtifactSource(doc: Y.Doc): (() => void) | undefined {
  const meta = doc.getMap('meta');
  if (!canPreserveMarkdownSource(meta.get('dohcMarkdownSource'))) return;
  if (!['dohcMarkdownSource', 'dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256']
    .every(key => typeof meta.get(key) === 'string')) return;
  let cancelled = false;
  const prepare = async () => {
    if (!cancelled && !doc.isDestroyed) await projectArtifactSource(doc);
  };
  const run = () => {void prepare().catch(() => {});};
  // Small proofs can wait for idle; large proofs overlap the editor's construction.
  if ((meta.get('dohcMarkdownSource') as string).length <= 64 * 1024
    && typeof requestIdleCallback === 'function') {
    const idle = requestIdleCallback(run);
    return () => {cancelled = true; cancelIdleCallback(idle);};
  }
  const timer = setTimeout(run, 0);
  return () => {cancelled = true; clearTimeout(timer);};
}

function startWorker(): Worker {
  const started = new Worker(new URL('./artifactSource.worker.ts', import.meta.url), {type: 'module'});
  started.onerror = () => {if (worker === started) stop(new Error('Source projection worker failed.'));};
  started.onmessage = ({data}: MessageEvent<{id: number; markdown: string; error?: string}>) => {
    if (worker !== started) return;
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id); clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.markdown);
    if (!requests.size) idleTimer = setTimeout(() => {worker?.terminate(); worker = null;}, 1000);
  };
  return started;
}

function send(id: number, request: Request): void {
  clearTimeout(idleTimer);
  clearTimeout(request.timer);
  request.timer = setTimeout(() => {
    requests.delete(id);
    request.reject(new Error('Source projection timed out.'));
    worker?.terminate(); worker = null;
    if (requests.size) {
      try {worker = startWorker(); for (const [otherId, other] of requests) send(otherId, other);}
      catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
    }
  }, 15_000);
  // Keep the original bytes until completion so another request's timeout can retry this one.
  const snapshot = request.snapshot.slice();
  worker!.postMessage({id, snapshot}, [snapshot.buffer]);
}

/** A cold source proof must not parse a large outside file on the UI thread. */
export function projectArtifactSource(doc: Y.Doc): Promise<string> {
  const meta = doc.getMap('meta');
  if (!canPreserveMarkdownSource(meta.get('dohcMarkdownSource'))
    || !['dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256'].every(key => typeof meta.get(key) === 'string')) {
    return import('./import-export').then(({yDocToMarkdown}) => yDocToMarkdown(doc));
  }
  let document = documents.get(doc);
  if (document?.projection) return document.projection;
  worker ??= startWorker();
  if (document === undefined) {
    document = {}; documents.set(doc, document);
    const entry = document;
    const invalidate = () => {entry.projection = undefined;};
    doc.on('update', invalidate);
    doc.once('destroy', () => {doc.off('update', invalidate);});
  }
  const id = ++nextId;
  const snapshot = Y.encodeStateAsUpdate(doc);
  const entry = document;
  const projection = new Promise<string>((resolve, reject) => {
    const request: Request = {snapshot, resolve, reject};
    requests.set(id, request);
    try {send(id, request);}
    catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
  });
  entry.projection = projection;
  void projection.catch(() => {if (entry.projection === projection) entry.projection = undefined;});
  return projection;
}
