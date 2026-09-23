interface ReadResource { close(): Promise<void> }
interface Entry<T extends ReadResource> { value: T; busy: boolean; used: number; timer?: ReturnType<typeof setTimeout> }

/** Host-wide replica reads get four workers, one request per worker, and finite idle lifetime. */
export function createReplicaReadPool<T extends ReadResource>(capacity = 4, idleMs = 60_000) {
  const entries = new Map<symbol, Entry<T>>();
  let pending: Promise<unknown> = Promise.resolve(), queued = 0;
  function enqueue<R>(run: () => Promise<R>): Promise<R> {
    const result = pending.then(run, run);
    pending = result.catch(() => {});
    return result;
  }
  async function remove(key: symbol): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.busy) throw Error("This Collection copy is still reading.");
    clearTimeout(entry.timer);
    await entry.value.close();
    entries.delete(key);
  }
  return {
    acquire(key: symbol, open: () => Promise<T>) {
      if (queued >= 64) return Promise.reject(Error("Collection copies are busy. Try again."));
      queued++;
      return enqueue(async () => {
        let entry = entries.get(key);
        if (entry?.busy) throw Error("This Collection copy is busy. Try again.");
        if (!entry) {
          if (entries.size >= capacity) {
            const idle = [...entries].filter(([, value]) => !value.busy).sort((a, b) => a[1].used - b[1].used)[0];
            if (!idle) throw Error("Collection copies are busy. Try again.");
            await remove(idle[0]);
          }
          entry = { value: await open(), busy: true, used: Date.now() };
          entries.set(key, entry);
        }
        clearTimeout(entry.timer);
        entry.busy = true;
        const captured = entry;
        let released = false;
        return { value: entry.value, release() {
          if (released) return;
          released = true; captured.busy = false; captured.used = Date.now();
          captured.timer = setTimeout(() => {
            void enqueue(async () => {
              if (entries.get(key) === captured && !captured.busy && Date.now() - captured.used >= idleMs) await remove(key);
            }).catch(() => {});
          }, idleMs);
          captured.timer.unref?.();
        } };
      }).finally(() => { queued--; });
    },
    invalidate(key: symbol) { return enqueue(() => remove(key)); },
  };
}
