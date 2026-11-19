//! On Windows a file keeps its DACL when it is renamed, so a file staged
//! from the workspace stays open to everyone its own DACL admits, by its
//! full path, however private the staging folder is. A file that stays
//! staged has its DACL saved, in a FULL commit, and is then made private.
//! A file with other names, or that another account owns, is left as it is,
//! with the reason saved. What is saved is replaced only while the file has
//! a DACL of its own: one with dohc's private DACL keeps what was saved.
//!
//! Before a file leaves staging, it gets the saved DACL back if it has
//! dohc's, and what was saved is forgotten in a FULL commit. Only then does
//! it move, and a file that does not move is made private again. So a crash
//! leaves either a private file with its DACL saved, or a file with its own
//! DACL.
//!
//! A file is open as before for the moment between its stage and the
//! judgement that it stays, between getting its DACL back and leaving, and
//! whenever a security call fails. After a storage failure, a job's staged
//! file waits for the next sweep. Windows has no way to stop another program
//! adding a name to a file, so a name added between the check on the handle
//! that changes the DACL and the change is restricted with it.

use super::{MaterializeError, is_staged_name};
use dohc_engine_storage::{EngineStore, StagedDacl};
use dohc_windows_files::{
    LeftReason, Restricted, ensure_private_staging_dir, make_staged_private, read_staged,
    restore_dacl,
};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The folder dohc stages into beside the workspace.
const SIBLING: &str = ".dohc-write-displaced";

fn left(reason: LeftReason) -> StagedDacl {
    StagedDacl::Left(reason.code().to_owned())
}

/// Save the DACL of the file staged at `path` while it has its own, then
/// make the file private. Returns the file's identity, or `None` when no
/// regular file is there or its volume keeps no DACL.
pub(super) fn keep_private(
    store: &EngineStore,
    path: &Path,
    now_ms: i64,
) -> Result<Option<String>, MaterializeError> {
    let io = |err: std::io::Error| MaterializeError::io(path, &err);
    let Some(staged) = read_staged(path).map_err(io)? else {
        return Ok(None);
    };
    if staged.private {
        return Ok(Some(staged.identity));
    }
    let record = staged.left.map_or(StagedDacl::Saved(staged.dacl), left);
    if store.staged_dacl(&staged.identity)?.as_ref() != Some(&record) {
        store.save_staged_dacl(&staged.identity, &record, now_ms)?;
    }
    if staged.left.is_none()
        && let Restricted::Left(reason) = make_staged_private(path, &staged.identity).map_err(io)?
    {
        store.save_staged_dacl(&staged.identity, &left(reason), now_ms)?;
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
/// are every staging folder, and each folder beside the workspace is there
/// and each file in every one was read, a saved DACL whose file is no longer
/// staged is forgotten.
pub(super) fn keep_all_private(
    store: &EngineStore,
    dirs: &[PathBuf],
    whole: bool,
    now_ms: i64,
) -> Result<(), MaterializeError> {
    let mut seen = HashSet::new();
    let mut whole = whole;
    for dir in dirs {
        let sibling = dir.file_name() == Some(OsStr::new(SIBLING));
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) if err.kind() == ErrorKind::NotFound => {
                whole &= !sibling;
                continue;
            }
            Err(err) => {
                eprintln!("staged file privacy {}: {err}", dir.display());
                whole = false;
                continue;
            }
        };
        if sibling && let Err(err) = ensure_private_staging_dir(dir) {
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
/// returns whether it moved. A file with dohc's DACL gets the saved one back
/// first, and what was saved is forgotten before it moves. A file that stays
/// is made private again.
pub(super) fn leave(
    store: &EngineStore,
    staged: &Path,
    now_ms: i64,
    leave: impl FnOnce() -> Result<bool, MaterializeError>,
) -> Result<bool, MaterializeError> {
    let io = |err: std::io::Error| MaterializeError::io(staged, &err);
    let file = match read_staged(staged) {
        Err(err)
            if matches!(
                err.kind(),
                ErrorKind::PermissionDenied | ErrorKind::Unsupported
            ) =>
        {
            None
        }
        read => read.map_err(io)?,
    };
    let Some(file) = file else {
        return leave();
    };
    let Some(saved) = store.staged_dacl(&file.identity)? else {
        return leave();
    };
    if let StagedDacl::Saved(dacl) = &saved
        && file.private
        && !restore_dacl(staged, &file.identity, dacl).map_err(io)?
    {
        return Err(io(std::io::Error::other(
            "another file is at the staged name",
        )));
    }
    store.forget_staged_dacls(std::slice::from_ref(&file.identity))?;
    let left = leave();
    if !matches!(left, Ok(true)) {
        try_keep_private(store, staged, now_ms)?;
    }
    left
}
