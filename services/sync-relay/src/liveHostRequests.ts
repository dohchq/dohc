import {EngineRequestDeadlineError, type EngineClient} from "@dohc/workspace-engine-client/daemon";

type Kind = "read" | "write";
type Pending = {kind: Kind; start(): void; cancel(reason: unknown): void};

/** Backing byte allocations plus an upper bound for JSON metadata; not a heap estimate. */
function retainedInputCharge(values: unknown[], maximum: number) {
  let bytes = 0;
  const buffers = new Set<ArrayBufferLike>(), parents = new Set<object>();
  const add = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > maximum - bytes) throw new Error("Native request retained input capacity is full.");
    bytes += count;
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError("Native request input is too deep.");
    if (value === null || value === undefined) {add(4); return;}
    if (typeof value === "boolean") {add(5); return;}
    if (typeof value === "number") {add(24); return;}
    // JSON can use six ASCII bytes for each escaped UTF-16 code unit.
    if (typeof value === "string") {add(6 * value.length + 2); return;}
    if (value instanceof Uint8Array) {
      if (!buffers.has(value.buffer)) {add(value.buffer.byteLength); buffers.add(value.buffer);}
      return;
    }
    if (typeof value !== "object" || parents.has(value)) throw new TypeError("Invalid native request input.");
    parents.add(value); add(2);
    if (Array.isArray(value)) {
      add(value.length); for (const child of value) visit(child, depth + 1);
    } else for (const key in value) if (Object.hasOwn(value, key)) {add(6 * key.length + 4); visit((value as Record<string, unknown>)[key], depth + 1);}
    parents.delete(value);
  };
  visit(values, 0); return bytes;
}

/** One native RPC at a time. Callers keep borrowed inputs unchanged until completion. */
export function queueLiveHostRequests(client: EngineClient, options: {
  maxPendingReads: number; maxPendingWrites: number; maxRetainedInputBytes: number;
  deadlineMs: number; signal: AbortSignal; retire(): void;
}): EngineClient {
  for (const value of [options.maxPendingReads, options.maxPendingWrites, options.deadlineMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new TypeError("Invalid native request queue bound.");
  }
  if (!Number.isSafeInteger(options.maxRetainedInputBytes) || options.maxRetainedInputBytes < 1) throw new TypeError("Invalid native input retention bound.");
  const pending: Record<Kind, Pending[]> = {read: [], write: []};
  let active = false, previous: Kind = "read", retainedBytes = 0;
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

  function run(kind: Kind, caller: AbortSignal | undefined, input: unknown[], work: () => Promise<unknown>) {
    return new Promise((resolve, reject) => {
      if (caller?.aborted || options.signal.aborted) {reject(caller?.reason ?? options.signal.reason); return;}
      const queue = pending[kind], limit = kind === "read" ? options.maxPendingReads : options.maxPendingWrites;
      if (queue.length >= limit) {reject(new Error("Native request queue capacity is full.")); return;}
      const charge = retainedInputCharge(input, options.maxRetainedInputBytes - retainedBytes);
      retainedBytes += charge;
      let released = false;
      const releaseInput = () => {if (!released) {released = true; retainedBytes -= charge;}};
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => {clearTimeout(timer); caller?.removeEventListener("abort", aborted);};
      const entry: Pending = {
        kind,
        cancel(reason) {const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); clean(); releaseInput(); reject(reason);},
        start() {
          clean();
          // Keep the caller's input reservation until the real response settles.
          // Forwarding cancellation here could free the local slot before the peer.
          void (async () => {
            try {
              const value = await work();
              options.signal.throwIfAborted(); caller?.throwIfAborted(); resolve(value);
            } catch (error) {
              if (error instanceof EngineRequestDeadlineError) options.retire();
              reject(error);
            } finally {releaseInput(); active = false; pump();}
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
  const signals = {sendRequest: 1, sendLiveBootstrap: 2, sendLiveApplication: 2, sendLiveOwnerAdoption: 3, captureOwnerActivation: 3,
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
      return run(kind, caller, args.slice(0, index), () => method(...args));
    };
    methods.set(property, wrapped); return wrapped;
  }});
}
