# Daemon RPC gap analysis — desktop surface vs dispatched methods

Snapshot 2026-07-23 (RPC-A MERGED #217; FCOMP-E merged #215; RPC-B MERGED
#218; RPC-C MERGED #220; RPC-D MERGED #223 as a5b3a484 — the mutating
text/version/secret surface, typed client contract, and loopback are on
main; remaining daemon gaps are RPC-B2, RPC-D2 (blob egress + secret
disk executor), and RPC-E).
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
- **RPC-E (replication/relay):** general applyReplicationOp + relay sync
  orchestration. Coordinate with the backend-modes doc; may be post-cutover
  depending on the R15 scope Ice picks.

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
onto one disk file is a plaintext clobber/mask hazard). ALSO recorded
(same review): the daemon rollback's engine_requests purge filtered by
bare result_seq in a table shared with the collab durable ledger and
the storage compound-write ledger. DISCHARGED in-PR (codex r7): the
engine_requests table gained a kind column (migration 13, every writer
stamped — versioned/merge/ydoc/compound/chat) and the purge is scoped
to kind='versioned'; legacy NULL-kind rows are never swept.

CROSS-ENGINE DELTA (PR #225 claude r3): mention-handle READ validation
— the Rust read validator shares the scanner's exact alphabet (dots,
underscores, the U+017F/U+212A fold chars), so every indexed handle is
queryable; the TS oracle's normalizeMentionHandle (/^[a-z0-9-]+$/)
refuses some handles its own scanner indexes (agent.ops_v2 throws on
JS, succeeds on Rust). Deliberate oracle-bug fix; parity suites must
expect it; moot for data post-R15.

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
linkedChatStore.ts:4492-4498). The DOP1 socket is shadow-fence
token-authenticated and main-only; the renderer never reaches it. Chat
RPC identity params (authorUserId/ownerUserId) therefore sit in the SAME
trust position as the oracle's function arguments — per-user
authorization on the socket becomes meaningful only if the daemon ever
accepts multi-principal clients, which is R15+ scope and recorded here so
review rounds stop re-litigating it.

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
