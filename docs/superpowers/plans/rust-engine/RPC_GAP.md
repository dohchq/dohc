# Daemon RPC gap analysis — desktop surface vs dispatched methods

Snapshot 2026-07-20 (post-FCOMP-E). Source: full sweep of the R13b dormant
adapter, every desktop engine call site, and the daemon/actor/domain layers.
This scopes the "grow daemon RPCs for cutover-needed desktop surfaces" shard
(R13b-rest). Sub-shard split at the bottom.

## Daemon methods dispatched today

workspace.open/close · versionedText.write/read · ydoc.apply ·
conflicts.list/open/resolve · search.query · watcher.status · capture.flush

## The gaps, by domain

| desktop operation | daemon RPC | Rust logic |
|---|---|---|
| listTextFiles | MISSING | domain `store.rs list_snapshots` (not on actor) |
| readBinaryFile | MISSING | domain read path exists |
| rename/delete/rollback text | MISSING | domain `store.rs:203/216/353` |
| compare/merge versions | MISSING | domain `merge.rs` |
| getActiveVersion | MISSING | **actor `active_version_id` exists — dispatch arm only** |
| set/ensure active version | MISSING | domain exists |
| listVersions / createNamedVersion / forkVersion | MISSING | domain `store.rs:593/823`, `secrets.rs:645` |
| listMoments / getMoment | MISSING | domain `store.rs:616/783` |
| listSecretFiles / materializeSecretFile | MISSING | domain `secrets.rs:547/526` |
| secret moments/compare/restore | MISSING | domain `secrets.rs:582/614/1468/1517/1584` |
| CHATS (threads/messages/channels/feed/follows/bookmarks/reactions/mentions/decisions/dispatch) | ALL MISSING | **complete domain `chats.rs:744-2004`; nothing on the actor** |
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
  versionedText.list, versionedBinary.read, secrets.list/materialize. Domain
  logic all exists; each needs an actor passthrough + dispatch arm + tests.
- **RPC-B (chats):** expose `LinkedChatStore` through the actor. Largest
  surface; purely mechanical since R09's domain is complete and reviewed.
- **RPC-C (ydoc session):** implement the session protocol daemon-side over
  the `ydoc.apply` primitive + collab crate (port `ydocLoopbackEngine`
  semantics). Deepest design work; needs the wire contract's event side.
- **RPC-D (mutating text/version surface):** rename/delete/rollback,
  compare/merge, create/fork/set-active version, secret writes via RPC.
  Interacts with the capture OWNERSHIP model — write RPCs must carry proper
  origins (never the reserved `capture`).
- **RPC-E (replication/relay):** general applyReplicationOp + relay sync
  orchestration. Coordinate with the backend-modes doc; may be post-cutover
  depending on the R15 scope Ice picks.

Cutover-blocking order per desktop usage weight: A → B → C, then D; E per
Ice's R15 scope decision.
