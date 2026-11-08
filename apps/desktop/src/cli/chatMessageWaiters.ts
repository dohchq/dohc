interface Batch { messages: readonly unknown[] }

export class ChatMessageWaiters {
  private readonly cancellations = new Set<() => void>();
  private closed = false;

  constructor(private readonly limit = 32) {}

  get size(): number { return this.cancellations.size; }

  wait<Result extends Batch>(input: {
    subscribe(listener: () => void): () => void;
    query(): Promise<Result>;
    empty: Result;
    timeoutMs: number;
    signal?: AbortSignal;
    refresh?(): void;
  }): Promise<Result> {
    if (this.closed) return Promise.reject(new Error("Chat waits are closed."));
    if (this.size >= this.limit) return Promise.reject(new Error("Too many chat waits. Finish an existing wait and try again."));
    if (input.signal?.aborted) return Promise.reject(new Error("Chat wait cancelled."));
    return new Promise<Result>((resolve, reject) => {
      let finished = false;
      let querying = false;
      let dirty = false;
      let empty = input.empty;
      let unsubscribe = () => {};
      const finish = (result?: Result, error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        input.signal?.removeEventListener("abort", cancel);
        this.cancellations.delete(cancel);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const cancel = () => finish(undefined, new Error("Chat wait cancelled."));
      const timer = input.timeoutMs === 0 ? undefined : setTimeout(() => finish(empty), input.timeoutMs);
      const query = async () => {
        dirty = true;
        if (querying || finished) return;
        querying = true;
        try {
          while (dirty && !finished) {
            dirty = false;
            const result = await input.query();
            if (result.messages.length > 0) finish(result);
            else {
              empty = result;
              if (input.timeoutMs === 0) finish(result);
            }
          }
        } catch (error) { finish(undefined, error); }
        finally { querying = false; }
      };
      this.cancellations.add(cancel);
      input.signal?.addEventListener("abort", cancel, { once: true });
      unsubscribe = input.subscribe(() => { void query(); });
      void query();
      input.refresh?.();
    });
  }

  close(): void {
    this.closed = true;
    for (const cancel of this.cancellations) cancel();
  }
}
