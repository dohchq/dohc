import { serverLogLine } from "./serverLogWords";

const FIXED_LIVE_HOST_SENTENCES: ReadonlySet<string> = new Set([
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

/** A ticket that could not be minted. It keeps the server log's words for its cause and nothing else of it. */
export class LiveTicketFailure extends Error {
  readonly words: string;
  constructor(cause: unknown) {
    super("Live-ticket operation failed.");
    this.words = liveOpenFailureWords(cause);
  }
}

/** A failed open's words for the server log: its message when that is a fixed live host sentence, else `serverLogLine`. */
export function liveOpenFailureWords(error: unknown): string {
  if (error instanceof LiveTicketFailure) return error.words;
  return error instanceof Error && FIXED_LIVE_HOST_SENTENCES.has(error.message)
    ? error.message
    : serverLogLine(error);
}

/** Returns a function that writes each reason to the server log at most once a minute, with its count since the last line. */
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
    const count = state.since;
    state.atMs = now();
    state.since = 0;
    try {
      log(`[sync-relay] live open told to try again: ${reason} (${String(count)}x)`);
    } catch {
      return;
    }
  };
}
