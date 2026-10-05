import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { join } from 'node:path';

async function capture(session, record, signal, now, startedAtMs, createStream) {
  record.status = 'capturing';
  record.startedElapsedMs = now() - startedAtMs;
  const stream = createStream(record.partialFile, { flags: 'wx' });
  const closed = finished(stream, { cleanup: true });
  void closed.catch(() => {});
  const onAbort = () => stream.destroy(signal.reason);
  const onChunk = ({ chunk }) => {
    if (stream.destroyed) return;
    record.bytes += Buffer.byteLength(chunk);
    record.chunks++;
    stream.write(chunk);
  };
  session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    await Promise.race([session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }), closed]);
    signal.throwIfAborted();
    if (!record.bytes) throw Error('Renderer heap snapshot was empty');
    stream.end();
    await closed;
    signal.throwIfAborted();
    await rename(record.partialFile, record.file);
    record.status = 'complete';
    record.completedElapsedMs = now() - startedAtMs;
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    signal.removeEventListener('abort', onAbort);
    if (!stream.destroyed) {
      if (signal.aborted) stream.destroy(signal.reason);
      else stream.end();
    }
    await closed.catch(() => {});
  }
}

// Timers enqueue diagnostics independently of the soak's measured cycle loop.
export async function startRendererHeapSnapshots({ session, output, minutes, signal,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout, createStream = createWriteStream }) {
  try {
    signal?.throwIfAborted();
    await session.send('HeapProfiler.enable');
    signal?.throwIfAborted();
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
  const startedAtMs = now(), abort = new AbortController(), timers = new Map();
  const records = minutes.map(minute => {
    const file = join(output, 'renderer-heap-' + minute + 'm.heapsnapshot');
    return { minute, file, partialFile: file + '.partial', status: 'scheduled', bytes: 0, chunks: 0 };
  });
  let queue = Promise.resolve(), failure, stopped = false, disposed = false, completion;
  const stopScheduling = reason => {
    stopped = true;
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    for (const record of records) if (['scheduled', 'queued'].includes(record.status)) {
      record.status = 'cancelled'; record.error = reason.message;
    }
  };
  const onAbort = () => {
    failure ??= signal.reason;
    stopScheduling(failure);
    abort.abort(failure);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const enqueue = record => {
    if (stopped || record.status !== 'scheduled') return;
    clearTimer(timers.get(record)); timers.delete(record);
    record.status = 'queued'; record.requestedElapsedMs = now() - startedAtMs;
    queue = queue.then(async () => {
      if (record.status !== 'queued') return;
      try { await capture(session, record, abort.signal, now, startedAtMs, createStream); }
      catch (error) {
        record.status = abort.signal.aborted ? 'cancelled' : 'failed';
        record.error = error.message; record.completedElapsedMs = now() - startedAtMs;
        failure ??= error;
        stopScheduling(failure);
      }
    });
  };
  for (const record of records) timers.set(record, setTimer(() => enqueue(record), record.minute * 60000));
  const finish = () => {
    if (completion) return completion;
    // A final-minute timer may be due but still waiting for its event-loop turn.
    for (const record of records) if (record.minute * 60000 <= now() - startedAtMs) enqueue(record);
    for (const timer of timers.values()) clearTimer(timer);
    timers.clear();
    stopped = true;
    completion = (async () => {
      await queue;
      for (const record of records) if (record.status === 'scheduled') {
        record.status = 'cancelled';
        record.error = 'Soak ended before the requested heap snapshot minute';
        failure ??= Error(record.error);
      }
      signal?.removeEventListener('abort', onAbort);
      try { await session.detach(); } catch (error) { failure ??= error; }
      disposed = true;
      if (failure) throw failure;
      return records;
    })();
    return completion;
  };
  return { records, startedAtMs, finish,
    throwIfFailed() { if (failure) throw failure; },
    cancel(reason) {
      if (!disposed) {
        failure ??= reason;
        stopScheduling(reason);
        abort.abort(reason);
      }
      return finish();
    } };
}
