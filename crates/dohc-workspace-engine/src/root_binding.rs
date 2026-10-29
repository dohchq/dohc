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
    #[error("this computer's folder in .dohc could not be prepared")]
    LocalStateUnwritable,
    /// `.dohc`, the engine's folder or `.dohc/local`, the second field, is a
    /// link, is not a folder, or is another user's, or on Linux the engine
    /// can't reach its folder through the descriptor it holds, the first. On
    /// a Mac and on Windows, `NotPrivate` names it, with the same message.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[error("engine-folder-not-private: {0} {1}")]
    NotPrivate(&'static str, &'static str),
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
    /// `.dohc`, the engine's folder or `.dohc/local` is a link, is not a
    /// folder, or is another account's or this user can't change it, or
    /// something in one of those folders is, in the message a Mac sends as
    /// `NotPrivate`.
    #[cfg(windows)]
    #[error("engine-folder-not-private: {} {}", .0.reason.code(), .0.path)]
    NotPrivate(dohc_windows_files::NotPrivate),
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
        #[cfg(windows)]
        if let Some(refused) = dohc_windows_files::not_private(&error) {
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
    read_marker(&root.join(ROOT_BINDING_RELATIVE_PATH))
}

fn read_marker(marker: &Path) -> Result<Option<String>, RootBindingError> {
    let token = match std::fs::read(marker) {
        Ok(token) if token.is_empty() => return Ok(None),
        Ok(token) => token,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_failure(marker, RootBindingError::Unreadable)(error)),
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
    let binding = create_binding_dir(root)?;
    let marker = &binding.marker;
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
    if let Some(token) = read_marker(marker)? {
        sync_binding_dir(marker)?;
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
        std::fs::rename(&pending, marker)
    })();
    if let Err(error) = publish {
        let _ = std::fs::remove_file(&pending);
        return Err(io_failure(marker, RootBindingError::Unwritable)(error));
    }
    sync_binding_dir(marker)?;
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
    let binding = create_binding_dir(root)?;
    std::fs::write(&binding.marker, token).map_err(|_| RootBindingError::Unwritable)
}

/// The engine's folder, ready for the root binding: the marker's path and,
/// on a Mac and Linux, the folder that path goes through, open.
struct BindingDir {
    marker: PathBuf,
    #[cfg(unix)]
    _folder: std::os::fd::OwnedFd,
}

fn create_binding_dir(root: &Path) -> Result<BindingDir, RootBindingError> {
    let marker = Path::new(ROOT_BINDING_RELATIVE_PATH);
    let (Some(relative), Some(name)) = (marker.parent(), marker.file_name()) else {
        return Err(RootBindingError::Unwritable);
    };
    #[cfg(not(target_os = "linux"))]
    let parent = root.join(relative);
    // A mode does not limit an ACL entry, so on a Mac each open makes the
    // folder 0700 with no entries, whoever created it, and refuses a link at
    // `.dohc` or at the folder, a folder another user owns, and one a volume
    // keeps shared. The marker then goes through the folder checked here, so
    // a folder put at its name since then is not reached.
    #[cfg(target_os = "macos")]
    {
        let refused = io_failure(&parent, RootBindingError::Unwritable);
        let dir = dohc_macos_files::ensure_private_dir(root, relative).and_then(|folder| {
            let dir = dohc_macos_files::path_by_id(&folder, relative)?;
            Ok((dir.unwrap_or_else(|| parent.clone()), folder))
        });
        let (dir, folder) = dir.map_err(refused)?;
        exclude_from_icloud(&dir);
        Ok(BindingDir {
            marker: dir.join(name),
            _folder: folder,
        })
    }
    // Linux holds the folder checked here and writes the marker through its
    // descriptor, so a folder put at its name since then is not reached.
    // Without that path the marker is refused.
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let folder = create_engine_dir(root, rustix::process::geteuid().as_raw())?;
        let folder = std::os::fd::OwnedFd::from(folder);
        #[cfg(target_os = "linux")]
        let dir = {
            use dohc_linux_files::held::{NotHeld, held_path, not_held};
            held_path(std::os::fd::AsFd::as_fd(&folder), relative).map_err(|err| match not_held(
                &err,
            ) {
                Some(_) => RootBindingError::NotPrivate(NotHeld::CODE, ".dohc/engine"),
                None => RootBindingError::Unwritable,
            })?
        };
        #[cfg(not(target_os = "linux"))]
        let dir = parent;
        Ok(BindingDir {
            marker: dir.join(name),
            _folder: folder,
        })
    }
    // Windows opens a file for anyone its own DACL admits, even in a folder
    // they can't list, so each open there gives the folder, and what is in
    // it, the DACL of a user's profile folder, and refuses a link and what
    // another account owns.
    #[cfg(windows)]
    {
        // Only `.dohc/local` stays held, for the desktop's readers.
        drop(
            dohc_windows_files::ensure_private_dir(root, relative)
                .map_err(io_failure(&parent, RootBindingError::Unwritable))?,
        );
        Ok(BindingDir {
            marker: parent.join(name),
        })
    }
}

