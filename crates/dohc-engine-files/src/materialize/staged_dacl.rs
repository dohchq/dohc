//! On Windows a file keeps its DACL when it is renamed, so a file staged
//! from the workspace stays open to everyone its own DACL admits, by its
//! full path, however private the staging folder is. A file that stays
//! staged has its DACL saved, in a FULL commit, and is then made private.
//! A file with other names, or that another account owns, is left as it is,
//! with the reason saved. What is saved is replaced only while the file has
//! a DACL of its own: one with dohc's private DACL keeps what was saved.
//!
//! Before a file leaves staging, dohc holds the staging folder, so neither
//! it nor a folder above it can be renamed until the file has moved. The
//! file gets the saved DACL back if it has dohc's, and what was saved is
//! forgotten in a FULL commit. Only then does it move, and a file that does
//! not move is made private again. So a process crash leaves either a
//! private file with its DACL saved, or a file with its own DACL. After a
//! power loss, a file staged on another volume than the store can come back
//! with the private DACL, when that volume had not written its DACL before
//! the store wrote the forget. A saved DACL Windows can no longer read is
//! forgotten, and the file leaves private.
//!
//! What was saved for a folder's files is forgotten only once every file in
//! that folder was read, or the folder was removed empty. A missing folder
//! keeps what was saved for its files.
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
    LeftReason, Restricted, ensure_private_staging_dir, hold_staging_dir, make_staged_private,
    read_staged, restore_dacl,
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

/// The staging folder `dir` as what was saved for its files names it, the
/// same with either slash and with or without the `\\?\` prefix. Case is
/// kept, so two folders whose names differ only in case stay apart.
fn folder(dir: &Path) -> String {
    let text = dir.to_string_lossy().replace('/', "\\");
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
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
    let directory = folder(path.parent().unwrap_or(path));
    let record = staged.left.map_or(StagedDacl::Saved(staged.dacl), left);
    if store.staged_dacl(&staged.identity)?.as_ref() != Some(&record) {
        store.save_staged_dacl(&staged.identity, &directory, &record, now_ms)?;
    }
    if staged.left.is_none()
        && let Restricted::Left(reason) = make_staged_private(path, &staged.identity).map_err(io)?
    {
        store.save_staged_dacl(&staged.identity, &directory, &left(reason), now_ms)?;
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
/// into beside the workspace private on its own. In a folder where every
/// file was read, a saved DACL whose file is no longer there is forgotten.
pub(super) fn keep_all_private(
    store: &EngineStore,
    dirs: &[PathBuf],
    now_ms: i64,
) -> Result<(), MaterializeError> {
    for dir in dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(err) => {
                if err.kind() != ErrorKind::NotFound {
                    eprintln!("staged file privacy {}: {err}", dir.display());
                }
                continue;
            }
        };
        if dir.file_name() == Some(OsStr::new(SIBLING))
            && let Err(err) = ensure_private_staging_dir(dir)
        {
            eprintln!("staging folder privacy {}: {err}", dir.display());
        }
        let mut seen = HashSet::new();
        let mut read = true;
        for entry in entries {
            let Ok(entry) = entry else {
                read = false;
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
                    read = false;
                }
            }
        }
        if read {
            let gone: Vec<String> = store
                .staged_dacls_in(&folder(dir))?
                .into_iter()
                .filter(|identity| !seen.contains(identity))
                .collect();
            store.forget_staged_dacls(&gone)?;
        }
    }
    Ok(())
}

/// Whether something is saved for a file staged in `dir`.
pub(super) fn saved_in(store: &EngineStore, dir: &Path) -> Result<bool, MaterializeError> {
    Ok(!store.staged_dacls_in(&folder(dir))?.is_empty())
}

/// Forget what was saved for the files of `dir`, which dohc removed empty.
pub(super) fn forget_folder(store: &EngineStore, dir: &Path) -> Result<(), MaterializeError> {
    Ok(store.forget_staged_dacls(&store.staged_dacls_in(&folder(dir))?)?)
}

/// Move the file staged at `staged` out of staging with `leave`, which
/// returns whether it moved, while its staging folder is held. A file with
/// dohc's DACL gets the saved one back first, and what was saved is
/// forgotten before it moves. A file that stays is made private again.
pub(super) fn leave(
    store: &EngineStore,
    staged: &Path,
    now_ms: i64,
    leave: impl FnOnce() -> Result<bool, MaterializeError>,
) -> Result<bool, MaterializeError> {
    let io = |err: std::io::Error| MaterializeError::io(staged, &err);
    let _held = match staged.parent() {
        Some(dir) => hold_staging_dir(dir).map_err(io)?,
        None => None,
    };
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
    if let Some(saved) = store.staged_dacl(&file.identity)? {
        if let StagedDacl::Saved(dacl) = &saved
            && file.private
        {
            match restore_dacl(staged, &file.identity, dacl) {
                Ok(true) => {}
                Ok(false) => {
                    return Err(io(std::io::Error::other(
                        "another file is at the staged name",
                    )));
                }
                Err(err) if err.kind() == ErrorKind::InvalidData => {
                    eprintln!("staged file DACL {}: {err}", staged.display());
                }
                Err(err) => return Err(io(err)),
            }
        }
        store.forget_staged_dacls(std::slice::from_ref(&file.identity))?;
    }
    let left = leave();
    if !matches!(left, Ok(true)) {
        try_keep_private(store, staged, now_ms)?;
    }
    left
}

#[cfg(test)]
#[test]
fn folders_whose_names_differ_only_in_case_stay_apart() {
    assert_ne!(
        folder(Path::new("C:/w/\u{130}/.dohc-write-displaced")),
        folder(Path::new("C:/w/i\u{307}/.dohc-write-displaced"))
    );
    assert_ne!(folder(Path::new("C:/w/A")), folder(Path::new("C:/w/a")));
    assert_eq!(
        folder(Path::new(r"\\?\C:\w\A")),
        folder(Path::new("C:/w/A"))
    );
}
