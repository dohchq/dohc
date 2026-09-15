/** Wait for the current bounded pass, then run against fresh document state. */
export class LiveDocumentWork {
  readonly #running = new Map<string, Promise<void>>();

  busy(key: string): boolean {return this.#running.has(key);}

  async run<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    for (;;) {
      const previous = this.#running.get(key);
      if (!previous) break;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {signal.removeEventListener("abort", abort); reject(signal.reason);};
        signal.addEventListener("abort", abort, {once: true});
        void previous.then(() => {signal.removeEventListener("abort", abort); resolve();});
      });
      signal.throwIfAborted();
    }
    let release!: () => void;
    this.#running.set(key, new Promise<void>(resolve => {release = resolve;}));
    try {return await work();}
    finally {this.#running.delete(key); release();}
  }
}
