//! The workspace engine daemon: composes the engine crates behind the protocol.

#![forbid(unsafe_code)]

mod automation_recovery;
pub(crate) mod capture_driver;
pub mod capture_sink;
mod events;
#[doc(hidden)]
pub mod live_application_ingress;
pub mod root_binding;
mod rpc;

#[cfg(feature = "harness")]
pub use capture_driver::{CaptureApplyProbe, EARLY_IMPORT_MIN_ADDED_FILES};
pub use capture_sink::{SelfWriteSuppression, StoreCaptureSink};
pub use events::AUTOMATION_CLAIMED_EVENT;
pub use events::CAPTURE_INITIAL_SETTLED_EVENT;
pub use events::CAPTURE_MOMENT_RECORDED_EVENT;
pub use events::EngineEventNotice;
pub use events::EngineEvents;
pub use events::RECORD_CREATED_EVENT;
pub use events::RECORD_FIELD_CHANGED_EVENT;
pub use events::RECORD_UPDATED_EVENT;
pub use rpc::configured_live_host::ConfiguredLiveHostConfig;
pub use rpc::conflicts::RESOLVE_ANSWER_SCAFFOLDING_BYTES;
#[doc(hidden)]
pub use rpc::live_application::{LiveApplicationHostConfig, LiveApplicationInput};
pub use rpc::ordinary_live_host::OrdinaryLiveHostConfig;

use crate::rpc::reads::BLOB_EGRESS_BYTE_BUDGET;
use crate::rpc::reads::BlobEgressBudget;
use crate::rpc::relay::PendingCursor;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::ydoc::YdocSession;
use dohc_engine_collab::LeaseRegistry;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::EngineService as ProtocolEngineService;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::transport::ServiceResponse;
use dohc_engine_protocol::wire::Request;
use dohc_engine_protocol::wire::WorkspaceHandle;
#[cfg(test)]
use dohc_engine_runtime::FaultInjector;
use dohc_engine_runtime::WorkspaceSupervisor;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

/// Protocol service composing domain operations on the runtime actor's sole
/// writable `EngineStore` connection.
///
/// INVARIANT: exactly one `EngineService` owns each live physical `engine.db`.
/// Read-intent opens get non-owning handles over that service's binding;
/// cross-service or aliased attachments remain rejected so barriers cannot split.
pub struct EngineService {
    supervisor: &'static WorkspaceSupervisor,
    handles: Mutex<HashMap<WorkspaceHandle, Arc<OpenWorkspace>>>,
    live_applications: Mutex<rpc::live_application::Registry>,
    configured_live_host: std::sync::OnceLock<rpc::configured_live_host::Discovery>,
    ordinary_live_host: std::sync::OnceLock<rpc::ordinary_live_host::OrdinaryHost>,
    pending_cursors: Mutex<HashMap<String, PendingCursor>>,
    open_lock: Arc<tokio::sync::Mutex<()>>,
    next_handle: std::sync::atomic::AtomicU64,
    sessions: Arc<Mutex<HashMap<String, YdocSession>>>,
    leases: LeaseRegistry,
    next_session: std::sync::atomic::AtomicU64,
    /// Unique per service instance (process id + construction time):
    /// session ids seed client-side idempotency keys that persist in
    /// `engine_requests`, so ids restarting from 1 each daemon lifetime
    /// would collide a fresh session's first requests with a prior
    /// lifetime's ledger rows (hash-mismatch refusals or false dedupes).
    session_epoch: String,
    self_writes: SelfWriteSuppression,
    events: EngineEvents,
    capture_apply_probe: Option<capture_driver::CaptureApplyProbe>,
    #[cfg(test)]
    owner_outbox_append_probe: Option<(
        Arc<tokio::sync::Notify>,
        Arc<tokio::sync::Notify>,
        Arc<std::sync::atomic::AtomicBool>,
    )>,
    /// Faults for the root-binding stamp a fresh open writes.
    #[cfg(test)]
    bind_root_faults: Option<Arc<dyn FaultInjector>>,
    /// PER-EngineService by design. Production runs exactly one EngineService per
    /// daemon process (the stdio host constructs a single service), so the
    /// `BLOB_EGRESS_BYTE_BUDGET` resident-memory ceiling is per-process there.
    /// The budget is per-instance (not a process-global static) so tests can
    /// inject a small deterministic budget; if a future host ever runs multiple
    /// EngineServices in one process, back this with a shared/global semaphore to
    /// keep the ceiling aggregate.
    blob_egress_budget: BlobEgressBudget,
}

