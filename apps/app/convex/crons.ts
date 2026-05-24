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

// Phase 4 Unit 4b — the weekly loop. Fan-out enumerates the
// onboarding table and schedules _reconcile per workspace (batched +
// self-rescheduling). `crons.interval` per the Convex guidelines
// (not the weekly helper). Reconcile only ever creates ADVISORY
// pending proposals — never mutates user data.
crons.interval(
  'weekly reconcile loop',
  { hours: 24 * 7 },
  internal.loop._reconcileAll,
  {},
)

// M1 step 3 sub-commit 3.3 — reap idle collab sessions. 60s
// cadence matches the 90s presence-expiry contract. Codex v3
// caught v2's 5min cron + 90s expiry as a ~6.5min lag between
// promise + delivery; this closes it.
crons.interval(
  'reap idle collab sessions',
  { seconds: 60 },
  internal.collabPresence._cleanupIdleSessions,
  {},
)

export default crons
