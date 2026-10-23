//! A folder this process holds open, reached by the path `/proc/self/fd/<n>`
//! instead of by its names, and the SQLite VFS that opens a store by such a
//! path. The engine checks its folder in a workspace, keeps it open, and
//! opens the History store and its key through it, so a folder that later
//! takes the checked folder's name is not reached.
use std::ffi::{CStr, c_char, c_int};
use std::io;
use std::os::fd::{AsRawFd, BorrowedFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where `/proc` lists this process's open descriptors.
const HELD_PREFIX: &str = "/proc/self/fd";

/// dohc can't reach the folder `path` through the descriptor it holds, so it
/// can't keep the folder private. `path` is relative to the folder the caller
/// started from, a workspace's root in the engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotHeld {
    pub path: PathBuf,
}

impl NotHeld {
    /// The reason as the engine sends it.
    pub const CODE: &'static str = "unchecked-system";
}

impl std::fmt::Display for NotHeld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let path = self.path.display();
        write!(
            f,
            "{path} can't be checked on this system, so dohc can't keep it private"
        )
    }
}

impl std::error::Error for NotHeld {}

/// The [`NotHeld`] refusal `err` carries, if it is one.
pub fn not_held(err: &io::Error) -> Option<&NotHeld> {
    err.get_ref()?.downcast_ref()
}

/// The path `/proc/self/fd/<n>` of the folder `dir`, which this process holds
/// open as descriptor `n`. The kernel follows it to `dir` itself, not to
/// whatever has `dir`'s name. Keep `dir` open while the path is in use: a
/// closed descriptor's number goes to the next file this process opens.
/// Refuses with [`NotHeld`] naming `shown` when the path does not lead to
/// `dir`.
pub fn held_path(dir: BorrowedFd<'_>, shown: &Path) -> io::Result<PathBuf> {
    held_path_through(dir, shown, &fds())
}

/// [`held_path`] with `fds` standing in for `/proc/self/fd`.
fn held_path_through(dir: BorrowedFd<'_>, shown: &Path, fds: &Path) -> io::Result<PathBuf> {
    let open = rustix::fs::fstat(dir)?;
    let path = fds.join(dir.as_raw_fd().to_string());
    let refused = || {
        io::Error::other(NotHeld {
            path: shown.to_owned(),
        })
    };
    let named = rustix::fs::stat(&path).map_err(|_| refused())?;
    if (named.st_dev, named.st_ino) != (open.st_dev, open.st_ino) {
        return Err(refused());
    }
    Ok(path)
}

/// Where this thread finds its descriptors: `/proc/self/fd`, or the folder a
/// test put in its place.
fn fds() -> PathBuf {
    #[cfg(feature = "test-support")]
    if let Some(fds) = test_support::FDS.with(|fds| fds.borrow().clone()) {
        return fds;
    }
    PathBuf::from(HELD_PREFIX)
}

/// For tests in other crates.
#[cfg(feature = "test-support")]
pub mod test_support {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    thread_local! {
        pub(super) static FDS: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    /// Run `f` with `fds` in place of `/proc/self/fd` for [`super::held_path`]
    /// on this thread, as where `/proc` is not mounted or lists another
    /// process.
    pub fn with_fds<T>(fds: &Path, f: impl FnOnce() -> T) -> T {
        let before = FDS.with(|slot| slot.replace(Some(fds.to_owned())));
        let result = f();
        FDS.with(|slot| *slot.borrow_mut() = before);
        result
    }
}

/// Whether `path` reaches its folder through a held descriptor, as
/// [`held_path`] gives, or lies below one.
pub fn is_path_by_fd(path: &Path) -> bool {
    path.starts_with(HELD_PREFIX)
}

/// The current path of the folder `path` reaches through a held descriptor,
/// which has no names to climb. Any other path is returned as it is.
pub fn path_by_name(path: &Path) -> io::Result<PathBuf> {
    if !is_path_by_fd(path) {
        return Ok(path.to_owned());
    }
    std::fs::read_link(path)
}

/// Create the folder `relative` in `base`, and any missing folder between
/// them, or take the ones there, and return the last one open. Each is
/// opened without following a link and must belong to this process's user,
/// and the last gets mode 0700. A missing folder is created with mode 0700
/// less the umask. `base` may be or lie under a link.
pub fn private_dir(base: &Path, relative: &Path) -> io::Result<OwnedFd> {
    private_dir_for(base, relative, rustix::process::geteuid().as_raw())
}

/// [`private_dir`] for folders that must belong to `owner`.
fn private_dir_for(base: &Path, relative: &Path, owner: u32) -> io::Result<OwnedFd> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    let mut folder = rustix::fs::open(base, flags, Mode::empty())?;
    let mut parts = 0;
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else {
            return Err(io::ErrorKind::InvalidInput.into());
        };
        match rustix::fs::mkdirat(&folder, name, Mode::from_raw_mode(0o700)) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(err) => return Err(err.into()),
        }
        folder = rustix::fs::openat(&folder, name, flags | OFlags::NOFOLLOW, Mode::empty())?;
        if rustix::fs::fstat(&folder)?.st_uid != owner {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "another user owns this folder, so dohc can't keep it private",
            ));
        }
        parts += 1;
    }
    if parts == 0 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    // Only a folder that isn't private yet changes, so a process that may not
    // change modes, as a replica's sandbox forbids, still opens one that is.
    if rustix::fs::fstat(&folder)?.st_mode & 0o777 != 0o700 {
        rustix::fs::fchmod(&folder, Mode::from_raw_mode(0o700))?;
    }
    Ok(folder)
}