impl Default for EngineService {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolEngineService for EngineService {
    type Input = LiveApplicationInput;

    async fn call_with_input(
        &self,
        ctx: RequestContext,
        request: Request,
        input: Option<Self::Input>,
    ) -> Result<ServiceResponse, WireError> {
        match input {
            Some(input) => self.dispatch_input(ctx, request, input).await,
            None => self.dispatch(ctx, request).await,
        }
    }
    async fn call(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        self.dispatch(ctx, request).await
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl EngineService {
    pub fn new() -> Self {
        Self::with_supervisor(WorkspaceSupervisor::global())
    }

    /// Harness-only deterministic session namespace for paired actor tests.
    #[cfg(feature = "harness")]
    #[doc(hidden)]
    pub fn with_session_epoch_for_harness(session_epoch: impl Into<String>) -> Self {
        let mut service = Self::new();
        service.session_epoch = session_epoch.into();
        service
    }

    fn with_supervisor(supervisor: &'static WorkspaceSupervisor) -> Self {
        EngineService {
            supervisor,
            handles: Mutex::new(HashMap::new()),
            live_applications: Mutex::new(rpc::live_application::Registry::default()),
            configured_live_host: std::sync::OnceLock::new(),
            ordinary_live_host: std::sync::OnceLock::new(),
            pending_cursors: Mutex::new(HashMap::new()),
            open_lock: Arc::new(tokio::sync::Mutex::new(())),
            next_handle: std::sync::atomic::AtomicU64::new(1),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            leases: {
                // One process-wide registry remains a defense in depth for
                // non-service actor users. EngineService itself rejects a
                // second attachment to an already-live physical engine.db, so
                // one service owns all session admission for that actor.
                static GLOBAL_LEASES: std::sync::LazyLock<LeaseRegistry> =
                    std::sync::LazyLock::new(LeaseRegistry::new);
                GLOBAL_LEASES.clone()
            },
            next_session: std::sync::atomic::AtomicU64::new(1),
            session_epoch: {
                // pid + boot-ms + a PROCESS-GLOBAL instance counter: two
                // services constructed in the same millisecond must still
                // mint disjoint session ids (they seed persisted
                // idempotency keys).
                static INSTANCE: std::sync::atomic::AtomicU64 =
                    std::sync::atomic::AtomicU64::new(0);
                let instance = INSTANCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let boot_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis())
                    .unwrap_or(0);
                format!("{:x}-{boot_ms:x}-{instance:x}", std::process::id())
            },
            self_writes: {
                // Process-wide so suppression survives service replacement
                // during close/reopen and remains collision-safe across
                // distinct workspaces (keys include the scoped root).
                static GLOBAL_SELF_WRITES: std::sync::LazyLock<SelfWriteSuppression> =
                    std::sync::LazyLock::new(SelfWriteSuppression::default);
                GLOBAL_SELF_WRITES.clone()
            },
            events: EngineEvents::default(),
            capture_apply_probe: None,
            #[cfg(test)]
            owner_outbox_append_probe: None,
            #[cfg(test)]
            bind_root_faults: None,
            blob_egress_budget: BlobEgressBudget::new(BLOB_EGRESS_BYTE_BUDGET),
        }
    }

    #[cfg(feature = "harness")]
    pub fn with_capture_apply_probe_for_harness(probe: CaptureApplyProbe) -> Self {
        let mut service = Self::new();
        service.capture_apply_probe = Some(probe);
        service
    }
}
