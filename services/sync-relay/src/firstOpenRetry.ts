import {type FirstOpenOutcome, type FirstOpenSourceIdentity, type FirstOpenTemporaryStop} from "@dohc/workspace-contracts/first-open";

const documentKey = (source: {workspaceId: string; objectId: string}) => JSON.stringify([source.workspaceId, source.objectId]);
const sourceKey = (source: FirstOpenSourceIdentity) => JSON.stringify([source.workspaceId, source.objectId, source.sourceMomentId, source.sourceDigest]);
const sameSource = (a: FirstOpenSourceIdentity, b: FirstOpenSourceIdentity) => sourceKey(a) === sourceKey(b) && a.path === b.path;
interface RetryState {
  readonly source: FirstOpenSourceIdentity;
  deadlineAnswers: number;
  failures: number;
  retryAtMs: number;
  // When the relay builds this source again after its last build deadline. A request before then answers the same deadline without building.
  relayWaitUntilMs: number;
  stop?: FirstOpenTemporaryStop;
  token: object;
  abort?: AbortController;
}

/**
 * Retries, one state per document. The caller supplies monotonic time, asks
 * again once `next` falls due, cancels requests when their target leaves, and
 * forgets the document once it goes live or leaves this host.
 */
export class FirstOpenRetry {
  readonly #states = new Map<string, RetryState>();
  readonly #flights = new Set<string>();
  readonly #now: () => number;
  readonly #random: () => number;
  constructor(options: {nowMs?: () => number; random?: () => number} = {}) {
    this.#now = options.nowMs ?? (() => performance.now());
    this.#random = options.random ?? Math.random;
  }

  state(source: FirstOpenSourceIdentity) {
    const state = this.#states.get(documentKey(source));
    if (!state || !sameSource(state.source, source)) return undefined;
    return {deadlineAnswers: state.deadlineAnswers, retryAtMs: state.retryAtMs, stop: state.stop, inFlight: this.#flights.has(sourceKey(source))};
  }

  /** Whether the document's source stopped after repeated build deadlines, so a caller reads its current source only then. */
  stopped(document: {workspaceId: string; objectId: string}): boolean {return this.#states.get(documentKey(document))?.stop !== undefined;}

  /** The earliest time after now at which a source with no request running may be asked about again, or undefined while none waits for one. */
  next(): number | undefined {
    const now = this.#now();
    let next: number | undefined;
    for (const state of this.#states.values()) {
      if (state.retryAtMs <= now || state.retryAtMs === Infinity || this.#flights.has(sourceKey(state.source))) continue;
      if (next === undefined || state.retryAtMs < next) next = state.retryAtMs;
    }
    return next;
  }

  /**
   * Starts a new attempt sequence, as Try again does. The first request
   * waits for the relay's own wait after its last build deadline, so it builds
   * rather than answering that deadline again.
   */
  retry(document: {workspaceId: string; objectId: string}): boolean {
    const state = this.#states.get(documentKey(document));
    if (!state) return false;
    state.token = {};
    state.abort?.abort();
    state.deadlineAnswers = 0;
    state.failures = 0;
    state.retryAtMs = Math.max(this.#now(), state.relayWaitUntilMs);
    state.stop = undefined;
    return true;
  }

  forget(document: {workspaceId: string; objectId: string}) {
    const key = documentKey(document);
    this.#states.get(key)?.abort?.abort();
    this.#states.delete(key);
  }

  async attempt(source: FirstOpenSourceIdentity, request: (signal: AbortSignal) => Promise<FirstOpenOutcome>, callerSignal?: AbortSignal): Promise<FirstOpenOutcome | undefined> {
    callerSignal?.throwIfAborted();
    const key = documentKey(source), flight = sourceKey(source);
    let state = this.#states.get(key);
    if (!state || !sameSource(state.source, source)) {
      state?.abort?.abort();
      state = {source: Object.freeze({...source}), deadlineAnswers: 0, failures: 0, retryAtMs: this.#now(), relayWaitUntilMs: -Infinity, token: {}};
      this.#states.set(key, state);
    }
    if (state.stop || this.#now() < state.retryAtMs || this.#flights.has(flight)) return undefined;
    const current = state, token = current.token, abort = new AbortController();
    const signal = callerSignal ? AbortSignal.any([abort.signal, callerSignal]) : abort.signal;
    current.abort = abort;
    this.#flights.add(flight);
    const isCurrent = () => this.#states.get(key) === current && current.token === token;
    try {
      const outcome = await request(signal);
      if (!isCurrent()) return undefined;
      signal.throwIfAborted();
      if (!sameSource(outcome.source, current.source)) throw new Error("First-open response names another source.");
      if (outcome.kind !== "unavailable" || outcome.reason === "build-deadline") current.failures = 0;
      if (outcome.kind === "unavailable") {
        if (outcome.reason === "build-deadline") {
          current.deadlineAnswers++;
          current.relayWaitUntilMs = this.#now() + outcome.retryAfterMs;
          if (current.deadlineAnswers >= 3) {
            current.stop = {source: current.source, reason: "retry-stopped", code: "build-deadline", deadlineAnswers: 3, recovery: "retry-later"};
            current.retryAtMs = Infinity;
          } else {
            current.retryAtMs = this.#now() + Math.max(this.#delay(60_000 * 2 ** (current.deadlineAnswers - 1)), outcome.retryAfterMs);
          }
        } else current.retryAtMs = this.#now() + this.#failureDelay(current);
        // A stale source holds nothing: should the relay's history come back to this source, asking about it again may start it.
      } else current.retryAtMs = outcome.recovery === "pull-current-source" ? this.#now() : Infinity;
      return outcome;
    } catch (error) {
      if (!isCurrent()) return undefined;
      current.retryAtMs = this.#now() + this.#failureDelay(current);
      throw error;
    } finally {
      this.#flights.delete(flight);
      if (current.abort === abort) current.abort = undefined;
    }
  }

  #failureDelay(state: RetryState) {
    state.failures = Math.min(state.failures + 1, 10);
    return Math.min(300_000, this.#delay(1_000 * 2 ** (state.failures - 1)));
  }

  #delay(minimumMs: number) {return Math.ceil(minimumMs * (1 + Math.max(0, Math.min(1, this.#random())) / 2));}
}
