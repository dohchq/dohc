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

// The soak calls captureDue only after a complete mixed cycle.
export async function startRendererHeapSnapshots({ session, output, minutes, signal,
  now = () => performance.now(), createStream = createWriteStream }) {
  try {
    signal?.throwIfAborted();
    await session.send('HeapProfiler.enable');
    signal?.throwIfAborted();
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
  const startedAtMs = now(), abort = new AbortController();
  const records = minutes.map(minute => {
    const file = join(output, 'renderer-heap-' + minute + 'm.heapsnapshot');
    return { minute, file, partialFile: file + '.partial', status: 'scheduled', bytes: 0, chunks: 0 };
  });
  let queue = Promise.resolve(), failure, stopped = false, disposed = false, completion, lastBoundary;
  const stopScheduling = reason => {
    stopped = true;
    for (const record of records) if (record.status === 'scheduled') {
      record.status = 'cancelled'; record.error = reason.message;
    }
  };
  const onAbort = () => {
    failure ??= signal.reason;
    stopScheduling(failure);
    abort.abort(failure);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const captureDue = cycle => {
    if (stopped) return Promise.reject(failure ?? Error('Heap capture has finished'));
    lastBoundary = cycle;
    queue = queue.then(async () => {
      for (const record of records) {
        if (record.status !== 'scheduled' || record.minute * 60000 > now() - startedAtMs) continue;
        record.cycle = cycle;
        record.requestedElapsedMs = now() - startedAtMs;
        const pauseStarted = now();
        try { await capture(session, record, abort.signal, now, startedAtMs, createStream); }
        catch (error) {
          record.status = abort.signal.aborted ? 'cancelled' : 'failed';
          record.error = error.message; record.completedElapsedMs = now() - startedAtMs;
          failure ??= error;
          stopScheduling(failure);
        } finally { record.pauseMs = now() - pauseStarted; }
      }
    });
    return queue.then(() => { if (failure) throw failure; });
  };
  const finish = () => {
    if (completion) return completion;
    // Bookkeeping can cross a due minute after the last completed cycle.
    if (!stopped && lastBoundary !== undefined) void captureDue(lastBoundary).catch(() => {});
    stopped = true;
    completion = (async () => {
      await queue;
      for (const record of records) if (record.status === 'scheduled') {
        record.status = 'cancelled';
        record.error = 'Soak ended before the requested heap snapshot boundary';
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
  return { records, startedAtMs, captureDue, finish,
    cancel(reason) {
      if (!disposed) {
        failure ??= reason;
        stopScheduling(reason);
        abort.abort(reason);
      }
      return finish();
    } };
}
