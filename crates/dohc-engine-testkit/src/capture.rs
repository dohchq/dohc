//! Capture fixtures that exercise the guarded production actor API.

use dohc_engine_runtime::{RuntimeError, WorkspaceRootGuard};
use std::path::Path;

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
