/**
 * How many net-changed files one share submit carries.
 *
 * The bound is measured. The test "the share submit bound" in
 * shareProposalBound.test.ts holds the evidence. Healthy work reaches 1,434
 * files, one share of a repository-sized folder. The relay stays linear well
 * past this number, with no knee in the measured range up to 5,000 changes.
 * 2,500 is 1.7x above the measured healthy maximum and leaves 4x margin below
 * where the relay starts to cost real time.
 *
 * This is deliberately not `MAX_OPS_PER_REQUEST`. That bound pages a
 * continuous replication lane, where 500 is a good page size and a bigger page
 * only lengthens each stall. A submit is one user act carrying one intent, and
 * it is bounded by what a person changes, not by what a page should hold.
 *
 * A submit with more changes than this is not refused. The recipient's scan
 * stops here, sends what it holds, and reports that more is waiting, so the
 * bound never wedges anyone.
 */
export const MAX_SHARE_PROPOSAL_OPS = 2500;
