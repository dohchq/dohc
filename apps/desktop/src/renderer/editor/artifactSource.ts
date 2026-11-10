import * as Y from 'yjs';
import {canPreserveMarkdownSource} from '@dohc/ydoc-projection/artifact-markdown-guard';

let worker: Worker | null = null;
let nextId = 0;
// Documents that asked for a proof and are not yet destroyed. The worker
// stays while any is open, so a pause between edits does not restart it.
let openDocuments = 0;
const documents = new WeakMap<Y.Doc, {projection?: Promise<string>}>();
type Request = {doc: Y.Doc; snapshot: Uint8Array; resolve: (text: string) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>};
const requests = new Map<number, Request>();

function stop(error: Error): void {
  worker?.terminate();
  worker = null;
  for (const request of requests.values()) {clearTimeout(request.timer); request.reject(error);}
  requests.clear();
}

/** Drops the worker's current work and sends what still waits to a new one. */
function restart(): void {
  worker?.terminate(); worker = null;
  if (!requests.size) return;
  try {worker = startWorker(); for (const [id, request] of requests) send(id, request);}
  catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
}

/** A destroyed document's proof answers nobody, so no other document waits behind it. */
function closed(doc: Y.Doc): void {
  openDocuments--;
  let dropped = false;
  for (const [id, request] of requests) {
    if (request.doc !== doc) continue;
    requests.delete(id); clearTimeout(request.timer);
    request.reject(new Error('The document closed.'));
    dropped = true;
  }
  if (dropped || !openDocuments) restart();
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
  };
  return started;
}

function send(id: number, request: Request): void {
  clearTimeout(request.timer);
  request.timer = setTimeout(() => {
    requests.delete(id);
    request.reject(new Error('Source projection timed out.'));
    restart();
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
  if (doc.isDestroyed) return Promise.reject(new Error('The document closed.'));
  let document = documents.get(doc);
  if (document?.projection) return document.projection;
  worker ??= startWorker();
  if (document === undefined) {
    document = {}; documents.set(doc, document);
    const entry = document;
    const invalidate = () => {entry.projection = undefined;};
    doc.on('update', invalidate);
    openDocuments++;
    doc.once('destroy', () => {doc.off('update', invalidate); closed(doc);});
  }
  const id = ++nextId;
  const snapshot = Y.encodeStateAsUpdate(doc);
  const entry = document;
  const projection = new Promise<string>((resolve, reject) => {
    const request: Request = {doc, snapshot, resolve, reject};
    requests.set(id, request);
    try {send(id, request);}
    catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
  });
  entry.projection = projection;
  void projection.catch(() => {if (entry.projection === projection) entry.projection = undefined;});
  return projection;
}
