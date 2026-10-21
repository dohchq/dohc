//! Binds a workspace root to its engine database.
//!
//! The first full open of a root mints a random token, writes it to
//! `.dohc/engine/ROOT_BINDING`, and stamps it into `engine.db`. Every later
//! open compares the two, so an `engine.db` copied under another root is
//! refused instead of adopted. The storage fingerprint fence independently
//! rejects foreign databases before any migration runs.
//!
//! An open that writes also prepares `.dohc/local`, the folder for what
//! belongs to this computer rather than the workspace.

use std::path::{Path, PathBuf};

pub const ROOT_BINDING_RELATIVE_PATH: &str = ".dohc/engine/ROOT_BINDING";
pub const LOCAL_STATE_RELATIVE_PATH: &str = ".dohc/local";
const TOKEN_HEX_LEN: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum RootBindingError {
    #[error("workspace root is unavailable")]
    RootUnavailable,
    #[error("workspace root binding is malformed")]
    Malformed,
    #[error("workspace root binding is unreadable")]
    Unreadable,
    #[error("workspace root binding could not be written")]
    Unwritable,
    #[error("engine database could not record its root binding")]
    Unstamped,
    #[error("engine database is bound to another root")]
    DatabaseMismatch,
    #[error("this computer's folder in .dohc could not be created")]
    LocalStateUnwritable,
    /// `.dohc/local` is a link or not a folder. On a Mac, `NotPrivate`
    /// names it, with the same message.
    #[cfg(not(target_os = "macos"))]
    #[error("engine-folder-not-private: {0} .dohc/local")]
    LocalStateNotFolder(&'static str),
    /// macOS refused dohc the root's folder. See
    /// [`dohc_engine_files::privacy_denied`].
    #[error("{}", dohc_engine_files::PRIVACY_DENIED)]
    PrivacyDenied,
    /// The volume keeps ACL entries on the engine's folder, as a network
    /// share can, so the store in it cannot be kept private.
    #[error("volume-shares-new-files")]
    VolumeSharesNewFiles,
    /// `.dohc` or the engine's folder is a link, is not a folder, or is
    /// another user's, so the store in it cannot be kept private.
    #[cfg(target_os = "macos")]
    #[error("{0}")]
    NotPrivate(dohc_macos_files::NotPrivate),
}

/// A macOS privacy refusal at `path`, a volume that shares new files, or a
/// folder dohc refuses to keep private names itself; any other io failure is
/// `otherwise`.
fn io_failure(
    path: &Path,
    otherwise: RootBindingError,
) -> impl FnOnce(std::io::Error) -> RootBindingError {
    move |error| {
        #[cfg(target_os = "macos")]
        if dohc_macos_files::volume_shares_new_files(&error) {
            return RootBindingError::VolumeSharesNewFiles;
        }
        #[cfg(target_os = "macos")]
        if let Some(refused) = dohc_macos_files::not_private(&error) {
            return RootBindingError::NotPrivate(refused.clone());
        }
        if dohc_engine_files::privacy_denied(&error, path) {
            RootBindingError::PrivacyDenied
        } else {
            otherwise
        }
    }
}

/// Canonicalize a root without creating anything.
pub fn canonical_root(root: &Path) -> Result<PathBuf, RootBindingError> {
    std::fs::canonicalize(root).map_err(io_failure(root, RootBindingError::RootUnavailable))
}

/// The root's binding token, or `None` when the root has never been bound.
/// An empty marker is a mint that created the file and never wrote it, so
/// it binds nothing either.
pub fn read_root_binding(root: &Path) -> Result<Option<String>, RootBindingError> {
    let marker = root.join(ROOT_BINDING_RELATIVE_PATH);
    let token = match std::fs::read(&marker) {
        Ok(token) if token.is_empty() => return Ok(None),
        Ok(token) => token,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_failure(&marker, RootBindingError::Unreadable)(error)),
    };
    if !valid_token(&token) {
        return Err(RootBindingError::Malformed);
    }
    String::from_utf8(token)
        .map(Some)
        .map_err(|_| RootBindingError::Malformed)
}

/// Serialize competing mints, then atomically publish a complete token.
/// An interrupted mint leaves only a pending file that the next owner replaces.
pub fn write_new_root_binding(root: &Path) -> Result<String, RootBindingError> {
    write_new_root_binding_with_hook(root, || {})
}

