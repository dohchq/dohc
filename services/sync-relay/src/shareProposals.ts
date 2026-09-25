// Inside a share's origin namespace (`share:<shareId>:…`), this
// prefix belongs to the relay: it names the stream one accepted proposal
// writes. A recipient's own push may not claim it.
export const PROPOSAL_ORIGIN_PREFIX = "proposal:";
