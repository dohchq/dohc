//! R10 replication, cursor, share, and relay-client substrate.
//!
//! This core crate owns durable operation coordinates and their crash
//! boundaries. It deliberately has no HTTP, async runtime, thread, process, or
//! filesystem implementation: [`RelayTransport`] is the runtime seam R13 will
//! implement. All SQLite access borrows [`EngineStore`] through `read_with` or
//! `write_with`; no second connection is opened.

#![forbid(unsafe_code)]

mod apply;
mod conflict_apply;
mod cursor;
mod error;
mod hydration;
mod journal;
mod model;
mod path_policy;
mod relay;
mod secret_apply;
mod share;
mod ydoc_apply;

pub use apply::{ApplyOutcome, apply_chat_envelope, apply_envelope_with};
pub use conflict_apply::{
    ConflictApplyResult, PendingResolve, PendingResolveReason, apply_conflict_envelope,
};
pub use cursor::{
    CursorKind, RelayCursor, SharedPeerPosition, commit_relay_cursor, read_pushed_seq,
    read_relay_cursor, read_shared_peer_position,
};
pub use error::{RelayError, SyncError};
pub use hydration::{BlobContent, BlobHydration, hydrate_blob_content};
pub use journal::{
    SyncIdentity, ack_replication_peer, journal_local_replication_op, list_replication_ops,
    read_replication_acked_seq, read_sync_identity,
};
pub use model::{MAX_PULL_OPS, MAX_PUSH_OPS_PER_BATCH, MAX_WIRE_INTEGER, ReplicationEnvelope};
pub use path_policy::{PathClass, classify_share_path};
pub use relay::{
    ClaimRequest, ClaimResponse, KeyEnvelopeRequest, KeyEnvelopeResponse, ProbeRequest,
    ProbeResponse, PullRequest, PullResponse, PushRequest, PushResponse, RecoverRequest,
    RecoverResponse, RelaySyncClient, RelayTransport, ShareViewRequest, ShareViewResponse,
    SharedChannelRequest, SharedChannelResponse, SyncPassOutcome,
};
pub use secret_apply::apply_secret_envelope;
pub use share::{ShareBoundary, ShareSurface, apply_shared_envelope};
pub use ydoc_apply::{
    LeaseProbe, NoLiveLeases, YdocApplyResult, apply_ydoc_envelope, drain_deferred_ydoc_for_key,
};

pub use dohc_engine_storage::{FaultInjector, FaultPoint, NoFaults};

#[cfg(test)]
mod tests;