/// The SQLite VFS that opens a file by the absolute path it is given. It is
/// the bundled SQLite's `unix` VFS, except for the full pathname: `unix`
/// replaces each link in a path with its target's name, which turns
/// `/proc/self/fd/<n>` back into the held folder's current name. This one
/// keeps an absolute path as given, so the kernel follows the descriptor to
/// the held folder for the store and for each file SQLite opens beside it.
/// A relative path goes to `unix`. It is registered once and is not the
/// default.
pub fn held_vfs() -> io::Result<&'static str> {
    static REGISTERED: OnceLock<c_int> = OnceLock::new();
    match *REGISTERED.get_or_init(register_held_vfs) {
        rusqlite::ffi::SQLITE_OK => Ok("dohc-held"),
        code => Err(io::Error::other(format!(
            "SQLite did not register the held-folder VFS: {code}"
        ))),
    }
}

/// The name [`held_vfs`] registers.
const HELD_VFS: &CStr = c"dohc-held";

type FullPathname = unsafe extern "C" fn(
    *mut rusqlite::ffi::sqlite3_vfs,
    *const c_char,
    c_int,
    *mut c_char,
) -> c_int;

/// The `unix` VFS's own full pathname, which a relative path goes to.
static UNIX_FULL_PATHNAME: OnceLock<FullPathname> = OnceLock::new();

#[allow(unsafe_code)]
fn register_held_vfs() -> c_int {
    use rusqlite::ffi;
    // SAFETY: sqlite3_vfs_find initializes SQLite and returns a VFS that
    // stays registered for the process, or null. The copy keeps unix's
    // methods and app data, which its xOpen reads, and changes only the name,
    // the list link and the full pathname. It is leaked because SQLite keeps
    // the pointer for the life of the process.
    unsafe {
        let unix = ffi::sqlite3_vfs_find(c"unix".as_ptr());
        if unix.is_null() {
            return ffi::SQLITE_ERROR;
        }
        let Some(full) = (*unix).xFullPathname else {
            return ffi::SQLITE_ERROR;
        };
        let _ = UNIX_FULL_PATHNAME.set(full);
        let mut held = *unix;
        held.zName = HELD_VFS.as_ptr();
        held.pNext = std::ptr::null_mut();
        held.xFullPathname = Some(held_full_pathname);
        ffi::sqlite3_vfs_register(Box::leak(Box::new(held)), 0)
    }
}

/// Copy an absolute `path` into `out` as given, or leave a relative one to
/// `unix`.
#[allow(unsafe_code)]
unsafe extern "C" fn held_full_pathname(
    vfs: *mut rusqlite::ffi::sqlite3_vfs,
    path: *const c_char,
    n_out: c_int,
    out: *mut c_char,
) -> c_int {
    use rusqlite::ffi;
    // SAFETY: SQLite passes a NUL-terminated path and an output buffer of
    // `n_out` bytes, and the copy writes at most that many.
    unsafe {
        let given = CStr::from_ptr(path).to_bytes_with_nul();
        if given.first() != Some(&b'/') {
            return match UNIX_FULL_PATHNAME.get() {
                Some(unix) => unix(vfs, path, n_out, out),
                None => ffi::SQLITE_ERROR,
            };
        }
        if given.len() > usize::try_from(n_out).unwrap_or(0) {
            return ffi::SQLITE_CANTOPEN;
        }
        std::ptr::copy_nonoverlapping(given.as_ptr().cast::<c_char>(), out, given.len());
        ffi::SQLITE_OK
    }
}

#[cfg(test)]
mod tests {
    use dohc_test_scratch::ScratchDir;
    use std::os::fd::AsFd;

    /// The folder as a refusal names it.
    const SHOWN: &str = ".dohc/engine";

    /// Move `dir` aside and put an empty folder at its name.
    fn swap(dir: &std::path::Path) -> std::path::PathBuf {
        let moved = dir.with_extension("moved");
        std::fs::rename(dir, &moved).unwrap();
        std::fs::create_dir(dir).unwrap();
        moved
    }

