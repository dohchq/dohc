# Daemon RPC gap analysis — desktop surface vs dispatched methods

Snapshot 2026-07-20 (FCOMP-E on branch, #215 in review). Source: full sweep of the R13b dormant
adapter, every desktop engine call site, and the daemon/actor/domain layers.
This scopes the "grow daemon RPCs for cutover-needed desktop surfaces" shard
(R13b-rest). Sub-shard split at the bottom.

## Daemon methods dispatched today

workspace.open/close · versionedText.write/read · ydoc.apply ·
conflicts.list/open/resolve · search.query · watcher.status · capture.flush
(the last two landed with #215, merged 2026-07-21).

## The gaps, by domain

| desktop operation | daemon RPC | Rust logic |
|---|---|---|
| listTextFiles | MISSING | domain `store.rs list_snapshots` (not on actor) |
| readBinaryFile | MISSING | domain read path exists |
| rename/delete/rollback text | MISSING | domain `store.rs:203/216/353` |
| compare/merge versions | MISSING | domain `merge.rs` |
| getActiveVersion | MISSING | actor `active_version_id` is ID-ONLY; TS returns a full `VersionRecord \| null`. RPC-A ships the id (callers join via versions.list); a full-record passthrough is RPC-D work |
| set/ensure active version | MISSING | domain exists |
| listVersions / createNamedVersion / forkVersion | MISSING | domain `store.rs:593/823`, `secrets.rs:645` |
| listMoments / getMoment | MISSING | domain `store.rs:616/783` |
| listSecretFiles / materializeSecretFile | MISSING | domain `secrets.rs:547/526` |
| secret moments/compare/restore | MISSING | moments exist (`secrets.rs:582/614`); compare/restore are NOT ported — those line refs are TS `secretFileStore.ts:1468/1517/1584`. Real Rust domain work, not wiring |
| CHATS (threads/messages/channels/feed/follows/bookmarks/reactions/mentions/decisions/dispatch) | ALL MISSING | `chats.rs:744-2004` covers channels/threads/messages/read-state/follows/feed/bookmarks/dispatch; reactions, decisions, and mention indexing were scoped OUT of R09 — unported domain work. Nothing on the actor |
| ydoc SESSION protocol (open/recordUpdate/settle/applyExternalMarkdownEdit/close/resync + remoteUpdate events) | MISSING (only the `ydoc.apply` primitive) | session layer lives only in TS `ydocLoopbackEngine.ts`; contract at `packages/workspace-engine-client/src/ydoc/ydocWireContract.ts` |
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

Cutover-blocking order per desktop usage weight: A → B → C, then D; E per
Ice's R15 scope decision.

Standing contract for EVERY slice (already the daemon's shape, recorded so
no slice regresses it): authorization and workspace scoping are derived
SERVER-SIDE — the workspace handle resolves against the daemon's own table
under the authenticated DOP1 session; desktop-supplied identifiers are never
trusted for access.

WIRE-LIMIT OBLIGATION (found in RPC-A review): in-band content is bounded
by the DOP1 limits (64 KiB per string, 1 MiB per frame). RPC-A ships
versionedBinary.read with a 48 KiB in-band cap (over-cap answers metadata +
null body, self-describing) and versionedText.list as METADATA-ONLY
(bodies via versionedText.read). Real binaries and >64 KiB text need the
protocol's blob-chunk streaming (BlobStart exists in the wire contract; NO
daemon producer yet) — cutover-relevant for readBinaryFile and large text
reads; slot with RPC-D or its own slice. The pre-existing
versionedText.read carries the same 64 KiB bound for a single body.
