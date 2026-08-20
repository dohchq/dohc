/**
 * How many net-changed files ONE share submit carries.
 *
 * Measured, not guessed (`AGENTS.md`, "Measure limits that reject work"). The
 * evidence is in the share-submit bound test in packages/security-contract:
 *
 * - Healthy work reaches **1,434 files** — one share of a repository-sized
 *   folder. A week of ordinary work in this repository nets 519 changed files,
 *   a fortnight 733. The previous bound of 500 sat INSIDE that range and so
 *   rejected work people really do.
 * - The relay stays linear well past this number: at 5,000 changes a submit
 *   costs 259 ms, its write-lock window 14 ms, and accept 465 ms. There is no
 *   knee anywhere in the measured range.
 * - 2,500 is 1.7x above the measured healthy maximum and leaves 4x margin
 *   below where the relay starts to cost real time.
 *
 * This is deliberately NOT `MAX_OPS_PER_REQUEST`. That bound pages a
 * continuous replication lane, where 500 is a good page size and a bigger page
 * only lengthens each stall. A submit is one user act carrying one intent, and
 * it is bounded by what a person changes, not by what a page should hold.
 *
 * A submit with more changes than this is not refused. The recipient's scan
 * stops here, sends what it holds, and reports that more is waiting — so the
 * bound never wedges anyone.
 */
export const MAX_SHARE_PROPOSAL_OPS = 2500;
