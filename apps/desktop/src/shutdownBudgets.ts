// Bounds a silent renderer's acknowledgement, never the user's decision.
export const QUIT_ASK_TIMEOUT_MS = 3_000;
export const BUILD_HARD_KILL_GRACE_MS = 5_000;
// Covers site-preview grace and the hard-kill round trip.
export const WILL_QUIT_BUDGET_MS = BUILD_HARD_KILL_GRACE_MS + 1_000;
