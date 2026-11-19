import { serverLogLine } from "./serverLogWords";

/**
 * Failures of the live host that an open can meet, by their whole message. Each is a fixed sentence in this
 * service, so the server log may show it. Any other failure shows as `serverLogLine` has it.
 */
const KNOWN_FAILURES: ReadonlySet<string> = new Set([
  "Service document activation is incomplete.",
  "An owner delivery already holds this document.",
  "Service owner registration changed.",
  "Service owner adoption changed.",
  "Service owner activation changed.",
  "Service owner binding changed.",
  "Service owner workspace changed.",
  "Live host registration is unavailable.",
  "Named live host is unavailable.",
  "The live host changed.",
  "Workspace is not configured on this service host.",
  "Named frame sync is not configured on this service host.",
]);

/**
 * A ticket that could not be minted. It keeps the server log's words for the cause and never the cause itself,
 * whose message can hold a token or a key.
 */
export class LiveTicketFailure extends Error {
  readonly words: string;
  constructor(cause: unknown) {
    super("Live-ticket operation failed.");
    this.words = liveOpenFailureWords(cause);
  }
}

/** The server log's words for what an open threw: its own sentence when it is a known failure, or its class. */
export function liveOpenFailureWords(error: unknown): string {
  if (error instanceof LiveTicketFailure) return error.words;
  return error instanceof Error && KNOWN_FAILURES.has(error.message)
    ? error.message
    : serverLogLine(error);
}

/**
 * Says in the server log why a page that may edit a note was told to try again. The page gets the same answer
 * whatever the reason, so without this line nothing tells a host that is still starting from one that is failing.
 * Each reason is written at most once a minute, with how many times it applied since it was last written.
 */
export function createLiveOpenRefusalLog(
  log: (line: string) => void = (line) => console.error(line),
  now: () => number = Date.now,
) {
  const shown = new Map<string, { atMs: number; since: number }>();
  return (reason: string): void => {
    const state = shown.get(reason) ?? { atMs: -Infinity, since: 0 };
    shown.set(reason, state);
    state.since++;
    if (now() - state.atMs < 60_000) return;
    try {
      log(`[sync-relay] live open told to try again: ${reason} (${String(state.since)}x)`);
    } catch {
      /* Reporting must not change the answer. */
    }
    state.atMs = now();
    state.since = 0;
  };
}
