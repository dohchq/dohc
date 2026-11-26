use dohc_engine_collab::WriterDocCache;
use dohc_engine_storage::{EngineStore, FaultInjector};

use crate::SyncError;

pub fn replay_kept_format_two(
    _store: &mut EngineStore,
    _cache: &mut WriterDocCache,
    _faults: &dyn FaultInjector,
) -> Result<usize, SyncError> {
    Ok(0)
}

#[cfg(test)]
pub(crate) fn replaying<R>(run: impl FnOnce() -> R) -> R {
    run()
}
