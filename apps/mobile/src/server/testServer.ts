import type { Fetch } from "./client";
import type { SignInStore, StoredSignIn } from "./account";

// Tests only: a server whose answers each test scripts, and a token store in memory.

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
}

export type Answer = { readonly status: number; readonly body?: unknown } | "offline";
type Route = (call: Call) => Answer | Promise<Answer>;

export function testServer(origin = "https://dohc.example.com") {
  const routes = new Map<string, Route[]>();
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const path = url.slice(origin.length);
    const method = init.method ?? "GET";
    const headers = { ...(init.headers as Record<string, string> | undefined) };
    const call: Call = { method, path, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, signal: init.signal! };
    calls.push(call);
    const queue = routes.get(`${method} ${path}`);
    const route = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!route) return new Response(JSON.stringify({ ok: false, code: "not_found" }), { status: 404 });
    // A request aborts the moment its signal does, as a real fetch does.
    const answer = await Promise.race([
      Promise.resolve(route(call)),
      new Promise<never>((_, reject) => {
        if (call.signal.aborted) reject(new Error("aborted"));
        call.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    ]);
    if (answer === "offline") throw new TypeError("Network request failed");
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status });
  };
  return {
    origin,
    fetch,
    calls,
    /** Answers each listed request in turn, then repeats the last answer. */
    on(method: string, path: string, ...answers: (Answer | Route)[]) {
      routes.set(`${method} ${path}`, answers.map(answer => typeof answer === "function" ? answer : () => answer));
    },
    paths: () => calls.map(call => `${call.method} ${call.path}`),
  };
}

/** A promise the test settles. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

export function memoryStore(initial: StoredSignIn | null = null) {
  const log: string[] = [];
  let value = initial;
  let saving: Promise<void> | null = null;
  let loading: Promise<void> | null = null;
  let failingClears = 0;
  const store: SignInStore = {
    async load() { if (loading) await loading; return value; },
    async save(next) { log.push("save"); if (saving) await saving; value = next; },
    async clear() {
      log.push("clear");
      if (failingClears > 0) {
        failingClears -= 1;
        throw new Error("keychain refused the delete");
      }
      value = null;
    },
  };
  const hold = () => {
    const held = deferred<void>();
    return { promise: held.promise, release: () => held.resolve() };
  };
  return {
    store,
    log,
    current: () => value,
    /** Holds every save until the returned function runs. */
    holdSaves() {
      const held = hold();
      saving = held.promise;
      return held.release;
    },
    /** Holds every load until the returned function runs. */
    holdLoads() {
      const held = hold();
      loading = held.promise;
      return () => { loading = null; held.release(); };
    },
    /** The next `count` clears fail. */
    failClears(count: number) {
      failingClears = count;
    },
  };
}
