# Automations execute on the origin device

An automation must fire exactly once per triggering change, but collection events fire on every device as each engine applies ops, and two partitioned devices cannot agree on an executor. No cross-device lease exists and none can deliver exactly-once under partition. We decided: an automation runs only on the device where the triggering op originated. An op originates exactly once, so execution is exactly-once by construction, and the origin device's writes reach every other device through ordinary sync.

The executor reuses the shape of the chat dispatch claim ledger, which is local state in engine.db, never replicated: a durable claim table keyed by (automation, triggering op coordinate) with the pending, running, done, failed machine, the startup reaper, and the attempt cap. If the origin device closes before executing, the claim persists and fires on next launch.

Two backstops bound the failure modes. Automation writes inside the workspace carry a deterministic idempotency key (automation id, record id, field, triggering op coordinate), so any duplicate execution converges to one visible write after sync. Effects that leave the workspace, such as webhooks, never retry: a crash between the effect and the durable completion mark loses the effect rather than doubling it.

## Considered options

A synced executor lease with a TTL was rejected. If the executor is offline, every automation stalls; if failover fires during a partition, both sides execute and only the lease row, not the side effects, merges. The lease promises exactly-once and cannot keep the promise precisely when it matters.

Run-anywhere with idempotency keys alone was rejected as the primary mechanism because it cannot contain external effects, and N devices doing the same work N times to converge on one write is waste. It survives as the merge backstop for workspace writes.

## Consequences

- An automation triggered by an edit from a device that goes away waits for that device. Surfacing a stalled claim to the owner is the visible failure, not silent reassignment.
- The Phase 4 gate's two-device race passes by construction, not by timing.
- Agent-authored edits execute their automations on the device that applied the agent's op as local, which is the device whose engine journaled it.
