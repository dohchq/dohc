import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import * as Y from 'yjs';
vi.mock('yjs', async original => {const actual = await original<typeof import('yjs')>(); return {...actual, encodeStateAsUpdate: vi.fn(actual.encodeStateAsUpdate)};});
function witnessedDoc() {const doc = new Y.Doc(); for (const key of ['dohcMarkdownSource','dohcMarkdownSourceSha256','dohcMarkdownSourceProjectionSha256']) doc.getMap('meta').set(key, 'plain'); return doc;}

class TestWorker {
  static instances: TestWorker[] = [];
  onerror: (() => void) | null = null;
  onmessage: ((message: {data: unknown}) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { TestWorker.instances.push(this); }
}
beforeEach(() => {
  vi.resetModules();
  TestWorker.instances = [];
  vi.stubGlobal('Worker', TestWorker);
});
afterEach(() => {vi.unstubAllGlobals(); vi.useRealTimers();});

it('transfers snapshots and correlates replies without release messages', async () => {
  const {projectArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc();
  const first = projectArtifactSource(doc);
  doc.getText('edit').insert(0, 'changed');
  const second = projectArtifactSource(doc);
  const [worker] = TestWorker.instances;
  expect(TestWorker.instances).toHaveLength(1);
  const [a, b] = worker!.postMessage.mock.calls.map(call => call[0]);
  expect(a).not.toHaveProperty('document');
  const clone = new Y.Doc();
  Y.applyUpdate(clone, a.snapshot);
  expect(worker!.postMessage.mock.calls[0]![1]).toEqual([a.snapshot.buffer]);
  worker!.onmessage!({data: {id: b.id, markdown: 'Latest'}});
  worker!.onmessage!({data: {id: a.id, markdown: 'First'}});
  expect(await first).toBe('First');
  expect(await second).toBe('Latest');
  expect(await projectArtifactSource(doc)).toBe('Latest');
  expect(worker!.postMessage).toHaveBeenCalledTimes(2);
  doc.destroy(); clone.destroy();
  expect(worker!.postMessage).toHaveBeenCalledTimes(2);
});

it('joins an idle proof, reuses its answer, and invalidates on every document update', async () => {
  const {projectArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc();
  const idle = projectArtifactSource(doc);
  const opening = projectArtifactSource(doc);
  const worker = TestWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  const request = worker.postMessage.mock.calls[0]![0];
  worker.onmessage!({data: {id: request.id, markdown: 'Verified'}});
  expect(await idle).toBe('Verified');
  expect(await opening).toBe('Verified');
  expect(await projectArtifactSource(doc)).toBe('Verified');
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  doc.getMap('meta').set('dohcMarkdownSource', 'forged');
  const changed = projectArtifactSource(doc);
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  const next = worker.postMessage.mock.calls[1]![0];
  worker.onmessage!({data: {id: next.id, markdown: 'Canonical'}});
  expect(await changed).toBe('Canonical');
  doc.destroy();
});

it('rejects pending requests on a worker failure and starts a fresh worker on retry', async () => {
  const {projectArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc();
  const pending = projectArtifactSource(doc);
  const refused = expect(pending).rejects.toThrow('Source projection worker failed');
  TestWorker.instances[0]!.onerror!();
  await refused;
  expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  const retry = projectArtifactSource(doc);
  const worker = TestWorker.instances[1]!;
  const request = worker.postMessage.mock.calls[0]![0];
  worker.onmessage!({data: {id: request.id, markdown: 'Retried'}});
  expect(await retry).toBe('Retried');
  doc.destroy();
});

it('bounds a worker that never responds', async () => {
  vi.useFakeTimers();
  const {projectArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc();
  const pending = projectArtifactSource(doc);
  const refused = expect(pending).rejects.toThrow('Source projection timed out');
  await vi.advanceTimersByTimeAsync(15_000);
  await refused;
  expect(TestWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
  doc.destroy();
});

it('defers only complete witnesses and cancels a departed document', async () => {
  vi.useFakeTimers();
  const {prepareArtifactSource} = await import('./artifactSource');
  const doc = new Y.Doc();
  prepareArtifactSource(doc);
  doc.getMap('meta').set('dohcMarkdownSource', 'source');
  prepareArtifactSource(doc);
  expect(vi.getTimerCount()).toBe(0);
  doc.getMap('meta').set('dohcMarkdownSourceSha256', 'hash');
  doc.getMap('meta').set('dohcMarkdownSourceProjectionSha256', 'hash');
  const cleanup = prepareArtifactSource(doc);
  expect(vi.getTimerCount()).toBe(1);
  expect(TestWorker.instances).toHaveLength(0);
  cleanup?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(TestWorker.instances).toHaveLength(0);
  doc.destroy();
});

it('runs the unchanged deferred proof, and a source opening joins it', async () => {
  vi.useFakeTimers();
  const {prepareArtifactSource, projectArtifactSource} = await import('./artifactSource');
  const doc = new Y.Doc();
  for (const key of ['dohcMarkdownSource', 'dohcMarkdownSourceSha256', 'dohcMarkdownSourceProjectionSha256']) doc.getMap('meta').set(key, 'value');
  prepareArtifactSource(doc);
  await vi.advanceTimersByTimeAsync(0);
  const opening = projectArtifactSource(doc);
  const worker = TestWorker.instances[0]!;
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  worker.onmessage!({data: {id: worker.postMessage.mock.calls[0]![0].id, markdown: 'verified'}});
  expect(await opening).toBe('verified');
  doc.destroy();
});

it('keeps short-note preparation off the opening task, with an inclusive idle boundary', async () => {
  vi.useFakeTimers();
  const idle = vi.fn().mockReturnValue(7);
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', idle);
  vi.stubGlobal('cancelIdleCallback', cancel);
  const {prepareArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc();
  const meta = doc.getMap('meta');
  meta.set('dohcMarkdownSource', 'x'.repeat(64 * 1024));
  meta.set('dohcMarkdownSourceSha256', 'hash');
  meta.set('dohcMarkdownSourceProjectionSha256', 'hash');
  const cleanup = prepareArtifactSource(doc);
  expect(idle).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  cleanup?.();
  expect(cancel).toHaveBeenCalledWith(7);
  meta.set('dohcMarkdownSource', 'x'.repeat(64 * 1024 + 1));
  const cancelLarge = prepareArtifactSource(doc);
  expect(idle).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  cancelLarge?.();
  doc.destroy();
});

it('restarts after one timeout and resends other pending snapshots',async()=>{
 vi.useFakeTimers();const {projectArtifactSource}=await import('./artifactSource');const a=witnessedDoc(),b=witnessedDoc();
 const first=projectArtifactSource(a);const refused=expect(first).rejects.toThrow('Source projection timed out');
 await vi.advanceTimersByTimeAsync(1000);const second=projectArtifactSource(b);const observed=second.catch(()=> 'unexpected refusal');
 const old=TestWorker.instances[0]!;const original=old.postMessage.mock.calls[1]![0];
 await vi.advanceTimersByTimeAsync(14000);await refused;expect(TestWorker.instances).toHaveLength(2);
 const replacement=TestWorker.instances[1]!;const resent=replacement.postMessage.mock.calls[0]![0];
 expect(resent.snapshot).toEqual(original.snapshot);replacement.onmessage!({data:{id:resent.id,markdown:'Survived'}});expect(await observed).toBe('Survived');a.destroy();b.destroy();
});

it.each(['plain < text', 'plain & text', '[x]: hidden'])('never snapshots or starts a worker for guarded source %s', async source => {
  vi.useFakeTimers(); const {prepareArtifactSource, projectArtifactSource} = await import('./artifactSource');
  const doc = witnessedDoc(); doc.getMap('meta').set('dohcMarkdownSource',source); vi.mocked(Y.encodeStateAsUpdate).mockClear();
  expect(prepareArtifactSource(doc)).toBeUndefined(); await projectArtifactSource(doc);
  expect(Y.encodeStateAsUpdate).not.toHaveBeenCalled(); expect(TestWorker.instances).toHaveLength(0); expect(vi.getTimerCount()).toBe(0); doc.destroy();
});
it('projects an unwitnessed document without a snapshot or worker', async () => {
  vi.useFakeTimers();
  const {projectArtifactSource} = await import('./artifactSource'); const doc = new Y.Doc(); vi.mocked(Y.encodeStateAsUpdate).mockClear();
  const output = projectArtifactSource(doc); expect(Y.encodeStateAsUpdate).not.toHaveBeenCalled(); expect(TestWorker.instances).toHaveLength(0); expect(await output).toBe(''); doc.destroy();
});
it('terminates a quiet worker and keeps the unchanged per-revision answer', async () => {
  vi.useFakeTimers(); const {projectArtifactSource} = await import('./artifactSource'); const doc = witnessedDoc();
  const pending = projectArtifactSource(doc); const worker = TestWorker.instances[0]!; worker.onmessage!({data:{id:worker.postMessage.mock.calls[0]![0].id,markdown:'Verified'}});
  expect(await pending).toBe('Verified'); await vi.advanceTimersByTimeAsync(999); expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(worker.terminate).toHaveBeenCalledOnce(); expect(await projectArtifactSource(doc)).toBe('Verified'); expect(TestWorker.instances).toHaveLength(1);
  doc.getMap('meta').set('edit','changed'); const changed = projectArtifactSource(doc); const next=TestWorker.instances[1]!;
  await vi.advanceTimersByTimeAsync(1000); expect(next.terminate).not.toHaveBeenCalled(); next.onmessage!({data:{id:next.postMessage.mock.calls[0]![0].id,markdown:'Changed'}}); expect(await changed).toBe('Changed'); doc.destroy();
});
it('cancels idle termination when another document needs a proof', async () => {
  vi.useFakeTimers(); const {projectArtifactSource} = await import('./artifactSource'); const a=witnessedDoc(), b=witnessedDoc();
  const first=projectArtifactSource(a),worker=TestWorker.instances[0]!; worker.onmessage!({data:{id:worker.postMessage.mock.calls[0]![0].id,markdown:'First'}}); await first;
  await vi.advanceTimersByTimeAsync(500); const second=projectArtifactSource(b); await vi.advanceTimersByTimeAsync(1000); expect(worker.terminate).not.toHaveBeenCalled();
  worker.onmessage!({data:{id:worker.postMessage.mock.calls[1]![0].id,markdown:'Second'}}); await second; await vi.advanceTimersByTimeAsync(1000); expect(worker.terminate).toHaveBeenCalledOnce(); a.destroy();b.destroy();
});
