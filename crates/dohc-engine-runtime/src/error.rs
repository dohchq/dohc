//! Runtime error taxonomy for the workspace actor and supervisor.

use dohc_engine_storage::StorageError;

/// A typed runtime failure. Storage failures are wrapped so a caller can still
/// reach the underlying `state-corrupt`/fingerprint code.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RuntimeError {
    /// The engine.db path could not be resolved to a canonical identity
    /// (parent directory missing or not canonicalizable).
    #[error("could not resolve engine.db identity: {reason}")]
    Identity {
        reason: &'static str,
        #[source]
        source: Option<std::io::Error>,
    },

    /// A storage-layer failure (open, fingerprint fence, or a write).
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),

    /// A versioning/conflict-domain operation failed on the actor-owned store.
    #[error("domain error: {0}")]
    Domain(#[from] dohc_engine_domain::DomainError),

    /// A durable Y.Doc operation failed on the actor-owned store.
    #[error("collaboration error: {0}")]
    Collab(#[from] dohc_engine_collab::CollabError),

    /// A replicated operation failed on the actor-owned store.
    #[error("synchronization error: {0}")]
    Sync(#[from] dohc_engine_sync::SyncError),

    /// A relay request or relay-client state transition failed.
    #[error("relay error: {0}")]
    Relay(#[from] dohc_engine_sync::RelayError),

    /// An index-backed search failed on the actor-owned connection.
    #[error("search error: {0}")]
    Search(#[from] crate::search::SearchError),

    /// Projected content could not be synchronously materialized.
    #[error("materialization error: {0}")]
    Materialize(#[from] dohc_engine_files::MaterializeError),

    /// An active-version switch committed, but one or more durable projection
    /// jobs could not be applied. The destination remains active for replay.
    #[error("active-version materialization left {failed_jobs} job(s) incomplete")]
    ActiveVersionMaterializationIncomplete { failed_jobs: usize },

    /// A live scene references an authoritative binary head or blob that has
    /// not arrived yet. The Y.Doc remains canonical; callers may retry open.
    #[error("a linked artifact asset is not available yet")]
    YdocArtifactAssetsPending,

    /// A live scene's durable asset descriptor conflicts with authoritative
    /// storage. The Y.Doc remains canonical and must not fall back to disk.
    #[error("a linked artifact asset is invalid")]
    YdocArtifactAssetsInvalid,

    /// The actor's worker thread could not be spawned.
    #[error("could not spawn actor worker thread")]
    ThreadSpawn(#[source] std::io::Error),

    /// The actor is no longer accepting commands (closed or its worker thread
    /// ended). The caller should treat its handle as stale.
    #[error("workspace actor is unavailable")]
    ActorUnavailable,

    /// The actor's bounded command queue is full. Explicit backpressure — the
    /// protocol's `OVERLOADED` (`plan §Rust policy`: bounded everything, no
    /// unbounded growth). Retry after backoff.
    #[error("workspace actor command queue is full")]
    Overloaded,

    /// The actor's worker thread panicked; the connection was released by
    /// unwinding but the session is dead.
    #[error("workspace actor worker thread panicked")]
    WorkerPanicked,

    /// A request's deadline elapsed before the operation completed. The
    /// operation's cancellation token was tripped; work already committed
    /// stays durable (exactly-once ack — `PORTING.md` §12).
    #[error("request deadline elapsed")]
    DeadlineExceeded,

    /// Cooperative cancellation won between bounded units.
    #[error("request cancelled")]
    Cancelled,

    /// A fault-injected domain transaction crashed before acknowledgement.
    #[error("operation crashed before acknowledgement")]
    OperationCrashed,
}

impl RuntimeError {
    /// The stable machine code, preserving the storage code where wrapped.
    pub fn code(&self) -> &'static str {
        match self {
            RuntimeError::Identity { .. } => "identity-unresolved",
            RuntimeError::Storage(err) => err.code(),
            RuntimeError::Domain(err) => err.code(),
            RuntimeError::Collab(err) => err.code(),
            RuntimeError::Sync(err) => err.code(),
            RuntimeError::Relay(_) => "relay-failed",
            RuntimeError::Search(err) => err.code(),
            RuntimeError::Materialize(_) => "materialize-failed",
            RuntimeError::ActiveVersionMaterializationIncomplete { .. } => "materialize-failed",
            RuntimeError::YdocArtifactAssetsPending => "ydoc-artifact-assets-pending",
            RuntimeError::YdocArtifactAssetsInvalid => "ydoc-artifact-assets-invalid",
            RuntimeError::ThreadSpawn(_) => "thread-spawn-failed",
            RuntimeError::ActorUnavailable => "actor-unavailable",
            RuntimeError::Overloaded => "overloaded",
            RuntimeError::WorkerPanicked => "worker-panicked",
            RuntimeError::DeadlineExceeded => "deadline-exceeded",
            RuntimeError::Cancelled => "cancelled",
            RuntimeError::OperationCrashed => "operation-crashed",
        }
    }
}
