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
}

impl RuntimeError {
    /// The stable machine code, preserving the storage code where wrapped.
    pub fn code(&self) -> &'static str {
        match self {
            RuntimeError::Identity { .. } => "identity-unresolved",
            RuntimeError::Storage(err) => err.code(),
            RuntimeError::ThreadSpawn(_) => "thread-spawn-failed",
            RuntimeError::ActorUnavailable => "actor-unavailable",
            RuntimeError::Overloaded => "overloaded",
            RuntimeError::WorkerPanicked => "worker-panicked",
        }
    }
}
