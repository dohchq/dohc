// The self-hosted live host's capacity, and the limits of a held personal open.
// `liveHosting.perf.test.ts` measures the costs these bound.

/** Unretired enrollments the host keeps, across every workspace. */
export const SERVICE_HOST_MAX_DOCUMENTS = 64;
/** Workspaces with an unretired enrollment. */
export const SERVICE_HOST_MAX_WORKSPACES = 16;
/** Of those, the documents only an agent's demand keeps: no share covers them and their owner never asked. */
export const AGENT_ONLY_MAX_DOCUMENTS = 48;
/** Workspaces whose every unretired enrollment is agent-only. */
export const AGENT_ONLY_MAX_WORKSPACES = 12;
/** How long a document only recorded demand keeps stays idle before the sweep reclaims it. */
export const RECLAIM_RETENTION_MS = 10 * 60_000;
/** How long such a document stays idle before an open with no room may reclaim it. */
export const RECLAIM_MIN_HOLD_MS = 2 * 60_000;
/** How often the self-hosted live host sweeps for documents idle past retention. */
export const RECLAIM_SWEEP_MS = 60_000;
/** How long a personal open waits for its document to be ready. */
export const HELD_OPEN_MAX_MS = 20_000;
/** The longest a held open goes without its document being read again. */
export const HELD_OPEN_EVALUATE_MS = 250;
/** Held opens one agent may have at once. Past it, an open answers at once. */
export const HELD_OPEN_MAX_PER_AGENT = 4;
/** Held opens the relay keeps at once, for every agent. */
export const HELD_OPEN_MAX_WAITERS = 256;
