import {EngineRequestDeadlineError, type EngineClient} from "@dohc/workspace-engine-client/daemon";

type Kind = "read" | "write";
type Pending = {kind: Kind; start(): void; cancel(reason: unknown): void};

/** One native RPC at a time; document work releases this lane between requests. */
export function queueLiveHostRequests(client: EngineClient, options: {
  maxPendingReads: number; maxPendingWrites: number; deadlineMs: number; signal: AbortSignal; retire(): void;
}): EngineClient {
  for (const value of [options.maxPendingReads, options.maxPendingWrites, options.deadlineMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError("Invalid native request queue bound.");
  }
  const pending: Record<Kind, Pending[]> = {read: [], write: []};
  let active = false, previous: Kind = "read";
  function pump() {
    if (active || options.signal.aborted) return;
    const preferred = previous === "read" ? "write" : "read";
    const next = pending[preferred].shift() ?? pending[previous].shift();
    if (next) {active = true; previous = next.kind; next.start();}
  }
  const stopped = () => {
    for (const queue of Object.values(pending)) for (const entry of queue.splice(0)) entry.cancel(options.signal.reason);
  };
  options.signal.addEventListener("abort", stopped, {once: true});

  function run(kind: Kind, caller: AbortSignal | undefined, work: () => Promise<unknown>) {
    return new Promise((resolve, reject) => {
      if (caller?.aborted || options.signal.aborted) {reject(caller?.reason ?? options.signal.reason); return;}
      const queue = pending[kind], limit = kind === "read" ? options.maxPendingReads : options.maxPendingWrites;
      if (queue.length >= limit) {reject(new Error("Native request queue capacity is full.")); return;}
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => {clearTimeout(timer); caller?.removeEventListener("abort", aborted);};
      const entry: Pending = {
        kind,
        cancel(reason) {const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); clean(); reject(reason);},
        start() {
          clean();
          // An active caller borrows its inputs until the real response settles.
          // Forwarding cancellation here could free the local slot before the peer.
          void (async () => {
            try {
              const value = await work();
              options.signal.throwIfAborted(); caller?.throwIfAborted(); resolve(value);
            } catch (error) {
              if (error instanceof EngineRequestDeadlineError) options.retire();
              reject(error);
            } finally {active = false; pump();}
          })();
        },
      };
      const aborted = () => entry.cancel(caller!.reason);
      caller?.addEventListener("abort", aborted, {once: true});
      timer = setTimeout(() => entry.cancel(new Error("Native request queue deadline exceeded.")), options.deadlineMs);
      queue.push(entry); pump();
    });
  }

  // Bind every operation to the original client. Internal RPC calls cannot enter
  // this queue again while their outer operation owns its only active slot.
  const signals = {sendRequest: 1, sendLiveBootstrap: 2, sendLiveApplication: 2, sendLiveOwnerAdoption: 3,
    sendLiveRestore: 4, openLiveAppliedSync: 3, readNextLiveApplied: 3, readLiveApplicationAck: 2} as const satisfies Partial<Record<keyof EngineClient, number>>;
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {get(target, property) {
    if (methods.has(property)) return methods.get(property);
    const value: unknown = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    const method = value.bind(target) as (...args: unknown[]) => Promise<unknown>;
    const index = Object.hasOwn(signals, property) ? signals[property as keyof typeof signals] : undefined;
    const wrapped = index === undefined ? method : (...args: unknown[]) => {
      const caller = args[index] as AbortSignal | undefined;
      args[index] = options.signal;
      const kind = property === "openLiveAppliedSync" || property === "readNextLiveApplied" ? "read" : "write";
      return run(kind, caller, () => method(...args));
    };
    methods.set(property, wrapped); return wrapped;
  }});
}
