use super::EngineDbIdentity;
use crate::RuntimeError;
use dohc_engine_storage::StorageError;
use dohc_engine_sync::SyncError;
use std::cell::{Cell, RefCell};
use std::path::PathBuf;

thread_local! {
    static STORE: RefCell<Option<(PathBuf, EngineDbIdentity)>> = const { RefCell::new(None) };
    static CHECKED: Cell<bool> = const { Cell::new(false) };
}

pub(super) fn install(
    path: PathBuf,
    identity: EngineDbIdentity,
    bound: bool,
) -> Result<(), StorageError> {
    let workspace_store = path.parent().is_some_and(|engine| {
        engine.file_name().is_some_and(|name| name == "engine")
            && engine
                .parent()
                .and_then(std::path::Path::file_name)
                .is_some_and(|name| name == ".dohc")
    });
    if workspace_store {
        let named = std::path::absolute(path).map_err(StorageError::persist_public)?;
        STORE.with(|store| *store.borrow_mut() = Some((named, identity)));
        dohc_engine_sync::install_moment_store_check(check);
    } else if bound {
        return Err(StorageError::InvalidInput {
            reason: "workspace store is outside its workspace folder",
        });
    }
    Ok(())
}

pub(super) fn begin_command() {
    CHECKED.set(false);
}

fn check() -> Result<(), SyncError> {
    if CHECKED.get() {
        return Ok(());
    }
    let moved = STORE.with(|store| {
        store.borrow().as_ref().is_some_and(|(path, identity)| {
            EngineDbIdentity::of_existing(path).ok().as_ref() != Some(identity)
        })
    });
    if moved {
        return Err(SyncError::InvalidInput {
            reason: "workspace-folder-moved",
        });
    }
    CHECKED.set(true);
    Ok(())
}

pub(super) fn check_root() -> Result<(), RuntimeError> {
    check().map_err(RuntimeError::from)
}