/// The engine's state belongs to this Mac. Keep the folder that holds it out
/// of iCloud Drive before any of it exists, and on each open of an older
/// workspace. A volume without extended attributes has no file provider to
/// sync it. Any other failure leaves the store syncing, so it is logged, but
/// the workspace still opens.
#[cfg(target_os = "macos")]
fn exclude_from_icloud(engine_dir: &Path) {
    match dohc_macos_files::exclude_from_sync(engine_dir) {
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
/// keeps on one computer: each open gives it mode 0700, and on a Mac no ACL
/// entries. A link, anything but a folder, or another user's folder (on a
/// Mac, on a local volume) is refused, and what it names is left as it is. On a Mac the folder is marked so that file-provider services such as
/// iCloud Drive skip it, before anything is written in it. If that fails,
/// the folder could sync, so it is not ready and the desktop writes nothing
/// in it, but the workspace still opens.
///
/// On Windows the folder gets what the engine's folder gets, and stays held
/// until the open that prepared it ends.
pub fn prepare_local_state(root: &Path) -> Result<LocalState, RootBindingError> {
    #[cfg(target_os = "macos")]
    {
        prepare_local_state_with(root, dohc_macos_files::exclude_from_sync)
            .map(|ready| LocalState { ready })
    }
    #[cfg(windows)]
    {
        let relative = Path::new(LOCAL_STATE_RELATIVE_PATH);
        let unwritable = RootBindingError::LocalStateUnwritable;
        let held = dohc_windows_files::ensure_private_dir(root, relative)
            .map_err(io_failure(&root.join(relative), unwritable))?;
        Ok(LocalState {
            ready: true,
            _held: held,
        })
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        create_local_state_dir(root)?;
        Ok(LocalState { ready: true })
    }
}

/// Create the folder `name` in `base`, or take the one there, and make it
/// private as the engine's folder is. A link, anything but a folder, or
/// another user's folder is refused.
pub(crate) fn ensure_private_folder(base: &Path, name: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    return dohc_windows_files::ensure_private_dir(base, Path::new(name)).map(drop);
    #[cfg(target_os = "macos")]
    return dohc_macos_files::ensure_private_dir(base, Path::new(name)).map(drop);
    #[cfg(all(unix, not(target_os = "macos")))]
    return create_folder(base, name, rustix::process::geteuid().as_raw())
        .and_then(make_private)
        .map(drop);
}

/// What an open that writes prepared in `.dohc/local`.
pub struct LocalState {
    /// Whether this computer's state can go in the folder.
    pub ready: bool,
    /// On Windows, where the desktop can't see who may change the folder, it
    /// trusts the folder while the engine's open holds it in place.
    #[cfg(windows)]
    _held: std::fs::File,
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

#[cfg(all(unix, not(target_os = "macos")))]
fn create_local_state_dir(root: &Path) -> Result<(), RootBindingError> {
    let (shown, owner) = (
        LOCAL_STATE_RELATIVE_PATH,
        rustix::process::geteuid().as_raw(),
    );
    let refused = not_private(root, shown, RootBindingError::LocalStateUnwritable, owner);
    create_folder(root, shown, owner)
        .and_then(make_private)
        .map(drop)
        .map_err(refused)
}

/// Create `.dohc` and the engine's folder in `root`, or take the ones there,
/// and make the engine's folder private, as a Mac does. Both must belong to
/// `owner`. A link, anything but a folder, or another user's folder at either
/// is refused by name before anything changes. Returns the engine's folder,
/// open.
#[cfg(all(unix, not(target_os = "macos")))]
fn create_engine_dir(root: &Path, owner: u32) -> Result<std::fs::File, RootBindingError> {
    let refused = |shown| not_private(root, shown, RootBindingError::Unwritable, owner);
    create_folder(root, ".dohc", owner).map_err(refused(".dohc"))?;
    create_folder(root, ".dohc/engine", owner)
        .and_then(make_private)
        .map_err(refused(".dohc/engine"))
}

/// Create the folder `shown` in `root` with mode 0700, or take the one there,
/// and open it without following a link. A folder `owner` does not own fails,
/// whatever this process may change.
#[cfg(all(unix, not(target_os = "macos")))]
fn create_folder(root: &Path, shown: &str, owner: u32) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
    let dir = root.join(shown);
    match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error),
        _ => {}
    }
    let folder = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&dir)?;
    if folder.metadata()?.uid() != owner {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    Ok(folder)
}

