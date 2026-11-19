//! On Windows a file keeps its DACL when it is renamed, so a file staged
//! from the workspace stays open to everyone its own DACL admits, by its
//! full path, however private the staging folder is. A file that stays
//! staged has its DACL saved, in a FULL commit, and is then made private.
//! Before it leaves staging it gets the saved DACL back, through a handle
//! checked against the file's identity, so it never reaches the workspace
//! with dohc's DACL. A file with other names, or that another account owns,
//! is left as it is, with the reason saved.
//!
//! A file is open as before for the moment between its stage and the
//! judgement that it stays, between getting its DACL back and leaving, and
//! whenever a security call fails.

use super::{MaterializeError, is_staged_name};
use dohc_engine_storage::{EngineStore, StagedDacl};
use dohc_windows_files::{
    StagedSecurity, ensure_private_staging_dir, file_identity, make_staged_private, read_staged,
    restore_dacl,
};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Save the DACL of the file staged at `path` unless one is saved, then make
/// the file private. Returns the file's identity, or `None` when no regular
/// file is there or its volume keeps no DACL.
pub(super) fn keep_private(
    store: &EngineStore,
    path: &Path,
    now_ms: i64,
) -> Result<Option<String>, MaterializeError> {
    let io = |err: std::io::Error| MaterializeError::io(path, &err);
    let Some(staged) = read_staged(path).map_err(io)? else {
        return Ok(None);
    };
    let saved = store.staged_dacl(&staged.identity)?;
    let keep = match staged.security {
        StagedSecurity::Own { dacl, private } => {
            if !matches!(saved, Some(StagedDacl::Saved(_))) {
                store.save_staged_dacl(&staged.identity, &StagedDacl::Saved(dacl), now_ms)?;
            }
            !private
        }
        StagedSecurity::Left(reason) => {
            let left = StagedDacl::Left(reason.code().to_owned());
            if !matches!(saved, Some(StagedDacl::Saved(_))) && saved.as_ref() != Some(&left) {
                store.save_staged_dacl(&staged.identity, &left, now_ms)?;
            }
            false
        }
    };
    if keep {
        make_staged_private(path, &staged.identity).map_err(io)?;
    }
    Ok(Some(staged.identity))
}

/// [`keep_private`] for a file that stays staged after a failure, which
/// leaves the file as it was. Only a storage failure stops the caller.
pub(super) fn try_keep_private(
    store: &EngineStore,
    path: &Path,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    match keep_private(store, path, now_ms) {
        Err(MaterializeError::Storage(err)) => Err(err.into()),
        Err(error) => {
            eprintln!("staged file privacy: {error}");
            Ok(())
        }
        Ok(_) => Ok(()),
    }
}

/// Make every staged file in `dirs` private, and each folder dohc stages
/// into beside the workspace private on its own. When `whole` says `dirs`
/// are every staging folder, and each one and each file in it was read, a
/// saved DACL whose file is no longer staged is forgotten.
pub(super) fn keep_all_private(
    store: &EngineStore,
    dirs: &[PathBuf],
    whole: bool,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    let mut seen = HashSet::new();
    let mut whole = whole;
    for dir in dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => {
                eprintln!("staged file privacy {}: {err}", dir.display());
                whole = false;
                continue;
            }
        };
        if dir.file_name() == Some(OsStr::new(".dohc-write-displaced"))
            && let Err(err) = ensure_private_staging_dir(dir)
        {
            eprintln!("staging folder privacy {}: {err}", dir.display());
        }
        for entry in entries {
            let Ok(entry) = entry else {
                whole = false;
                continue;
            };
            if !entry.file_name().to_str().is_some_and(is_staged_name) {
                continue;
            }
            match keep_private(store, &entry.path(), now_ms) {
                Ok(identity) => seen.extend(identity),
                Err(MaterializeError::Storage(err)) => return Err(err.into()),
                Err(error) => {
                    eprintln!("staged file privacy: {error}");
                    whole = false;
                }
            }
        }
    }
    if whole {
        let gone: Vec<String> = store
            .staged_dacl_identities()?
            .into_iter()
            .filter(|identity| !seen.contains(identity))
            .collect();
        store.forget_staged_dacls(&gone)?;
    }
    Ok(())
}

/// Move the file staged at `staged` out of staging with `leave`, which
/// returns whether it moved. A saved DACL goes back on the file first, and
/// is forgotten once the file is gone from staging. A file that stays is
/// made private again.
pub(super) fn leave(
    store: &EngineStore,
    staged: &Path,
    now_ms: i64,
    leave: impl FnOnce() -> Result<bool, MaterializeError>,
) -> Result<bool, MaterializeError> {
    let io = |err: std::io::Error| MaterializeError::io(staged, &err);
    let Some(identity) = file_identity(staged).map_err(io)? else {
        return leave();
    };
    let saved = match store.staged_dacl(&identity)? {
        None => return leave(),
        Some(StagedDacl::Saved(dacl)) => {
            restore_dacl(staged, &identity, &dacl).map_err(io)?;
            true
        }
        Some(StagedDacl::Left(_)) => false,
    };
    let left = leave();
    match left {
        Ok(true) => store.forget_staged_dacls(&[identity])?,
        _ if saved => try_keep_private(store, staged, now_ms)?,
        _ => {}
    }
    left
}