fn write_new_root_binding_with_hook(
    root: &Path,
    before_lock: impl FnOnce(),
) -> Result<String, RootBindingError> {
    let marker = root.join(ROOT_BINDING_RELATIVE_PATH);
    create_binding_dir(root)?;
    let lock = marker.with_extension("lock");
    let anchor = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock)
        .map_err(io_failure(&lock, RootBindingError::Unwritable))?;
    before_lock();
    fs4::FileExt::lock(&anchor).map_err(io_failure(&lock, RootBindingError::Unwritable))?;
    // The lock file stays in place so every process locks the same inode.
    // Read the marker only after the previous owner finishes publication.
    if let Some(token) = read_root_binding(root)? {
        sync_binding_dir(&marker)?;
        return Ok(token);
    }
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| RootBindingError::Unwritable)?;
    let token = dohc_engine_storage::hex(&bytes);
    let pending = marker.with_extension("pending");
    match std::fs::remove_file(&pending) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_failure(&pending, RootBindingError::Unwritable)(error)),
    }
    let publish = (|| {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&pending, &marker)
    })();
    if let Err(error) = publish {
        let _ = std::fs::remove_file(&pending);
        return Err(io_failure(&marker, RootBindingError::Unwritable)(error));
    }
    sync_binding_dir(&marker)?;
    Ok(token)
}

fn sync_binding_dir(marker: &Path) -> Result<(), RootBindingError> {
    #[cfg(unix)]
    std::fs::File::open(marker.parent().ok_or(RootBindingError::Unwritable)?)
        .and_then(|directory| directory.sync_all())
        .map_err(io_failure(marker, RootBindingError::Unwritable))?;
    #[cfg(not(unix))]
    let _ = marker;
    Ok(())
}

/// Record `token` as the root's binding. A test that hand-builds a store
/// before the first open uses this so the open finds a matching binding.
#[cfg(any(test, feature = "harness"))]
pub fn write_root_binding(root: &Path, token: &str) -> Result<(), RootBindingError> {
    if !valid_token(token.as_bytes()) {
        return Err(RootBindingError::Malformed);
    }
    let marker = root.join(ROOT_BINDING_RELATIVE_PATH);
    create_binding_dir(root)?;
    std::fs::write(marker, token).map_err(|_| RootBindingError::Unwritable)
}

fn create_binding_dir(root: &Path) -> Result<(), RootBindingError> {
    let relative = Path::new(ROOT_BINDING_RELATIVE_PATH)
        .parent()
        .ok_or(RootBindingError::Unwritable)?;
    let parent = &root.join(relative);
    // A mode does not limit an ACL entry, so on a Mac each open makes the
    // folder 0700 with no entries, whoever created it, and refuses a link at
    // `.dohc` or at the folder, a folder another user owns, and one a volume
    // keeps shared.
    #[cfg(target_os = "macos")]
    let created = dohc_macos_files::ensure_private_dir(root, relative).map(drop);
    #[cfg(not(target_os = "macos"))]
    let created = {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(parent)
    };
    created.map_err(io_failure(parent, RootBindingError::Unwritable))?;
    #[cfg(target_os = "macos")]
    exclude_from_icloud(parent);
    Ok(())
}

/// The engine's state belongs to this Mac. Keep the folder that holds it out
/// of iCloud Drive before any of it exists, and on each open of an older
/// workspace. A volume without extended attributes has no file provider to
/// sync it. Any other failure leaves the store syncing, so it is logged, but
/// the workspace still opens.
#[cfg(target_os = "macos")]
fn exclude_from_icloud(engine_dir: &Path) {
    let excluded = std::fs::canonicalize(engine_dir)
        .and_then(|resolved| dohc_macos_files::exclude_from_sync(&resolved));
    match excluded {
        Err(error) if error.raw_os_error() != Some(libc::ENOTSUP) => {
            eprintln!("engine: could not keep the engine folder out of iCloud Drive: {error}");
        }
        _ => {}
    }
}

/// Create `.dohc/local`, or take the one already there, and return whether
/// this computer's state can go in it. Each open that writes runs this, so a
/// folder an earlier open could not exclude is tried again.
///
/// The folder is private like the engine's, since it holds what one person
/// keeps on one computer. A link, anything but a folder, or on a Mac's local
/// volume another user's folder is refused, and what it names is left as it
/// is. On a Mac the folder is kept out of iCloud Drive before anything is
/// written in it. If that fails, the folder could sync, so it is not ready
/// and the desktop writes nothing in it, but the workspace still opens.
pub fn prepare_local_state(root: &Path) -> Result<bool, RootBindingError> {
    #[cfg(target_os = "macos")]
    {
        prepare_local_state_with(root, dohc_macos_files::exclude_from_sync)
    }
    #[cfg(not(target_os = "macos"))]
    {
        create_local_state_dir(root)?;
        Ok(true)
    }
}

