import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

// Retention for the trash table (Phase 2 recoverability). 30-day
// window is enforced by purging expired snapshots on a cadence.
// `crons.interval` per the Convex guidelines (not the daily helper);
// `_purgeExpired` is batched + self-rescheduling so each run stays
// within transaction limits.
const crons = cronJobs()

crons.interval(
  'purge expired trash',
  { hours: 6 },
  internal.trash._purgeExpired,
  {},
)

// `confirmed` captures accumulate without this. Non-confirmed rows
// (auto/pending/rejected) are NEVER purged — they are the load-bearing
// cross-person withhold signal (purging one is a time-delayed
// cross-tenant leak; see captures.ts). Same batched pattern.
crons.interval(
  'purge expired captures',
  { hours: 6 },
  internal.captures._purgeCaptures,
  {},
)

export default crons
