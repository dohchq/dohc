import * as Y from 'yjs';

let worker: Worker | null = null;
let nextId = 0;
const documents = new WeakMap<Y.Doc, {id: number; projection?: Promise<string>}>();
const requests = new Map<number, {resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>}>();

function stop(error: Error): void {
  worker?.terminate();
  worker = null;
  for (const request of requests.values()) {clearTimeout(request.timer); request.reject(error);}
  requests.clear();
}

/** Only the worker may decide whether a retained witness is fresh and verified. */
export function prepareArtifactSource(doc: Y.Doc): (() => void) | undefined {
  const meta = doc.getMap('meta');
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

/** A cold source proof must not parse a large outside file on the UI thread. */
export function projectArtifactSource(doc: Y.Doc): Promise<string> {
  let document = documents.get(doc);
  if (document?.projection) return document.projection;
  worker ??= new Worker(new URL('./artifactSource.worker.ts', import.meta.url), {type: 'module'});
  worker.onerror = () => stop(new Error('Source projection worker failed.'));
  worker.onmessage = ({data}: MessageEvent<{id: number; markdown: string; error?: string}>) => {
    const request = requests.get(data.id);
    if (!request) return;
    requests.delete(data.id); clearTimeout(request.timer);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.markdown);
  };
  if (document === undefined) {
    document = {id: ++nextId}; documents.set(doc, document);
    const entry = document;
    const invalidate = () => {entry.projection = undefined;};
    doc.on('update', invalidate);
    doc.once('destroy', () => {
      doc.off('update', invalidate);
      worker?.postMessage({document: entry.id});
    });
  }
  const id = ++nextId;
  const snapshot = Y.encodeStateAsUpdate(doc);
  const entry = document;
  const projection = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => stop(new Error('Source projection timed out.')), 15_000);
    requests.set(id, {resolve, reject, timer});
    try {worker!.postMessage({id, document: entry.id, snapshot}, [snapshot.buffer]);}
    catch (error) {stop(error instanceof Error ? error : new Error(String(error)));}
  });
  entry.projection = projection;
  void projection.catch(() => {if (entry.projection === projection) entry.projection = undefined;});
  return projection;
}
