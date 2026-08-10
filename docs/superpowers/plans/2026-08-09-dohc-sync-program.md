# The sync program (#356)

Status: PLAN — awaiting Ice's review. No shard starts until this document
is approved. Measured facts and every citation live in `SCAFFOLD-SYNC.md`
(repo root, 134 validated `file:line` references); this document carries
the decisions.

## What is actually missing

The gap is one producer, not a system. Ordinary file writes journal a
payload-free row (`replication_journal`) and nothing converts it into the
payload-bearing, relay-visible `replication_log` envelope. Chat writes and
replicated Y.Doc paths already produce those envelopes through
`journal_local_op_in_tx`. The entire inbound side — relay pull, blob
hydration, the router, `moment_apply`, materialization to disk — exists and
is exercised today by the chat path and the simulated file peer. The
second-machine join UI exists and works down to its first pull. The e2e
suite records the gap in its own words: "file content never reaches the
relay."

So the program is: build the one missing producer, make the proof
infrastructure real (two daemons, not one daemon and a simulation), then
resolve the two multi-peer correctness debts (#547, #548) that were
deliberately deferred until two real peers could exist, and land access
levels (#646) on the surface that sync makes real.

## Shards

### S1 — the outbound drain (the missing producer)

Convert captured file/version/secret moments and snapshots into
`replication_log` envelopes, gated on the workspace's sync identity,
mirroring the shapes `journal_local_op_in_tx` already writes for chat and
Y.Doc. Blob planning/upload and per-origin push state already exist in
`relay.rs`; this shard feeds them.

Acceptance: the rejoin e2e's recorded assertion ("file content never
reaches the relay") flips from recorded to asserted — a real daemon's
captured edit is read back by the existing `RelayFilePeer`. No new
simulation: the peer is the reader, the daemon is the writer.

Risk tier: high (durability adjacency), implementation Sol, certification
Fable on the Rust side.

### S2 — origin honesty at the replication boundary

Small and sharp: remote moments must not replay origins that mean
something locally. `captured_head_sha`'s own doc now names the hazard — a
peer's capture moment would satisfy the local prune guard without the
local disk holding the bytes. Decision: rewrite origins at the replication
boundary (the apply side stamps a replication origin), not a locality test
in the guard — the guard stays a pure read of a fact, and the boundary is
where remote-ness is known. Audit `moment_apply`/`upsert_snapshot` for any
other origin-sensitive consumer while there.

Acceptance: the durable-regimes suite gains the peer-capture-moment case:
replayed capture moment, local close still refuses. Fable certification
(prune-guard adjacency).

### S3 — the two-daemon harness

The acceptance instrument for everything after: two relay-connected
`EngineDaemonLifecycle` instances against one real relay, built on the
existing `openLiveDaemonWorkspace` helper. No Electron requirement — the
harness drives daemons and relay directly, so the serial-Playwright
constraint does not apply. The loopback keeps its role (client-adapter
fidelity) and its recorded limit (the pending-job arm stays pinned at the
real daemon boundary).

Acceptance: a smoke case — daemon A captures an edit, daemon B pulls and
materializes it — passing under the canonical gate's environment.

### S4 — two-peer base agreement (#547)

Two machines independently originate the same path-derived object; today
the receiver returns `BaseStateDiverged` and the coordinate wedges. The
recorded three-way claim rule (equal SHA resumes / different SHA fails
loudly / absent seq-0 resumes) is the local half; this shard adds the
arbitration path for the diverged case.

DESIGN GATE: the arbitration semantics (which base wins, and what happens
to the loser's updates) is a product decision — the shard opens with a
one-page design on top of the lineage record's claim properties, and Ice
reviews it before implementation. Requires S3; acceptance is the #356
two-real-peers wording, verbatim.

### S5 — origination retry (#548)

The two recorded preconditions whose later transition never retriggers
origination: a missing dependency resolved by deferred drain, and the
first relay cursor/push-state commit. Fix shape: origination is re-asked
by the transitions themselves, not by hoping for a next local append.
Acceptance: the issue's own cases — dependent update then late
predecessor, clean peer reads full text; and the bounded enrolment-window
case. Requires S3.

### S6 — second-machine join, end to end

With S1 outbound and the existing join flow, a real join should work.
This shard is verification-heavy rather than build-heavy: drive the whole
loop on two real daemons (join, both directions of edit, restart, rejoin),
fix what falls out, and promote the rejoin e2e from simulated-peer to the
S3 harness where the serial constraint allows.

### S7 — file-share access levels (#646)

The recorded View/Comment/Edit decision lands on the surfaces sync makes
real: selector contracts carry the level at grant time, the relay enforces
it server-side (member append already enforces channel levels — mirror
that), share-log filtering and share-view pull respect it, and Edit
implies the write-upload path S1 built. Linked-file chat rights follow the
table in the record. After S6.

## Sequencing and review

S1 → S2 → S3 are serial (S2 touches what S1 lands on; S3 needs S1 to have
something to prove). S4 and S5 parallelize after S3. S6 after S1+S3.
S7 last. Every shard runs the full sol-first pipeline: codex + Claude
certification per risk tier, canonical gates on exact heads, the merge
protocol unchanged. Fable certifications are mandatory for S2 and S4
(prune-guard and arbitration semantics — the data-loss surfaces).

Two standing constraints from the record, carried into every shard: the
daemon-cannot-originate constraint is history, but its capture (the
base-claim algorithm properties) binds S4's design; and cargo builds stay
single-occupancy machine-wide.

## What this closes

#356 (S1+S3+S6), #547 (S4), #548 (S5), #646 (S7). #734 (the U+FFFD seed
cliff) should be decided alongside S1 since the seed path is the same
surface.