#[cfg(target_os = "macos")]
fn prepare_local_state_with(
    root: &Path,
    exclude: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<bool, RootBindingError> {
    let relative = Path::new(LOCAL_STATE_RELATIVE_PATH);
    let dir = root.join(relative);
    dohc_macos_files::ensure_private_dir(root, relative)
        .map_err(io_failure(&dir, RootBindingError::LocalStateUnwritable))?;
    match exclude(&dir) {
        Ok(()) => Ok(true),
        // A volume without extended attributes has no file provider to sync it.
        Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => Ok(true),
        Err(error) => {
            eprintln!("engine: could not keep .dohc/local out of iCloud Drive: {error}");
            Ok(false)
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn create_local_state_dir(root: &Path) -> Result<(), RootBindingError> {
    let dir = root.join(LOCAL_STATE_RELATIVE_PATH);
    #[cfg(unix)]
    let created = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&dir)
    };
    #[cfg(not(unix))]
    let created = std::fs::create_dir(&dir);
    match created {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
            return Err(io_failure(&dir, RootBindingError::LocalStateUnwritable)(
                error,
            ));
        }
        _ => {}
    }
    let kind = std::fs::symlink_metadata(&dir)
        .map_err(io_failure(&dir, RootBindingError::LocalStateUnwritable))?
        .file_type();
    if kind.is_symlink() {
        Err(RootBindingError::LocalStateNotFolder("link"))
    } else if !kind.is_dir() {
        Err(RootBindingError::LocalStateNotFolder("not-folder"))
    } else {
        Ok(())
    }
}

fn valid_token(token: &[u8]) -> bool {
    token.len() == TOKEN_HEX_LEN
        && token
            .iter()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_testkit::ScratchDir;

    #[test]
    fn an_unbound_root_reads_as_none_and_a_new_binding_reads_back() {
        let scratch = ScratchDir::new().expect("scratch");
        assert_eq!(read_root_binding(scratch.path()).expect("read"), None);
        let token = write_new_root_binding(scratch.path()).expect("write");
        assert_eq!(token.len(), TOKEN_HEX_LEN);
        assert_eq!(
            read_root_binding(scratch.path()).expect("read"),
            Some(token)
        );
    }

    #[test]
    fn a_hand_forged_binding_is_malformed() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::write(engine.join("ROOT_BINDING"), "manually-forged").expect("forged");
        assert!(matches!(
            read_root_binding(scratch.path()),
            Err(RootBindingError::Malformed)
        ));
    }

    #[test]
    fn an_empty_marker_binds_nothing_and_the_next_mint_takes_it_over() {
        let scratch = ScratchDir::new().expect("scratch");
        let first = write_new_root_binding(scratch.path()).expect("first mint");
        let marker = scratch.join(ROOT_BINDING_RELATIVE_PATH);
        std::fs::write(&marker, b"").expect("truncate");
        assert_eq!(read_root_binding(scratch.path()).expect("read"), None);
        let second = write_new_root_binding(scratch.path()).expect("second mint");
        assert_ne!(second, first);
        assert_eq!(second.len(), TOKEN_HEX_LEN);
        assert_eq!(
            read_root_binding(scratch.path()).expect("read"),
            Some(second)
        );
    }

    #[test]
    fn a_second_mint_binds_to_the_token_already_on_disk() {
        let scratch = ScratchDir::new().expect("scratch");
        let first = write_new_root_binding(scratch.path()).expect("first mint");
        let second = write_new_root_binding(scratch.path()).expect("second mint");
        assert_eq!(second, first);
    }

    #[test]
    fn competing_mints_publish_one_token() {
        for empty_marker in [false, true] {
            let scratch = ScratchDir::new().expect("scratch");
            let marker = scratch.join(ROOT_BINDING_RELATIVE_PATH);
            if empty_marker {
                create_binding_dir(scratch.path()).unwrap();
                std::fs::write(&marker, b"").unwrap();
            }
            let barrier = std::sync::Barrier::new(3);
            let tokens = std::thread::scope(|scope| {
                let threads: Vec<_> = (0..3)
                    .map(|_| {
                        scope.spawn(|| {
                            write_new_root_binding_with_hook(scratch.path(), || {
                                barrier.wait();
                            })
                            .unwrap()
                        })
                    })
                    .collect();
                threads
                    .into_iter()
                    .map(|thread| thread.join().unwrap())
                    .collect::<Vec<_>>()
            });
            assert!(tokens.iter().all(|token| token == &tokens[0]));
            assert_eq!(
                read_root_binding(scratch.path()).unwrap(),
                Some(tokens[0].clone())
            );
            assert_eq!(write_new_root_binding(scratch.path()).unwrap(), tokens[0]);
        }
    }

    #[test]
    fn interrupted_pending_token_is_replaced_before_publication() {
        for empty_marker in [false, true] {
            let scratch = ScratchDir::new().expect("scratch");
            let marker = scratch.join(ROOT_BINDING_RELATIVE_PATH);
            create_binding_dir(scratch.path()).unwrap();
            if empty_marker {
                std::fs::write(&marker, b"").unwrap();
            }
            let pending = marker.with_extension("pending");
            std::fs::write(&pending, b"incomplete").unwrap();
            let token = write_new_root_binding(scratch.path()).unwrap();
            assert_eq!(
                read_root_binding(scratch.path()).unwrap(),
                Some(token.clone())
            );
            assert!(!pending.exists());
            assert_eq!(write_new_root_binding(scratch.path()).unwrap(), token);
        }
    }

    /// EPERM is how macOS refuses a folder the person has not allowed. Each
    /// root step names it; EACCES and other failures keep their own error.
    #[test]
    fn an_eperm_root_step_is_a_privacy_denial_on_macos() {
        let scratch = ScratchDir::new().expect("scratch");
        let eperm = io_failure(scratch.path(), RootBindingError::Unwritable)(
            std::io::Error::from_raw_os_error(1),
        );
        if cfg!(target_os = "macos") {
            assert!(matches!(eperm, RootBindingError::PrivacyDenied));
        } else {
            assert!(matches!(eperm, RootBindingError::Unwritable));
        }
        assert!(matches!(
            io_failure(scratch.path(), RootBindingError::RootUnavailable)(
                std::io::Error::from_raw_os_error(13)
            ),
            RootBindingError::RootUnavailable
        ));
        assert_eq!(
            RootBindingError::PrivacyDenied.to_string(),
            "privacy-denied"
        );
    }

    /// A folder locked in Finder also refuses new files with EPERM. That is
    /// the folder's own state, not a privacy refusal.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_locked_engine_folder_is_not_a_privacy_denial() {
        let chflags = |flag: &str, path: &Path| {
            let status = std::process::Command::new("chflags")
                .arg(flag)
                .arg(path)
                .status()
                .expect("chflags");
            assert!(status.success());
        };
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        chflags("uchg", &engine);
        let minted = write_new_root_binding(scratch.path());
        chflags("nouchg", &engine);
        assert!(matches!(minted, Err(RootBindingError::Unwritable)));
    }

    /// A direct open of a root whose `.dohc` links elsewhere must not make
    /// the folder it names private, or write into it.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_linked_dohc_folder_is_refused_before_its_target_changes() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = ScratchDir::new().expect("scratch");
        let elsewhere = scratch.join("elsewhere");
        let engine = elsewhere.join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).expect("mode");
        let root = scratch.join("root");
        std::fs::create_dir(&root).expect("root");
        std::os::unix::fs::symlink(&elsewhere, root.join(".dohc")).expect("symlink");
        assert_eq!(
            not_private(write_new_root_binding(&root)),
            (".dohc".into(), dohc_macos_files::NotPrivateReason::Link)
        );
        let mode = std::fs::metadata(&engine)
            .expect("engine")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(std::fs::read_dir(&engine).expect("engine").count(), 0);
    }

    /// iCloud Drive must never sync the engine's folder, in a new workspace or
    /// in one an earlier build left without the exclusion.
    #[cfg(target_os = "macos")]
    #[test]
    fn opening_a_root_keeps_its_engine_folder_out_of_icloud() {
        let excluded = |root: &Path| excluded_at(&root.join(".dohc/engine"));
        let fresh = ScratchDir::new().expect("scratch");
        write_new_root_binding(fresh.path()).expect("mint");
        assert!(excluded(fresh.path()));

        let older = ScratchDir::new().expect("scratch");
        let engine = older.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::write(engine.join("ROOT_BINDING"), "a".repeat(TOKEN_HEX_LEN)).expect("binding");
        assert!(!excluded(older.path()));
        assert_eq!(
            write_new_root_binding(older.path()).expect("open"),
            "a".repeat(TOKEN_HEX_LEN)
        );
        assert!(excluded(older.path()));

        // A link at the engine folder is refused before anything is written
        // through it, so the folder it names is left as it was.
        let linked = ScratchDir::new().expect("scratch");
        let target = linked.join("elsewhere");
        std::fs::create_dir_all(&target).expect("target");
        std::fs::create_dir_all(linked.join(".dohc")).expect("dohc");
        std::os::unix::fs::symlink(&target, linked.join(".dohc/engine")).expect("symlink");
        assert_eq!(
            not_private(write_new_root_binding(linked.path())),
            (
                ".dohc/engine".into(),
                dohc_macos_files::NotPrivateReason::Link
            )
        );
        assert!(!excluded_at(&target));
    }

    /// The path and reason a refused binding names.
    #[cfg(target_os = "macos")]
    fn not_private(
        written: Result<String, RootBindingError>,
    ) -> (std::path::PathBuf, dohc_macos_files::NotPrivateReason) {
        match written {
            Err(RootBindingError::NotPrivate(refused)) => (refused.path, refused.reason),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn each_variant_has_its_own_message() {
        assert_eq!(
            RootBindingError::RootUnavailable.to_string(),
            "workspace root is unavailable"
        );
        assert_eq!(
            RootBindingError::Malformed.to_string(),
            "workspace root binding is malformed"
        );
        assert_eq!(
            RootBindingError::Unreadable.to_string(),
            "workspace root binding is unreadable"
        );
        assert_eq!(
            RootBindingError::Unwritable.to_string(),
            "workspace root binding could not be written"
        );
        assert_eq!(
            RootBindingError::Unstamped.to_string(),
            "engine database could not record its root binding"
        );
        assert_eq!(
            RootBindingError::DatabaseMismatch.to_string(),
            "engine database is bound to another root"
        );
        assert_eq!(
            RootBindingError::LocalStateUnwritable.to_string(),
            "this computer's folder in .dohc could not be created"
        );
    }

    /// Whether iCloud Drive and other file providers leave `dir` alone.
    #[cfg(target_os = "macos")]
    fn excluded_at(dir: &Path) -> bool {
        std::process::Command::new("xattr")
            .args(["-s", "-p", "com.apple.fileprovider.ignore#P"])
            .arg(dir)
            .output()
            .expect("xattr")
            .status
            .success()
    }

    /// An open that writes makes `.dohc/local` for this computer's state,
    /// private and, on a Mac, out of iCloud Drive. A later open keeps what is
    /// in it, and marks it again if the mark was lost.
    #[test]
    fn an_open_prepares_this_computers_folder_and_a_reopen_keeps_it() {
        let scratch = ScratchDir::new().expect("scratch");
        let local = scratch.join(".dohc").join("local");
        assert!(prepare_local_state(scratch.path()).expect("prepare"));
        assert!(std::fs::symlink_metadata(&local).expect("local").is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&local)
                .expect("local")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        #[cfg(target_os = "macos")]
        assert!(excluded_at(&local));
        std::fs::write(local.join("ui-state.json"), "{}").expect("state");
        #[cfg(target_os = "macos")]
        {
            let removed = std::process::Command::new("xattr")
                .args(["-d", "com.apple.fileprovider.ignore#P"])
                .arg(&local)
                .status()
                .expect("xattr");
            assert!(removed.success());
            assert!(!excluded_at(&local));
        }
        assert!(prepare_local_state(scratch.path()).expect("reopen"));
        #[cfg(target_os = "macos")]
        assert!(excluded_at(&local));
        assert_eq!(
            std::fs::read_to_string(local.join("ui-state.json")).expect("state"),
            "{}"
        );
    }

    /// A folder the mark could not reach could sync, so it is not ready. A
    /// volume without extended attributes has no file provider, so it is.
    #[cfg(target_os = "macos")]
    #[test]
    fn only_a_failed_mark_leaves_this_computers_folder_not_ready() {
        let failed = ScratchDir::new().expect("scratch");
        let refused = |_: &Path| Err(std::io::Error::from_raw_os_error(libc::EPERM));
        assert!(!prepare_local_state_with(failed.path(), refused).expect("prepare"));
        assert!(failed.join(".dohc/local").is_dir());

        let unsupported = ScratchDir::new().expect("scratch");
        let no_xattrs = |_: &Path| Err(std::io::Error::from_raw_os_error(libc::ENOTSUP));
        assert!(prepare_local_state_with(unsupported.path(), no_xattrs).expect("prepare"));
    }
}