/// Give `folder` mode 0700 through its descriptor, whoever created it and
/// however, as the Mac path does, and return it. A folder that is private
/// already is left as it is, so a process that may not change modes, as a
/// replica's sandbox forbids, still opens it.
#[cfg(all(unix, not(target_os = "macos")))]
fn make_private(folder: std::fs::File) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::PermissionsExt;
    if folder.metadata()?.permissions().mode() & 0o777 != 0o700 {
        folder.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(folder)
}

/// What kept the folder `shown` in `root` from being created, opened or made
/// private, as the Mac names it: the first part of `shown` that is a link, is
/// not a folder, or is a folder `owner` does not own. The disk tells, read
/// without following a link. A refusal leaves what it names as it is. Any
/// other failure is `otherwise`.
#[cfg(all(unix, not(target_os = "macos")))]
fn not_private(
    root: &Path,
    shown: &'static str,
    otherwise: RootBindingError,
    owner: u32,
) -> impl FnOnce(std::io::Error) -> RootBindingError {
    move |error| {
        use std::os::unix::fs::MetadataExt;
        let mut end = 0;
        for part in shown.split('/') {
            end += part.len();
            let Ok(meta) = std::fs::symlink_metadata(root.join(&shown[..end])) else {
                break;
            };
            let reason = if meta.file_type().is_symlink() {
                "link"
            } else if !meta.is_dir() {
                "not-folder"
            } else if meta.uid() != owner {
                "other-owner"
            } else {
                end += 1;
                continue;
            };
            return RootBindingError::NotPrivate(reason, &shown[..end]);
        }
        io_failure(&root.join(shown), otherwise)(error)
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

    /// An engine folder an older desktop build made 0755 is 0700 after the
    /// next open, on Linux as on a Mac (#2376).
    #[cfg(unix)]
    #[test]
    fn an_open_makes_an_engine_folder_an_older_build_left_open_private() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc").join("engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).expect("mode");
        write_new_root_binding(scratch.path()).expect("open");
        let mode = std::fs::metadata(&engine)
            .expect("engine")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    /// A link or a file at `.dohc` or the engine's folder is refused by name
    /// before anything is written through it, and what a link names is left
    /// as it was (#2376).
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn a_link_or_a_file_where_the_engines_folders_go_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        for (squatted, link) in [
            (".dohc", true),
            (".dohc", false),
            (".dohc/engine", true),
            (".dohc/engine", false),
        ] {
            let scratch = ScratchDir::new().expect("scratch");
            let elsewhere = scratch.join("elsewhere");
            std::fs::create_dir(&elsewhere).expect("elsewhere");
            std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o755))
                .expect("mode");
            std::fs::create_dir_all(scratch.join(squatted).parent().expect("parent"))
                .expect("parent");
            if link {
                std::os::unix::fs::symlink(&elsewhere, scratch.join(squatted)).expect("link");
            } else {
                std::fs::write(scratch.join(squatted), "mine").expect("file");
            }
            let reason = if link { "link" } else { "not-folder" };
            let refused = write_new_root_binding(scratch.path());
            assert!(
                matches!(
                    refused,
                    Err(RootBindingError::NotPrivate(r, p)) if (r, p) == (reason, squatted)
                ),
                "{squatted}: {refused:?}"
            );
            assert_eq!(
                refused.unwrap_err().to_string(),
                format!("engine-folder-not-private: {reason} {squatted}")
            );
            let mode = std::fs::metadata(&elsewhere)
                .expect("elsewhere")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755, "{squatted}");
            assert_eq!(std::fs::read_dir(&elsewhere).expect("elsewhere").count(), 0);
        }
    }

    /// A folder another user owns, as `sudo` leaves one, is refused by name.
    /// Making one needs root, so the seam expects another owner instead.
    /// Then `.dohc` is another user's too, and the refusal names it, because
    /// the folder in it can't be moved out (#2376).
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn another_users_folder_is_refused_by_name() {
        use std::os::unix::fs::MetadataExt;
        let scratch = ScratchDir::new().expect("scratch");
        std::fs::create_dir_all(scratch.join(".dohc/engine")).expect("engine dir");
        let ours = std::fs::metadata(scratch.path()).expect("scratch").uid();
        let denied = || std::io::Error::from_raw_os_error(libc::EACCES);
        let refusal = |root: &Path, shown, owner| {
            not_private(root, shown, RootBindingError::Unwritable, owner)(denied())
        };
        assert_eq!(
            refusal(scratch.path(), ".dohc/engine", ours + 1).to_string(),
            "engine-folder-not-private: other-owner .dohc"
        );
        let dohc = scratch.join(".dohc");
        assert_eq!(
            refusal(&dohc, "engine", ours + 1).to_string(),
            "engine-folder-not-private: other-owner engine"
        );
        assert!(matches!(
            refusal(scratch.path(), ".dohc/engine", ours),
            RootBindingError::Unwritable
        ));
    }

    /// Each open checks who owns `.dohc` and the engine's folder before it
    /// changes anything, so a process that may change any folder's mode, as
    /// root may, still refuses another user's. Making one needs root, so the
    /// seam expects another owner instead.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn an_open_refuses_another_users_folders_before_changing_them() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc/engine");
        std::fs::create_dir_all(&engine).expect("engine dir");
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).expect("mode");
        let ours = std::fs::metadata(scratch.path()).expect("scratch").uid();
        let refused = create_engine_dir(scratch.path(), ours + 1).expect_err("another owner");
        assert_eq!(
            refused.to_string(),
            "engine-folder-not-private: other-owner .dohc"
        );
        let mode = std::fs::metadata(&engine)
            .expect("engine")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        create_engine_dir(scratch.path(), ours).expect("our own folders");
        let mode = std::fs::metadata(&engine)
            .expect("engine")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    /// The engine's folder moves after the open checks it, and another takes
    /// its name. The marker still lands in the checked folder, and the other
    /// gets nothing (#2375).
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_marker_lands_in_the_folder_the_open_checked() {
        let scratch = ScratchDir::new().expect("scratch");
        let engine = scratch.join(".dohc").join("engine");
        let moved = scratch.join(".dohc").join("moved");
        let token = write_new_root_binding_with_hook(scratch.path(), || {
            std::fs::rename(&engine, &moved).expect("move");
            std::fs::create_dir(&engine).expect("replacement");
        })
        .expect("mint");
        assert_eq!(std::fs::read_dir(&engine).expect("replacement").count(), 0);
        assert_eq!(
            std::fs::read_to_string(moved.join("ROOT_BINDING")).expect("marker"),
            token
        );
    }

    /// Where the engine can't reach its checked folder through the descriptor
    /// it holds, as without `/proc`, minting and writing a binding are refused,
    /// naming the folder, and no marker, lock or temporary file is written.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_binding_whose_folder_cannot_be_held_is_refused_before_anything_is_written() {
        use dohc_linux_files::held::test_support::with_fds;
        let scratch = ScratchDir::new().expect("scratch");
        let no_fds = scratch.join("no-fds");
        let minted = with_fds(&no_fds, || write_new_root_binding(scratch.path()));
        let written = with_fds(&no_fds, || {
            write_root_binding(scratch.path(), &"a".repeat(TOKEN_HEX_LEN))
        });
        for refused in [minted.map(drop), written] {
            assert!(
                matches!(
                    refused,
                    Err(RootBindingError::NotPrivate(
                        "unchecked-system",
                        ".dohc/engine"
                    ))
                ),
                "{refused:?}"
            );
        }
        let engine = scratch.join(".dohc").join("engine");
        let left: Vec<_> = std::fs::read_dir(&engine)
            .expect("engine folder")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert!(left.is_empty(), "{left:?}");
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
            "this computer's folder in .dohc could not be prepared"
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
    /// private and, on a Mac, marked for file providers to skip. A later open
    /// keeps what is in it, and marks it again if the mark was lost.
    #[test]
    fn an_open_prepares_this_computers_folder_and_a_reopen_keeps_it() {
        let scratch = ScratchDir::new().expect("scratch");
        let local = scratch.join(".dohc").join("local");
        // As an open does: the root binding makes `.dohc` first.
        write_new_root_binding(scratch.path()).expect("mint");
        assert!(prepare_local_state(scratch.path()).expect("prepare").ready);
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
        assert!(prepare_local_state(scratch.path()).expect("reopen").ready);
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

    /// What `icacls /save` writes for the item at `path`: its DACL in SDDL.
    #[cfg(windows)]
    fn sddl(scratch: &ScratchDir, path: &Path) -> String {
        let saved = scratch.join("saved.sddl");
        icacls(path, &["/save".as_ref(), saved.as_os_str()]);
        let bytes = std::fs::read(&saved).expect("saved");
        let text: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let text = String::from_utf16_lossy(&text);
        text.lines().nth(1).expect("sddl").trim().to_owned()
    }

    #[cfg(windows)]
    fn icacls(path: &Path, args: &[&std::ffi::OsStr]) {
        let status = std::process::Command::new("icacls")
            .arg(path)
            .args(args)
            .stdout(std::process::Stdio::null())
            .status()
            .expect("icacls");
        assert!(status.success(), "icacls {} {args:?}", path.display());
    }

    /// A workspace whose test DACL grants Users read access, with the
    /// automation steps a person allowed already in `.dohc/local`.
    #[cfg(windows)]
    fn shared_workspace(scratch: &ScratchDir) -> (PathBuf, PathBuf) {
        let root = scratch.join("root");
        std::fs::create_dir(&root).expect("root");
        icacls(
            &root,
            &["/grant".as_ref(), "*S-1-5-32-545:(OI)(CI)R".as_ref()],
        );
        let reach = root.join(".dohc/local/automations/reach.json");
        std::fs::create_dir_all(reach.parent().expect("automations")).expect("folders");
        std::fs::write(&reach, b"{}").expect("reach");
        assert!(sddl(scratch, &reach).contains("(A;ID;FR;;;BU)"));
        (root, reach)
    }

    /// On Windows, an open that writes gives `.dohc/local` and what is in it
    /// only this user, Administrators and SYSTEM, and holds the folder, so
    /// the open keeps using the folder it checked.
    #[cfg(windows)]
    #[test]
    fn an_open_on_windows_makes_this_computers_folder_private_and_holds_it() {
        let scratch = ScratchDir::new().expect("scratch");
        let (root, reach) = shared_workspace(&scratch);
        let local = root.join(".dohc").join("local");
        let prepared = prepare_local_state(&root).expect("prepare");
        assert!(prepared.ready);
        let folder = sddl(&scratch, &local);
        assert!(
            folder.starts_with("D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"),
            "{folder}"
        );
        let allowed = sddl(&scratch, &reach);
        assert!(
            allowed.starts_with("D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)"),
            "{allowed}"
        );
        assert!(!allowed.contains("BU"), "{allowed}");
        let aside = root.join(".dohc").join("aside");
        assert!(std::fs::rename(&local, &aside).is_err());
        // Nor can `.dohc`, which would take `.dohc/local` with it.
        let dohc_aside = root.join("dohc-aside");
        assert!(std::fs::rename(root.join(".dohc"), &dohc_aside).is_err());
        drop(prepared);
        // After the open ends, `.dohc` keeps its private DACL. Existing
        // unrelated items keep their own entries.
        let dohc = sddl(&scratch, &root.join(".dohc"));
        assert!(
            dohc.starts_with("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"),
            "{dohc}"
        );
        assert!(!dohc.contains("BU"), "{dohc}");
        std::fs::rename(&local, &aside).expect("rename once the open ends");
        std::fs::rename(root.join(".dohc"), &dohc_aside).expect("rename .dohc once the open ends");
    }

    /// A different folder at `.dohc/local`, with the private DACL but with an
    /// item that keeps entries of its own, has no record, so the open checks
    /// what is in it.
    #[cfg(windows)]
    #[test]
    fn a_different_folder_at_this_computers_folder_path_is_checked_in_full() {
        let scratch = ScratchDir::new().expect("scratch");
        let (root, _) = shared_workspace(&scratch);
        let local = root.join(".dohc").join("local");
        drop(prepare_local_state(&root).expect("prepare"));
        std::fs::rename(&local, root.join(".dohc").join("before")).expect("aside");
        let reach = local.join("reach.json");
        std::fs::create_dir(&local).expect("swapped in");
        std::fs::write(&reach, b"{}").expect("reach");
        let user = format!("{}:(F)", std::env::var("USERNAME").expect("user"));
        let readable = ["/inheritance:r", "/grant:r", "*S-1-5-32-545:(R)", &user];
        icacls(&reach, &readable.map(std::ffi::OsStr::new));
        let user = format!("{}:(OI)(CI)(F)", std::env::var("USERNAME").expect("user"));
        let private = [
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)(F)",
            "*S-1-5-32-544:(OI)(CI)(F)",
            &user,
        ];
        icacls(&local, &private.map(std::ffi::OsStr::new));
        assert!(sddl(&scratch, &reach).contains("(A;;FR;;;BU)"));
        drop(prepare_local_state(&root).expect("reopen"));
        assert!(!sddl(&scratch, &reach).contains("BU"));
    }

    /// An item in `.dohc/local` this user can't change, as one another
    /// account owns, refuses the open, in words the desktop shows.
    #[cfg(windows)]
    #[test]
    fn an_item_this_user_cannot_change_in_this_computers_folder_refuses_the_open() {
        let scratch = ScratchDir::new().expect("scratch");
        let (root, reach) = shared_workspace(&scratch);
        // Owner rights limited to reading, and a denied right to change the
        // DACL, stand in for a file another account owns. The denial goes
        // first: once owner rights are limited, only an entry for this user
        // could still let the DACL change, and the folder above may have none.
        let deny = format!("{}:(WDAC)", std::env::var("USERNAME").expect("user"));
        icacls(&reach, &["/deny".as_ref(), deny.as_ref()]);
        icacls(&reach, &["/grant".as_ref(), "*S-1-3-4:(R)".as_ref()]);
        let refused = prepare_local_state(&root).err().expect("refused");
        assert_eq!(
            refused.to_string(),
            "engine-folder-not-private: other-owner .dohc/local"
        );
    }
}
