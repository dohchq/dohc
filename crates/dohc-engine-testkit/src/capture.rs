//! Capture fixtures that exercise the guarded production actor API.

use dohc_engine_collab::LeaseRegistry;
use dohc_engine_domain::{CaptureSecretRetire, SecretMomentRecord};
use dohc_engine_runtime::{
    ActorHandle, CaptureRetire, CaptureRetireResult, RuntimeError, WorkspaceRootGuard,
};
use dohc_engine_storage::FaultInjector;
use std::path::Path;
use std::sync::Arc;

/// Require the fixture workspace directory to remain present.
pub struct ExistingRootGuard;

impl WorkspaceRootGuard for ExistingRootGuard {
    fn validate(&self, root: &Path) -> Result<(), RuntimeError> {
        root.is_dir().then_some(()).ok_or(RuntimeError::Identity {
            reason: "test workspace root disappeared",
            source: None,
        })
    }
}

/// Retire a fixture through the production guard and materialization path.
pub async fn retire_captured_path(
    actor: &ActorHandle,
    input: CaptureRetire,
    root: &Path,
    leases: LeaseRegistry,
    faults: Arc<dyn FaultInjector>,
) -> Result<CaptureRetireResult, RuntimeError> {
    let actor = actor.clone();
    let root = root.to_path_buf();
    let retire = std::thread::spawn(move || {
        actor.capture_retire_materialized_blocking_guarded(
            input,
            root,
            false,
            Arc::new(()),
            leases,
            faults,
            Arc::new(ExistingRootGuard),
        )
    });
    tokio::task::spawn_blocking(move || retire.join())
        .await
        .expect("await capture retire fixture")
        .expect("join capture retire fixture")
}

/// Retire a secret fixture through the production root guard.
pub async fn retire_captured_secret(
    actor: &ActorHandle,
    input: CaptureSecretRetire,
    root: &Path,
    faults: Arc<dyn FaultInjector>,
) -> Result<Option<SecretMomentRecord>, RuntimeError> {
    let actor = actor.clone();
    let root = root.to_path_buf();
    let retire = std::thread::spawn(move || {
        actor.capture_secret_retire_blocking_guarded(
            input,
            root,
            faults,
            Arc::new(ExistingRootGuard),
        )
    });
    tokio::task::spawn_blocking(move || retire.join())
        .await
        .expect("await capture secret retire fixture")
        .expect("join capture secret retire fixture")
}
