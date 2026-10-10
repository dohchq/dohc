// One active write and one replaceable pending snapshot. Flushes sharing the
// pending slot wait for its newest snapshot, including its failure.
export function createTypingCheckpointWriter<T>(input: {
  write: (snapshot: T) => Promise<void>;
  writeSync?: (snapshot: T) => void;
  retire: () => Promise<void>;
  stored: (snapshot: T | null) => void;
}) {
  const completion = () => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((accept, refuse) => {resolve = accept; reject = refuse;});
    return {promise, resolve, reject};
  };
  type Write = {revision: number; snapshot: T | null; done: ReturnType<typeof completion>};
  let revision = 0;
  let syncRevision = 0;
  let active: Write | null = null;
  let pending: Write | null = null;
  let draining: Promise<void> = Promise.resolve();
  const drain = async () => {
    while (pending) {
      const write = pending;
      pending = null;
      active = write;
      try {
        if (write.snapshot === null) await input.retire();
        else await input.write(write.snapshot);
        if (write.revision > syncRevision) input.stored(write.snapshot);
        write.done.resolve();
      } catch (error) {
        write.done.reject(error);
      } finally {
        active = null;
      }
    }
  };
  return {
    flush(snapshot: T | null): Promise<void> {
      const nextRevision = ++revision;
      if (pending) {
        pending.revision = nextRevision;
        pending.snapshot = snapshot;
      } else {
        pending = {revision: nextRevision, snapshot, done: completion()};
      }
      const done = pending.done.promise;
      if (!active) draining = drain();
      return done;
    },
    flushSync(snapshot: T): void {
      if (!input.writeSync) throw new Error("Synchronous checkpoint writing is unavailable.");
      input.writeSync(snapshot);
      syncRevision = ++revision;
      input.stored(snapshot);
      active?.done.resolve();
      pending?.done.resolve();
      pending = null;
    },
    wait: (): Promise<void> => pending?.done.promise ?? active?.done.promise ?? Promise.resolve(),
    idle: (): Promise<void> => draining,
  };
}