    /// Without a descriptor list, or with one whose entry leads to another
    /// folder, the held path is refused, naming the folder.
    #[test]
    fn a_path_that_does_not_lead_to_the_held_folder_is_refused() {
        use std::os::fd::AsRawFd;
        let scratch = ScratchDir::new_named("held-refused").unwrap();
        let root = scratch.path();
        let dir = root.join("engine");
        let other = root.join("other");
        std::fs::create_dir(&dir).unwrap();
        std::fs::create_dir(&other).unwrap();
        let folder = std::fs::File::open(&dir).unwrap();
        let missing = root.join("no-fds");
        let elsewhere = root.join("fds");
        std::fs::create_dir(&elsewhere).unwrap();
        let entry = elsewhere.join(folder.as_raw_fd().to_string());
        std::os::unix::fs::symlink(&other, entry).unwrap();
        for fds in [missing, elsewhere] {
            let err = super::held_path_through(folder.as_fd(), SHOWN.as_ref(), &fds).unwrap_err();
            let refused = super::not_held(&err).expect("a typed refusal");
            assert_eq!(
                refused.path,
                std::path::Path::new(SHOWN),
                "{}",
                fds.display()
            );
        }
    }

    #[test]
    fn a_path_by_descriptor_reaches_the_held_folder_after_its_name_moves() {
        let scratch = ScratchDir::new_named("held-path").unwrap();
        let root = scratch.path();
        let dir = root.join("engine");
        std::fs::create_dir(&dir).unwrap();
        let folder = std::fs::File::open(&dir).unwrap();
        let held =
            super::held_path(folder.as_fd(), SHOWN.as_ref()).expect("/proc resolves the folder");
        assert!(super::is_path_by_fd(&held.join("engine.db")));
        let moved = swap(&dir);
        std::fs::write(held.join("engine.db"), b"store").unwrap();
        assert_eq!(std::fs::read(moved.join("engine.db")).unwrap(), b"store");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let current = super::path_by_name(&held).unwrap();
        assert_eq!(current, std::fs::canonicalize(&moved).unwrap());
        assert_eq!(super::path_by_name(&dir).unwrap(), dir);
    }

    /// Every file SQLite opens beside the store after it opens is in the held
    /// folder, wherever its name has gone since.
    #[test]
    fn a_store_opened_through_the_held_folder_stays_in_it() {
        let scratch = ScratchDir::new_named("held-store").unwrap();
        let root = scratch.path();
        let dir = root.join("engine");
        std::fs::create_dir(&dir).unwrap();
        let folder = std::fs::File::open(&dir).unwrap();
        let held = super::held_path(folder.as_fd(), SHOWN.as_ref()).unwrap();
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        let vfs = super::held_vfs().unwrap();
        let db = held.join("engine.db");
        let conn = rusqlite::Connection::open_with_flags_and_vfs(&db, flags, vfs).unwrap();
        let moved = swap(&dir);
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);")
            .unwrap();
        for file in ["engine.db", "engine.db-wal", "engine.db-shm"] {
            assert!(moved.join(file).exists(), "{file}");
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        drop(conn);
    }

    /// A relative path still goes to the `unix` VFS's full pathname.
    #[test]
    fn a_relative_path_opens_as_the_unix_vfs_opens_it() {
        let scratch = ScratchDir::new_named("held-relative").unwrap();
        let root = scratch.path();
        let flags =
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_CREATE;
        let vfs = super::held_vfs().unwrap();
        let cwd = std::env::current_dir().unwrap();
        let relative = pathdiff(&root.join("plain.db"), &cwd);
        let conn = rusqlite::Connection::open_with_flags_and_vfs(&relative, flags, vfs).unwrap();
        conn.execute_batch("CREATE TABLE t(x);").unwrap();
        drop(conn);
        assert!(root.join("plain.db").exists());
    }

    /// `target` relative to `from`, both absolute.
    fn pathdiff(target: &std::path::Path, from: &std::path::Path) -> std::path::PathBuf {
        let up = from.components().count() - 1;
        let mut path: std::path::PathBuf = std::iter::repeat_n("..", up).collect();
        path.push(target.strip_prefix("/").unwrap());
        path
    }

    #[test]
    fn a_private_folder_is_made_0700_and_refuses_a_link_or_another_owner() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let scratch = ScratchDir::new_named("held-private").unwrap();
        let root = scratch.path();
        let relative = std::path::Path::new(".dohc/engine");
        let engine = root.join(relative);
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ours = std::fs::metadata(root).unwrap().uid();
        let other = super::private_dir_for(root, relative, ours + 1).unwrap_err();
        assert_eq!(other.kind(), std::io::ErrorKind::PermissionDenied);
        let mode = std::fs::metadata(&engine).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755, "another user's folder changed");
        super::private_dir(root, relative).unwrap();
        let mode = std::fs::metadata(&engine).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        let linked = root.join("linked");
        std::fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(root.join(".dohc"), linked.join(".dohc")).unwrap();
        let link = super::private_dir(&linked, relative).unwrap_err();
        // Linux reports a link opened as a folder without following it as
        // not a folder.
        assert!(
            matches!(link.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR)),
            "{link}"
        );
    }
}
