# Daemon RPC gap analysis — desktop surface vs dispatched methods

Snapshot updated 2026-07-25 (RPC-A/B/C/D/B2/D2 are merged; RPC-E-1 router +
appliers #242, RPC-E-2 moment.append #243, and RPC-E-3 HTTP transport #246
are in review; RPC-E-4 daemon RPC surface is in progress with no PR yet).
The nine chat replication validation gaps #244 and refusal disposition #245
are also in review, stacked on RPC-E-1 — neither is merged.
Source: full sweep of the R13b dormant
adapter, every desktop engine call site, and the daemon/actor/domain layers.
This scopes the "grow daemon RPCs for cutover-needed desktop surfaces" shard
(R13b-rest). Sub-shard split at the bottom.

## Daemon methods dispatched today

workspace.open/close · versionedText.write/read/list · versionedBinary.read ·
versions.active/list · moments.list/get · secrets.list/materialize ·
ydoc.apply · conflicts.list/open/resolve · search.query · watcher.status ·
capture.flush (watcher.status/capture.flush landed with #215; the RPC-A
read surface with #217, both merged 2026-07-21) · chats.* (23 methods,
#218 merged 2026-07-22) · ydoc.open/recordUpdate/settle/close/resync +
the ydoc.remoteUpdate event (#220 merged 2026-07-22).

## The gaps, by domain

| desktop operation | daemon RPC | Rust logic |
|---|---|---|
| listTextFiles | PARTIAL in RPC-A (#217): versionedText.list is METADATA-ONLY (paged, keyset afterPath cursor, measured byte budget); the TS operation returns TextFileSnapshot[] WITH text, and production callers (workspace search, version materialization) read file.text off the listing. RPC-D owns the callers' pivot: per-path hydration via versionedText.read or a bulk hydration/streaming path. | domain `store.rs list_snapshot_metadata` |
| readBinaryBlob (by sha) | MISSING | sole caller is the desktop binary restore (workspaceEngineCapture.ts:2371); Rust has put_binary_blob only — the read-by-sha seam is RPC-D's versions-read-binary-blob |
| readBinaryFile | PARTIAL in RPC-A (#217): versionedBinary.read (one-turn in-band cap, over-cap = metadata + inbandLimitBytes) — CONTRACT DELTA: TS returns null when the path is absent, text-headed, or blob-missing; the Rust RPC refuses a text head with InvalidParams. RPC-D decides (recommend: match the oracle's null-on-text so non-binary fallbacks keep working). | domain `store.rs read_binary_inband` |
| rename/delete/rollback text | MISSING | domain `store.rs:203/216/353` |
| compare/merge versions | MISSING | domain `merge.rs` |
| getActiveVersion | PARTIAL in RPC-A (#217): versions.active ships the ID ONLY (null on a nothing-versioned store); TS returns a full `VersionRecord \| null` — the full-record passthrough is RPC-D work (rpc-a-versions-active-id-only / versions-get-active-version) |
| readTextFile binary-head metadata | PARTIAL | TS readTextFile's snapshot exposes binary heads (contentKind/sha256/byteLength) in the SAME call; Rust versionedText.read refuses binary heads and callers must pivot to versionedBinary.read. Single-call snapshot introspection parity is RPC-D work |
| set/ensure active version | MISSING | domain exists |
| listVersions / createNamedVersion / forkVersion | listVersions SHIPPED in RPC-A (#217, versions.list); createNamedVersion/forkVersion remain MISSING (RPC-D) | domain `store.rs list_versions`/`create_named_version`, `secrets.rs` fork section |
| listMoments / getMoment | SHIPPED in RPC-A (#217, merged): moments.list/moments.get hydrate before/after TEXT plus actual byte lengths under the one-turn in-band cap. Over-cap moment bodies today = null text + byte lengths WITHOUT an inbandLimitBytes field (unlike the other read RPCs). What is NOT ported is the oracle's payload-provenance columns (payload_before_*/payload_after_* and before-snapshot identity) — the Rust schema lacks them; see the SCHEMA OBLIGATION below (pre-R15 migration candidate). RPC-D owes ONE more thing: over-cap moment bodies return null text + byte lengths but NO inbandLimitBytes field (versionedText.read/versionedBinary.read/secrets.materialize all self-describe their cap) — RPC-D adds the field for contract uniformity. | domain `store.rs:616/783` |
| listSecretFiles / materializeSecretFile | SHIPPED in RPC-A (#217): secrets.list (keyless page) + secrets.materialize (in-band cap; over-cap tips authenticate then drop plaintext) | domain `secrets.rs:547/526` |
| secret moments/compare/restore | MISSING | moments exist (`secrets.rs:582/614`); compare/restore are NOT ported — those line refs are TS `secretFileStore.ts:1468/1517/1584`. Real Rust domain work, not wiring |
| CHATS (threads/messages/channels/feed/follows/bookmarks/dispatch) | SHIPPED in RPC-B (#218 merged 2026-07-22): 23 chat methods over LinkedChatStore. Reactions, decisions, mention/attachment indexing, and the file-linked reads (listThreadsForFile/getThreadProjection) remain RPC-B2 (unported domain work). | `chats.rs:744-2004`; B2 items have no Rust domain counterparts yet |
| ydoc SESSION protocol (open/recordUpdate/settle/close/resync + remoteUpdate events) | SHIPPED in RPC-C (#220 merged 2026-07-22): daemon-owned canonical Y.Doc sessions; applyExternalMarkdownEdit is subsumed by the external-edit/self-write-suppression path. | runtime session layer + `packages/workspace-engine-client/src/ydoc/ydocWireContract.ts` |
| applyReplicationOp (general) / relay sync orchestration | MISSING (conflict envelopes only) | `dohc-engine-sync` exists |
| search index writes | MISSING (query only) | runtime `search/index.rs:157/193/218/436` |
| legacy changeSetStore | not a cutover target (superseded by capture) | — |

## Dormant adapter reality check

`engineClient.ts` is a generic DOP1 pipe (no domain methods); the ONLY domain
surface it wires is the ydoc session provider — whose six methods the daemon
does not implement. `DOHC_RUST_ENGINE_ADAPTER=1` gates it; never set in prod.
The `workspace-kernel` sidecar used by capture is a different binary and out
of scope here.

## Sub-shard plan

- **RPC-A (read surface, cheap wins):** versions.active/list, moments.list/get,
  versionedText.list, versionedBinary.read, secrets.list. Domain logic all
  exists; each needs an actor passthrough + dispatch arm + tests.
  **secrets.materialize is NOT a cheap read** — it is the single authorized
  plaintext accessor (TS parity) and carries mutation-grade posture: auth'd
  DOP1 session only, key loaded per call from the workspace root (no daemon
  key custody), fail-closed on missing-key-with-state, plaintext returned
  in-band only (never written to disk by the daemon), and the shadow fence
  scopes it to bound workspaces. Recorded here rather than a separate slice
  because the TS desktop already grants exactly this accessor to the same
  trust domain.
- **RPC-B (chats):** expose `LinkedChatStore` through the actor. Largest
  surface; mechanical ONLY for the surfaces R09 ported (channels, threads,
  messages, read-state, follows, feed, bookmarks, dispatch). Reactions,
  decisions, and mention indexing need Rust domain work first — verify each
  method exists before estimating the slice.
  ALSO UNPORTED (Codex, verified 2026-07-21): the FILE-LINKED reads
  production MCP calls today — `chats.listThreadsForFile` and
  `chats.getThreadProjection` (packages/mcp/src/tools.ts:2670/2722) have no
  Rust counterparts (no thread<->file link queries, no thread->markdown
  projection renderer in chats.rs). Real domain work; slots with the
  reactions/decisions follow-up (RPC-B2), NOT mechanical wiring.
  ALSO production-called and unported: chat ATTACHMENT reads —
  `listThreadAttachments` (graph mention enrichment) and the
  `listChatThreadAttachments` IPC (apps/desktop/src/main.ts:3203/5312);
  chats.rs scopes attachment indexing OUT of R09 explicitly. Slots with
  RPC-B2.
  ALSO production-called and to VERIFY-THEN-ADD (Codex, 2026-07-21):
  `getChannelWireId` (wire-id RECORDING exists Rust-side —
  record_channel_wire_id, chats.rs:800 — the read accessor is unverified),
  `findThreadChannelId` and `listChannelThreads` (thread->channel and
  per-channel thread queries; desktop main.ts + MCP tools.ts call all
  three). Likely small query additions, but per this program's rule they
  are VERIFIED per method before the slice estimates, never assumed.
- **RPC-C (ydoc session):** implement the session protocol daemon-side over
  the `ydoc.apply` primitive + collab crate (port `ydocLoopbackEngine`
  semantics). Deepest design work; needs the wire contract's event side.
  CONSTRAINT: the server-side Y.Doc is CANONICAL; session and markdown APIs
  are projections, and every mutation converges through it.
- **RPC-D (mutating text/version surface):** rename/delete/rollback,
  compare/merge, create/fork/set-active version, secret writes via RPC.
  Interacts with the capture OWNERSHIP model — write RPCs must carry proper
  origins (never the reserved `capture`).
- **RPC-E (replication/relay):** Ice brought this into pre-cutover scope.
  RPC-E-1 (#242, in review) owns the central router and missing appliers;
  RPC-E-2 (#243, in review, stacked on -1) owns `moment.append`; RPC-E-3
  (#246, in review, stacked on -2) owns the HTTP transport; RPC-E-4
  (`codex/rust-engine-rpc-e-daemon-rpc`, in progress, no PR) owns the daemon
  RPC surface. Chat validation #244 and refusal disposition #245 are sibling
  review branches stacked on RPC-E-1.

Cutover-blocking order per desktop usage weight: A → B → C, then D and
B2 (production-called chat follow-ups — a GATE6 dependency like the rest); E per
Ice's R15 scope decision.

Standing contract for EVERY slice (already the daemon's shape, recorded so
no slice regresses it): authorization and workspace scoping are derived
SERVER-SIDE — the workspace handle resolves against the daemon's own table
under the authenticated DOP1 session; desktop-supplied identifiers are never
trusted for access.

WIRE-LIMIT OBLIGATION (found in RPC-A review): in-band content is bounded
by the DOP1 limits (64 KiB per string, 1 MiB per frame). #217 (RPC-A, MERGED
2026-07-21 — this WIRE-LIMIT paragraph's contracts are on main; sections
explicitly labeled PENDING #220 below are NOT) ships
versionedBinary.read with a 48 KiB in-band cap (over-cap answers metadata +
null body, self-describing), versionedText.list as METADATA-ONLY
(bodies via versionedText.read), and the SAME 48 KiB in-band contract for
secrets.materialize: an over-cap secret answers {text: null, byteLength,
inbandLimitBytes} — plaintext stays in-band or absent, NEVER partially
delivered and never a post-decrypt encode failure; callers needing larger
secrets wait on the same blob-streaming follow-up. versionedText.read
carries the SAME 48 KiB in-band content cap (read_text_inband with
MAX_INBAND_CONTENT_BYTES = INBAND_CONTENT_CAP_BYTES = 48 KiB — NOT the
64 KiB wire-string bound, which is the DOP1 envelope limit above it).
Real binaries and text past the 48 KiB cap need the protocol's blob-chunk
streaming (BlobStart exists in the wire contract; NO daemon producer
yet) — cutover-relevant for readBinaryFile and large text reads.
RE-SCOPED (RPC-D pre-PR adversarial review, 2026-07-22): the EGRESS
producer moves to shard RPC-D2 (sole caller is desktop binary restore;
needed pre-cutover, NOT pre-PR — a GATE6 dependency). RPC-D ships
readBlob's metadata-only over-cap answer and refuses inbound BlobStart
with "blob-ingest-unsupported".

RPC-D2 ALSO owns the secret-aware DISK executor (recorded at PR #223
review): RPC-D's secret surface is DB-authoritative — secrets.write/
apply/restore enqueue secret-mat_ jobs and every delete flavor records
its completed generation marker, but the generic job replayer SKIPS
secret jobs (plaintext requires the key, which the daemon never holds
at replay time), so the materialized workspace file stays absent/stale
until the executor lands. Pre-cutover no production caller reads the
materialized secret path through the daemon; the recorded jobs/markers
let the executor settle disk state exactly once when it arrives.
The executor must also decide the CROSS-VERSION disk semantics: marker
generations are workspace-wide orders keyed by path, and a delete in a
non-active version records a marker that outranks an older pending job
for the ACTIVE version's same path — which job wins disk is its call.
GATE6-blocking.


CROSS-ENGINE DELTA (PR #223 claude r4): secret path SLASH-SPELLING —
the Rust SECRET store keys rows by the verbatim path while the oracle
stores validateUserWritePath().normalized (slash cleanup), and the Rust
TEXT store normalizes slashes too. Edge spellings ("a//b.env") create
two Rust secret rows where the oracle collapses to one, and both
materialize onto the same disk file. Self-consistent within Rust
(write/read/list all verbatim); owed a ruling alongside the RPC-D2
secret disk executor — GATE6-BLOCKING (two secret rows materializing
onto one disk file is a plaintext clobber/mask hazard).
**RESOLVED by RPC-D2 SF3 (PR #227):** validate_secret_path now adopts the
oracle's canonical slash-collapsed key (classify_engine_file_path_normalized),
matching normalizeSecretPath and the Rust text store — "a//b.env" collapses to
one row, dissolving the clobber hazard at the key level. No migration (pre-R15
destructive cutover + secret AAD is path-bound, so a keyless rename can't
re-authenticate). ALSO recorded
(same review): the daemon rollback's engine_requests purge filtered by
bare result_seq in a table shared with the collab durable ledger and
the storage compound-write ledger. DISCHARGED in-PR (codex r7): the
engine_requests table gained a kind column (migration 13, every writer
stamped — versioned/merge/ydoc/compound/chat) and the purge is scoped
to kind='versioned'; legacy NULL-kind rows are never swept.

CROSS-ENGINE DELTA (PR #227 claude round-3 focused review) — secret open-replay
PER-JOB failure tolerance. RPC-D2's open-replay secret executor TOLERATES per-job
operational failures (disk-op errors from the secret write/delete executors,
key-load failures, and DECRYPT/authentication failures) by leaving that one job
PENDING and CONTINUING workspace.open — one bad secret never bricks the whole
open. For DISK anomalies (symlink/directory/permission at a secret path) this
MATCHES the oracle, which skips a secret per-file (readDiskSecretState
"unreadable"/"untracked-content" -> continue, workspaceEngineCapture.ts:1562).
For DECRYPT/key failures the Rust behavior is DELIBERATELY BROADER than the
oracle: the oracle awaits materializeSecretFile / planSecretMaterialization
directly (workspaceEngineCapture.ts:1564/1865) so a decrypt rejection propagates
out of version-switch planning, whereas Rust open-replay (crash-recovery, not a
user action) tolerates it. The security invariant is PRESERVED on both: no
plaintext is ever written from unauthenticated bytes (plaintext reaches the disk
executor only after secret_plaintext_for_job returns Ok(Some)). Rationale: a
single tampered/undecryptable secret must not DoS the entire workspace open; the
job stays pending and retries. Structural corruption (secret_job_coordinates
path/gen/operation mismatch vs its own moment) stays FATAL — a broken durable
invariant, not an operational skip. Regression tests: tampered ->
open-succeeds-no-plaintext-job-pending; symlink/directory-at-path ->
open-succeeds-no-wrong-file (dohc-workspace-engine rpc_write_surface).

CROSS-ENGINE DELTA (PR #225 claude r3): mention-handle READ validation
— the Rust read validator shares the scanner's exact alphabet (dots,
underscores, the U+017F/U+212A fold chars), so every indexed handle is
queryable; the TS oracle's normalizeMentionHandle (/^[a-z0-9-]+$/)
refuses some handles its own scanner indexes (agent.ops_v2 throws on
JS, succeeds on Rust). Deliberate oracle-bug fix; parity suites must
expect it; moot for data post-R15.

CROSS-ENGINE DELTA (PR #225 codex r4/r6 + CodeRabbit): linked thread
timestamp — RUST REJECTS-ON-APPLY, DELIBERATELY STRICTER THAN THE
ORACLE. An imported `chat.thread.create` with `linkedObjectId` but no
`linkedAtMs` is a malformed op that the ORACLE accepts and stores with
`linked_at_ms = NULL` (`linkedAtMs ?? null` at linkedChatStore.ts:4432)
and then BRICKS on its OWN read — `threadFromRow` passes NULL to
`numberValue` (:653/:1498) and throws corruptStore, so the row is
unrenderable on the oracle too. **Policy (named, tested): the Rust
receiver REJECTS the op at apply** (`chat.thread.create` requires
`linkedAtMs` whenever `linkedObjectId` is present, dohc-engine-sync
apply.rs) — fail-closed, consistent with `map_thread_row`, so no
durable-unreadable linked thread is ever persisted. This is a
deliberate stricter-than-oracle divergence: the oracle's
accept-then-brick is a latent bug we do NOT replicate. It costs no
honest-data parity — well-behaved mint always pairs the fields
(:2122/:2157), so only a corrupt/hostile op is refused (its origin's
ack stream fail-closed halts at that op, the correct response to a
malformed replicated write; the relay/RPC-E layer owns hostile-origin
quarantine). Differential/parity suites MUST expect the delta: a
half-linked import → oracle acks-then-bricks, Rust refuses.
REGRESSION TEST: `imported_thread_rejects_linked_object_without_linked_timestamp`
(dohc-engine-sync). Moot for data post-R15 (the reset wipes any
pre-existing NULL-linked rows).

CROSS-ENGINE DELTA (PR #225 codex r5): attachment object identity SHARED
TRUST BOUNDARY — an imported `chat.attachment.add` without `objectId` is
accepted by BOTH engines with the peer's `attachmentId` trusted verbatim
and not recomputed. The oracle gates its object-id checks and attachment-id
recomputation behind `payload.objectId !== undefined && (...)`
(`linkedChatStore.ts:4626-4634`), which short-circuits when the field is
absent; Rust intentionally matches. This is adversarial-only because
well-behaved minting always carries `objectId`, and it is moot post-R15.
Rust does not add an import-side object-id requirement: doing so would
diverge from the oracle and stall the origin's ack stream. Any attachment-id
forgery hardening belongs at the relay/RPC-E trust boundary and must cover
both engines; there is no Rust code change for this finding.

CROSS-ENGINE DELTA (PR #225 codex r4/r5/r7 + claude): structural-timestamp
SAFE-INTEGER apply bounds — RUST BOUNDS, STRICTER THAN THE ORACLE'S
`isFinite`-ONLY APPLY, but MATCHES the DOP1 WIRE representability. Every
imported chat cell/structural timestamp — reaction/decision `at_ms`,
feed-read `at_ms`, attachment `created_at_ms`, message `createdAtMs`,
channel `createdAtMs`, and (r7) `chat.follow.set` `at_ms` — is bounded on
apply with `is_persisted_safe_integer` (dohc-engine-sync apply.rs; signed
`-MAX_WIRE_INTEGER..=MAX_WIRE_INTEGER`, `MAX_WIRE_INTEGER = 2^53-1`). The
ORACLE's replicated apply validators check only `Number.isFinite`
(linkedChatStore.ts, e.g. the follow arm ~:4686), so in a strict
differential test the oracle STORES a finite-but-non-safe value (e.g. `2^53`)
while Rust REJECTS it with `InvalidInput`. This is NOT a fresh divergence
class: values beyond `2^53-1` cannot traverse the DOP1 wire (the frame/limits
decoders are safe-int bounded on BOTH engines), so such a value could never
legitimately arrive over replication; bounding the apply makes the domain
consistent with the wire it must round-trip. It costs no honest-data parity
(real clocks are ~13 orders of magnitude below `2^53` ms ≈ year 285000).
Differential/parity suites MUST expect the delta on a hand-fed `2^53` cell
op. REGRESSION: `imported_follow_refuses_unsafe_at_ms_without_row_or_ack`
(dohc-engine-sync) + the sibling cell tests. Moot for data post-R15.

  SUB-NOTE (claude r-opus, P3, RECORDED NOT FIXED): the LOCAL LWW mints
  `set_follow` / `set_feed_read` (dohc-engine-domain chats.rs) compute
  `at_ms = now_ms.max(prior + 1)` and journal the replicated op WITHOUT a
  safe-integer bound — unlike `create_thread` / message-send, which bound
  `now_ms`. So if a hostile peer first primed a follow/feed-read row at exactly
  `MAX_WIRE_INTEGER` (the max the apply now allows), a subsequent LOCAL toggle
  would mint `at_ms = 2^53`, an op the wire cannot carry and Rust's own apply
  would reject on a peer. Left as bug-for-bug parity, NOT bounded: (a) the
  oracle's `setFollow` derives `at_ms` from an internal `nowMs()` clock (no
  caller field) and has the same latent inability to replicate `2^53`, so
  bounding would be stricter than the oracle; (b) the value is RENDERABLE on
  both engines (`map_follow_row` / oracle `numberValue` are `isFinite`-only),
  so unlike the linked-timestamp delta above it is not accept-then-brick; (c)
  bounding the mint would REFUSE a legitimate local user action (a follow
  toggle) to guard an edge unreachable without a hostile peer priming
  `prior = 2^53-1`. DD3's apply bound is the reachable defense (it stops the
  hostile IMPORT). Adversarial-only, moot post-R15 (single-user dogfood has no
  hostile peers; the reset wipes primed rows). Revisit if a reviewer pushes for
  local-mint symmetry (cf. the linked-timestamp reversal).

CROSS-ENGINE DELTA (PR #225 codex r8) — attachment objectId CONTROL CHARS on
replicated apply: SHARED with the oracle, NOT rejected. A remote
`chat.attachment.add` whose `objectId` carries leading/trailing whitespace or a
control char (with a peer-computed `attachmentId` that matches the recompute over
that exact string) is accepted verbatim by BOTH engines. The oracle's replicated
validator checks the objectId ONLY by `objectId.length !== 0 && length <= 200 &&
attachmentId === attachmentIdFor(...)` (linkedChatStore.ts:4626-4634) — no
control-char / trim check, unlike its `chat.thread.create` objectId
(`isBoundedReplicatedId`). Rust's apply (`valid_object`, dohc-engine-sync
apply.rs) matches exactly (non-empty, `encode_utf16 <= 200`, attachment-id
recompute). Same shared trust boundary as the r5 attachment-identity decline: the
value is RENDERABLE on both engines (`map_attachment_row` reads `object_id` as
`Option<String>` and does not throw), and DD1 already makes the LOCAL attachment
mint stricter (`normalize_attachment_object_id` rejects control chars), which is
the SAFE direction (local mints stay replicable). Adding a control-char rejection
to the replicated apply would DIVERGE from the oracle and stall the origin's ack
stream on a hostile op. The thread-objectId/attachment-objectId asymmetry (thread
rejects control chars on apply, attachment tolerates) is driven by the ORACLE's
own validator asymmetry — correct bug-for-bug parity. Forgery hardening belongs
at the relay/RPC-E boundary; no Rust code change.

CROSS-ENGINE DELTA (PR #225 codex r8) — live-bookmark requeue timestamp uses the
trigger `createdAtMs` VERBATIM (safe negatives included), matching the oracle. On
an imported `chat.message.append` / `chat.attachment.add`, `mark_live_bookmarks_
pending` sets `chat_bookmark_outbox.updated_at_ms` to the trigger's
`created_at_ms` (dohc-engine-sync apply.rs:768/971). Since message/attachment
`createdAtMs` apply is bounded with `is_persisted_safe_integer` (SIGNED, allows
safe negatives — verbatim-import parity with the oracle's `Number.isFinite`), a
negative can propagate into the outbox timestamp. This is NOT clamped, matching
the oracle EXACTLY: `markLiveBookmarksPending(db, ws, threadId,
payload.createdAtMs)` (linkedChatStore.ts:4533/4671) uses the trigger createdAtMs
verbatim, and the oracle's replicated createdAtMs is `isFinite`-only, so the
oracle propagates the same negatives. NO read-corrupt gap: `outbox_updated_at_ms`
is exposed ONLY as (a) the ORDER BY key for keyset pagination (a total order that
handles negatives) and (b) the opaque `first` field inside the encoded cursor,
which `decode_chat_cursor` does not bound non-negative (it validates only
`version`/`binding`/`consumed >= 0`/`second`). The client-facing
`ChatBookmark.updatedAtMs` is the bookmark's OWN column (lib.rs:7383), never the
outbox value. Clamping to `max(0, at_ms)` would DIVERGE from the oracle for no
representability gain. Adversarial-only (a peer must send a negative createdAtMs,
which both engines accept), moot post-R15. No Rust code change.

CROSS-ENGINE DELTA (RPC-A r18): secret path SPELLING — TS normalize-stores
(percent-disguises collapse); Rust stores the spelling the write carried
and resolves verbatim (the secretness gate still classifies via
normalization, so disguises cannot bypass it). Moot for data post-R15
(the reset wipes TS-written rows); differential/parity suites must expect
it.

CROSS-ENGINE DELTA (SHIPPED with #220, merged 2026-07-22; recorded
2026-07-21): daemon Y.Doc settles
mint moments with metadata_origin "ydoc"; the TS oracle's ydocEngineDriver
settles with "local-file" (ydocEngineDriver.ts:920) because TS's origin
contract is the closed 5-set {api, local-file, restore, sync, unknown}
(versionedTextStore.ts:2195-2201 — "ydoc" would be invalid-metadata
there). The Rust text path takes origin as an opaque string, so "ydoc" is
deliberate richer provenance (a settle is distinguishable from a disk
capture) — but parity/differential suites must expect the delta, renderer
surfaces switching on origin must treat "ydoc" as first-class, and RPC-D
must decide whether the daemon's write RPCs validate the closed set
(recommended: closed set + "ydoc" as the one daemon-internal addition).
DESKTOP IPC OBLIGATION (owned by RPC-D, whose owned_paths now include
bridgeContract.ts — R14 is already gate-passed): the renderer
bridge schema (apps/desktop/src/ipc/bridgeContract.ts) accepts only the
closed 5-set today and main.ts parses engine-history responses through
it — the first "ydoc"-origin moment crossing IPC fails schema
validation until that contract widens. RPC-D's review must include it.

STANDING IDENTITY POSTURE (chats surface, recorded at #218 rounds 2/5):
the daemon's authenticated DOP1 client IS the desktop main process — the
same process the TS oracle trusts to DERIVE author/owner identity before
touching the store (main.ts:5215-5225 derives authorship; the renderer
payload carries no identity fields, bridgeContract.ts:971-977; the relay
separately verifies authorUserId === actor.userId for replicated ops,
linkedChatStore.ts:4492-4498). The daemon transport is inherited STDIO
pipes, not a listener socket: another process cannot connect to a namespace
entry because none exists, and the renderer never reaches the pipes. Chat RPC
identity params (authorUserId/ownerUserId) therefore sit in the SAME trust
position as the oracle's function arguments. PR #241 (IN REVIEW, not merged)
hardens the handshake token comparison; R13b-rest still owns generating a
real per-launch random token when it wires lifecycle. A future
multi-principal transport would require a fresh recorded authorization
decision and platform peer-identity design.

CROSS-ENGINE OBLIGATION (declined-with-citation at #218 round 12; owned
by RPC-E/sync, recorded so it is owned rather than lost): well-known
channel wire-id BACKFILLS are not journaled. The oracle's
`ensureGeneralChannel` backfill path (linkedChatStore.ts:2241-2250)
records the wire mapping and returns WITHOUT `journalLocalReplicationOp`
— journaling runs only on the create path (:2270-2282), and
`ensureAgentChannel` has the same shape; the Rust port mirrors both
exactly. Consequence: a backfilled wire id is invisible to peers until
some authoritative create for that channel reaches them. Changing that
convergence semantic is sync/replication-shard work (RPC-E), not a port
concern — any fix must land in BOTH engines or be scoped post-cutover.

R15 IS A DESTRUCTIVE CUTOVER GATE, not a parity note: the reset wipes
TS-written rows in Ice's dogfood workspace. Policy (R15/R15-REHEARSE
shards): full pre-reset backup of the TS engine state, a rehearsed
restore path, and the flip happens ONLY on Ice's explicit go/no-go
confirmation — the one mandatory human stop in the program. Data-loss
surface and rollback are part of the go/no-go package, never implied.

SCHEMA OBLIGATION (RPC-A r11): the oracle's momentSelectSql payload
provenance (payload_before_*/payload_after_*) and before-snapshot identity
columns were never ported to the Rust moments table. Rust hydrates what
its schema HAS (before/after text + byte lengths). Full parity = a
migration — pre-R15 candidate, pairs with the secret ownership column.

CROSS-ENGINE GAP (PR #227 codex-bot round-7) — secret re-materialization on version
SWITCH is MISSING in the Rust daemon (R13/GATE6 obligation, NOT an RPC-D2 blocker).
The ORACLE re-materializes the target version's secrets from the store on a version
switch (planSecretMaterialization + switchVersion, workspaceEngineCapture.ts:1548-1584,
1830-1891). The Rust daemon's `SetActiveVersion` is DB-ONLY (actor.rs) and workspace.open
only replays PENDING materialization jobs — there is NO store-read "rebuild the active
version's secret tips" pass, and `materialize_secret` (actor.rs:2233) has no Rust caller.
RPC-D2 makes secrets survive to the next OPEN where their version is active (non-active
secret jobs stay PENDING, not marked complete), so open-time projection is correct. But a
MID-SESSION version switch does not refresh the on-disk secrets until the next open. Wiring
a switch-time (or set-active-time) secret materialization pass is daemon-composition
(R13)/desktop-adapter scope, not the secret executor; tracked for GATE6. Non-secret files
share the same switch-materialization dependency on the desktop/daemon composition layer.

UPDATE — PR #239 implements switch-time file+secret projection and is IN REVIEW,
not merged. It deliberately defers two upper-layer R13b obligations:
1. Quiesce/settle and close live Y.Doc sessions before the version switch. A
   session pinned to the old version can otherwise settle after the active-version
   transaction and cross the switch boundary.
2. Reconcile unreconciled disk edits into the version being left before the
   active-version transaction. `capture.flush` does NOT satisfy this obligation:
   `reconcile_if_dirty` returns `Converged` without touching the filesystem when
   no dirty bit is set, while the TypeScript oracle's switch path always scans and
   hard-fails on a degraded scan. The capture driver resolves the active version
   at APPLY time; therefore a reconcile that begins before the switch can apply
   after it and straddle the set-active transaction. R13b-rest must supply an
   explicit quiesce + full-scan + sequencing barrier.

OPEN CUTOVER SEQUENCING DECISION (RPC-E-3 / #246, for Ice): TypeScript and Rust
relay clients cannot coexist on one workspace after epoch-identity adoption.
The relay's `enforceWorkspaceIdentity` permanently rejects identity-less
requests with `409 identity_required` after a coordinate adopts identity, while
the TypeScript relay client never sends identity. Every relay-using client/device
for the workspace must therefore move together; a mixed-client rollout is not a
valid intermediate state.

REVIEW STATE (not landed): #244 closes nine chat replicated-path validation gaps,
and #245 adds the refuse-and-ack disposition for rejected replicated operations.
Both are OPEN/in review on top of RPC-E-1 (#242). Do not describe either behavior
as merged until its PR state changes.

## PR #227 codex-bot round-8 declines

- **Clear stale plaintext when the active secret decrypt fails
  (`actor.rs:~5165`) — DECLINE.** When the active tip is undecryptable because
  the DB is tampered or corrupt, round 4 leaves the materialization job pending.
  The previously materialized plaintext is the last decryptable value and was
  legitimately written to disk. Clearing it on a decrypt failure would break a
  working `.env` during a transient/corruption event without a confidentiality
  gain: an attacker able to tamper with the DB can already read the disk
  plaintext. The secret still exists (its tip is present but undecryptable), so
  retaining its last-good value is defensible. This is not a deletion.
- **Keep request ids reserved during blob egress
  (`dohc-workspace-engine.rs:~437`) — DECLINE.** The stdio daemon is
  single-client: the desktop main process, under the standing identity posture.
  That trusted client issues unique request ids, so reuse during an in-flight
  egress is not a real threat. Multi-client id-collision hardening belongs to
  relay/RPC-E scope.
- **Surface blob egress for in-process callers (`transport.rs:~129`) —
  DECLINE.** Over-cap `readBlob` egress reaches an in-process caller only
  through `ServiceResponse.blob_egress`. The only in-process `readBlob` callers
  are tests; production in-process callers do not negotiate `blobs`, so there
  is no production impact. If an in-process production consumer ever opts into
  `blobs`, wire the in-process egress drain then.
