//! Create a file without the ACL entries its folder gives new files, keep a
//! folder private to its owner, name a folder by its ID, copy a file's macOS
//! ACL and extended attributes between open descriptors, flush a descriptor
//! behind a drive write barrier, keep a folder out of iCloud Drive, and
//! unlink a file only when no process has it open.
#![cfg(target_vendor = "apple")]
use std::ffi::{CStr, CString, OsStr, c_char, c_int, c_uint, c_void};
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

/// The attribute that tells macOS file providers, iCloud Drive among them,
/// not to sync an item or anything inside it.
pub const SYNC_IGNORE_XATTR: &CStr = c"com.apple.fileprovider.ignore#P";

/// The largest attribute value, or list of names, the copy reads.
const MAX_XATTR_BYTES: usize = 1 << 20;

/// `XATTR_OPERATION_INTENT_SAVE` in `<xattr_flags.h>`.
const XATTR_OPERATION_INTENT_SAVE: c_uint = 2;

/// `ACL_TYPE_EXTENDED`, `ACL_FLAG_NO_INHERIT` and `ACL_FIRST_ENTRY` in
/// `<sys/acl.h>`.
const ACL_TYPE_EXTENDED: c_int = 0x100;
const ACL_FLAG_NO_INHERIT: c_int = 1 << 17;
const ACL_FIRST_ENTRY: c_int = 0;

/// `FILESEC_MODE` and `FILESEC_ACL` in `<sys/fcntl.h>`.
const FILESEC_MODE: c_int = 4;
const FILESEC_ACL: c_int = 5;

// SAFETY: These match `<xattr_flags.h>`, macOS 10.10 and later, where
// `xattr_operation_intent_t` is `unsigned int`, `<sys/acl.h>`, where
// `acl_type_t` and `acl_flag_t` are C enums, `entry_id` is an `int`, and
// `acl_t`, `acl_entry_t` and `acl_flagset_t` are pointers, and
// `<sys/fcntl.h>`, where `filesec_property_t` is a C enum and `filesec_t` is
// a pointer.
#[allow(unsafe_code)]
unsafe extern "C" {
    fn xattr_preserve_for_intent(name: *const c_char, intent: c_uint) -> c_int;
    fn acl_init(count: c_int) -> *mut c_void;
    fn acl_get_flagset_np(acl: *mut c_void, flags: *mut *mut c_void) -> c_int;
    fn acl_add_flag_np(flags: *mut c_void, flag: c_int) -> c_int;
    fn acl_set_flagset_np(acl: *mut c_void, flags: *mut c_void) -> c_int;
    fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
    fn acl_get_link_np(path: *const c_char, kind: c_int) -> *mut c_void;
    fn acl_set_link_np(path: *const c_char, kind: c_int, acl: *mut c_void) -> c_int;
    fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
    fn acl_set_fd_np(fd: c_int, acl: *mut c_void, kind: c_int) -> c_int;
    fn acl_free(acl: *mut c_void) -> c_int;
    fn filesec_init() -> *mut c_void;
    fn filesec_set_property(fsec: *mut c_void, property: c_int, value: *const c_void) -> c_int;
    fn filesec_free(fsec: *mut c_void);
    fn openx_np(path: *const c_char, flags: c_int, fsec: *mut c_void) -> c_int;
    fn mkdirx_np(path: *const c_char, fsec: *mut c_void) -> c_int;
}

/// Create `name` in `dir` for writing, exclusively and without following a
/// link, with `mode` less the umask and none of the entries `dir`'s ACL gives
/// every new file. The kernel applies the empty ACL as it creates the file,
/// so nobody but the owner and root can open it before it gets another. A
/// file that is not in `dir`, or that has any ACL entry, is removed and
/// refused. A file with entries fails with [`VolumeSharesNewFiles`].
pub fn create_uninherited(dir: impl AsFd, name: &OsStr, mode: u16) -> io::Result<OwnedFd> {
    create_uninherited_with(dir.as_fd(), name, mode, || {}, |_| {})
}

/// [`create_uninherited`], with test seams just before and after the create.
fn create_uninherited_with(
    dir: BorrowedFd<'_>,
    name: &OsStr,
    mode: u16,
    before_create: impl FnOnce(),
    after_create: impl FnOnce(&CStr),
) -> io::Result<OwnedFd> {
    // openx_np takes a path. It refuses a link anywhere in the folder's own
    // path, and the identity check below refuses a folder moved meanwhile.
    let mut path = rustix::fs::getpath(dir)?.into_bytes();
    path.push(b'/');
    path.extend_from_slice(name.as_bytes());
    let path = CString::new(path)?;
    before_create();
    let file = match open_uninherited(&path, mode) {
        // A file system without ACLs, such as FAT, refuses one at creation,
        // and has none for the file to inherit.
        Err(err) if err.raw_os_error() == Some(libc::EINVAL) && !has_acls(dir) => {
            use rustix::fs::{Mode, OFlags};
            let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW;
            let mode = Mode::from_raw_mode(mode);
            return Ok(rustix::fs::openat(
                dir,
                name,
                flags | OFlags::CLOEXEC,
                mode,
            )?);
        }
        file => file?,
    };
    after_create(&path);
    if let Err(err) = check_created(dir, name, &file) {
        remove_if_same(&file, &path);
        return Err(err);
    }
    Ok(file)
}

/// The volume gave a new file ACL entries in place of the empty ACL it was
/// created with, as a network file system can apply its server's. Nothing
/// written there can be kept private.
#[derive(Debug)]
pub struct VolumeSharesNewFiles;

impl std::fmt::Display for VolumeSharesNewFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("this volume adds sharing permissions to new files, so dohc can't keep this file private")
    }
}

impl std::error::Error for VolumeSharesNewFiles {}

/// Whether `err` is [`VolumeSharesNewFiles`].
pub fn volume_shares_new_files(err: &io::Error) -> bool {
    err.get_ref()
        .is_some_and(|inner| inner.is::<VolumeSharesNewFiles>())
}

/// What is at a path that dohc refuses to keep private.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotPrivateReason {
    Link,
    NotFolder,
    NotFile,
    /// A folder on a local volume that another user owns.
    OtherOwner,
    /// A folder on a volume that keeps owners but can't be reached by its
    /// ID, so dohc can't be sure it opens the folder it checked.
    UncheckedVolume,
}

impl NotPrivateReason {
    /// The reason as the engine sends it.
    pub fn code(self) -> &'static str {
        match self {
            NotPrivateReason::Link => "link",
            NotPrivateReason::NotFolder => "not-folder",
            NotPrivateReason::NotFile => "not-file",
            NotPrivateReason::OtherOwner => "other-owner",
            NotPrivateReason::UncheckedVolume => "unchecked-volume",
        }
    }
}

/// dohc refuses to keep `path` private because of what is there. `path` is
/// relative to the folder the caller started from, a workspace's root in the
/// engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotPrivate {
    pub path: std::path::PathBuf,
    pub reason: NotPrivateReason,
}

impl std::fmt::Display for NotPrivate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.reason {
            NotPrivateReason::Link => "is a link",
            NotPrivateReason::NotFolder => "is not a folder",
            NotPrivateReason::NotFile => "is not a file",
            NotPrivateReason::OtherOwner => "belongs to another user",
            NotPrivateReason::UncheckedVolume => "is on a volume dohc can't check",
        };
        let path = self.path.display();
        write!(f, "{path} {what}, so dohc can't keep it private")
    }
}

impl std::error::Error for NotPrivate {}

/// The [`NotPrivate`] refusal `err` carries, if it is one.
pub fn not_private(err: &io::Error) -> Option<&NotPrivate> {
    err.get_ref()?.downcast_ref()
}

/// Check that `file` is `name` in `dir` and has no ACL entries.
fn check_created(dir: BorrowedFd<'_>, name: &OsStr, file: &OwnedFd) -> io::Result<()> {
    let created = rustix::fs::fstat(file)?;
    let named = rustix::fs::statat(dir, name, rustix::fs::AtFlags::SYMLINK_NOFOLLOW)?;
    if (created.st_dev, created.st_ino) != (named.st_dev, named.st_ino) {
        return Err(io::Error::other("the new file is not in its folder"));
    }
    if has_entries(file.as_fd())? {
        return Err(io::Error::other(VolumeSharesNewFiles));
    }
    Ok(())
}

/// Unlink `path` only if it still names `file` when checked. An entry that
/// takes its place between the check and the unlink is still removed.
fn remove_if_same(file: &OwnedFd, path: &CStr) {
    if let (Ok(open), Ok(named)) = (rustix::fs::fstat(file), rustix::fs::lstat(path))
        && (open.st_dev, open.st_ino) == (named.st_dev, named.st_ino)
    {
        let _ = rustix::fs::unlinkat(rustix::fs::CWD, path, rustix::fs::AtFlags::empty());
    }
}

/// Whether the file's ACL has any entry. A file system without ACLs has none.
fn has_entries(fd: BorrowedFd<'_>) -> io::Result<bool> {
    // SAFETY: The descriptor stays open for the call, which retains nothing.
    #[allow(unsafe_code)]
    let acl = unsafe { acl_get_fd_np(fd.as_raw_fd(), ACL_TYPE_EXTENDED) };
    any_entry(acl)
}

/// Whether `acl`, just returned by an `acl_get_*` call, has any entry. Frees
/// it. A null `acl` reads the call's error.
fn any_entry(acl: *mut c_void) -> io::Result<bool> {
    if acl.is_null() {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ENOENT | libc::ENOTSUP | libc::EOPNOTSUPP) => Ok(false),
            _ => Err(err),
        };
    }
    let mut entry = std::ptr::null_mut();
    // SAFETY: `acl` came from an acl_get call. acl_get_entry only reads it and
    // writes `entry`, which points into `acl` and is not used after the free.
    #[allow(unsafe_code)]
    let found = unsafe {
        let found = acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) == 0;
        acl_free(acl);
        found
    };
    Ok(found)
}

/// Whether the folder's file system supports ACLs. An error counts as
/// support, so the caller keeps its refusal.
fn has_acls(dir: BorrowedFd<'_>) -> bool {
    // SAFETY: The descriptor stays open for the call, which retains nothing.
    #[allow(unsafe_code)]
    let supported = unsafe { libc::fpathconf(dir.as_raw_fd(), libc::_PC_EXTENDED_SECURITY_NP) };
    supported != 0
}

fn open_uninherited(path: &CStr, mode: u16) -> io::Result<OwnedFd> {
    let flags =
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW_ANY | libc::O_CLOEXEC;
    // SAFETY: The path ends with a NUL and outlives the call, and openx_np
    // retains neither it nor the filesec.
    #[allow(unsafe_code)]
    let fd =
        with_uninherited_filesec(mode, |fsec| unsafe { openx_np(path.as_ptr(), flags, fsec) })?;
    // SAFETY: openx_np returned a new descriptor that nothing else owns.
    #[allow(unsafe_code)]
    let file = unsafe { OwnedFd::from_raw_fd(fd) };
    Ok(file)
}

/// Call `create` with a filesec that holds `mode` and an empty ACL flagged
/// not to inherit, and return what it returns unless that is negative.
fn with_uninherited_filesec(
    mode: u16,
    create: impl FnOnce(*mut c_void) -> c_int,
) -> io::Result<c_int> {
    // SAFETY: Each object is checked for null before use and freed once.
    // filesec_set_property copies the ACL and the mode it is given, and
    // `create` gets the filesec only for the call.
    #[allow(unsafe_code)]
    unsafe {
        let acl = acl_init(0);
        if acl.is_null() {
            return Err(io::Error::last_os_error());
        }
        let fsec = filesec_init();
        let mut acl_flags = std::ptr::null_mut();
        let result = if !fsec.is_null()
            && acl_get_flagset_np(acl, &mut acl_flags) == 0
            && acl_add_flag_np(acl_flags, ACL_FLAG_NO_INHERIT) == 0
            && acl_set_flagset_np(acl, acl_flags) == 0
            && filesec_set_property(fsec, FILESEC_ACL, (&raw const acl).cast()) == 0
            && filesec_set_property(fsec, FILESEC_MODE, (&raw const mode).cast()) == 0
        {
            create(fsec)
        } else {
            -1
        };
        let err = io::Error::last_os_error();
        if !fsec.is_null() {
            filesec_free(fsec);
        }
        acl_free(acl);
        if result < 0 {
            return Err(err);
        }
        Ok(result)
    }
}

/// The mode of a private folder.
const PRIVATE_DIR_MODE: u16 = 0o700;

/// Create the folder `relative` in `base`, and any missing folder between
/// them, or take the one already there, and make it private: refuse it
/// unless this process's user owns it, then give it mode 0700 and no ACL
/// entries. Others then cannot reach anything in it, whatever its files' own
/// modes and ACLs. A folder created here takes none of the entries its parent
/// gives new folders, so nothing created in it inherits any.
///
/// `base` may be or lie under a link. A link at any part of `relative` is
/// refused before anything is changed, on any volume. A volume that is not
/// local, such as a network share, keeps its server's owners, ACLs and
/// modes: there a missing folder is created with mode 0700 and whatever the
/// server gives it, and an existing one is taken as it is. A folder whose
/// entries a local volume keeps fails with [`VolumeSharesNewFiles`]. Any
/// other failure names, as [`NotPrivate`], the first part of `relative` that
/// is a link, is not a folder, or is a folder on a local volume another user
/// owns, when one is. On a refusal, only an empty folder this call created is
/// removed. Returns the folder, open for reading.
pub fn ensure_private_dir(base: &Path, relative: &Path) -> io::Result<OwnedFd> {
    ensure_private_dir_with(base, relative, &System::REAL)
}

/// What [`ensure_private_dir`] asks of the system, replaced in tests.
struct System {
    /// The user the folder must belong to. `None` is this process's.
    owner: Option<u32>,
    /// Whether the folder is on a local volume.
    local: fn(BorrowedFd<'_>) -> io::Result<bool>,
    remove_acl: fn(BorrowedFd<'_>),
    /// Runs on the folder's path just before it is made private.
    before_protect: fn(&Path) -> io::Result<()>,
}

impl System {
    const REAL: System = System {
        owner: None,
        local: is_local,
        remove_acl,
        before_protect: |_| Ok(()),
    };
}

fn ensure_private_dir_with(base: &Path, relative: &Path, system: &System) -> io::Result<OwnedFd> {
    make_private_dir(base, relative, system).map_err(|err| {
        if volume_shares_new_files(&err) {
            return err;
        }
        match not_private_part(base, relative, system) {
            Some(refused) => io::Error::other(refused),
            None => err,
        }
    })
}

fn make_private_dir(base: &Path, relative: &Path, system: &System) -> io::Result<OwnedFd> {
    let mut names = Vec::new();
    for part in relative.components() {
        match part {
            std::path::Component::Normal(name) => names.push(name),
            _ => return Err(io::ErrorKind::InvalidInput.into()),
        }
    }
    let name = names.pop().ok_or(io::ErrorKind::InvalidInput)?;
    let mut parent = OwnedFd::from(std::fs::File::open(base)?);
    for between in names {
        make_dir(parent.as_fd(), between, system)?;
        parent = open_folder(parent.as_fd(), between)?;
    }
    let created = make_dir(parent.as_fd(), name, system)?;
    let protected = (system.before_protect)(&base.join(relative))
        .and_then(|()| protect(parent.as_fd(), name, system));
    if protected.is_err() && created {
        // Removes the folder only while it is empty.
        let _ = rustix::fs::unlinkat(&parent, name, rustix::fs::AtFlags::REMOVEDIR);
    }
    protected
}

/// The first part of `relative` in `base` that is a link, is not a folder,
/// or is a folder on a local volume another user owns. The first is the one
/// the person can move: a folder in another user's `.dohc` can't be moved
/// out of it.
fn not_private_part(base: &Path, relative: &Path, system: &System) -> Option<NotPrivate> {
    use rustix::fs::{AtFlags, FileType};
    let mut parent = OwnedFd::from(std::fs::File::open(base).ok()?);
    let mut path = std::path::PathBuf::new();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        path.push(name);
        let stat = rustix::fs::statat(&parent, name, AtFlags::SYMLINK_NOFOLLOW).ok()?;
        let reason = match FileType::from_raw_mode(stat.st_mode) {
            FileType::Symlink => NotPrivateReason::Link,
            FileType::Directory
                if stat.st_uid != owner(system) && (system.local)(parent.as_fd()).ok()? =>
            {
                NotPrivateReason::OtherOwner
            }
            FileType::Directory => {
                parent = open_folder(parent.as_fd(), name).ok()?;
                continue;
            }
            _ => NotPrivateReason::NotFolder,
        };
        return Some(NotPrivate { path, reason });
    }
    None
}

/// The user a private folder must belong to.
fn owner(system: &System) -> u32 {
    system
        .owner
        .unwrap_or_else(|| rustix::process::geteuid().as_raw())
}

/// Open the folder `name` in `dir`, refusing a link.
fn open_folder(dir: BorrowedFd<'_>, name: &OsStr) -> io::Result<OwnedFd> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    Ok(rustix::fs::openat(dir, name, flags, Mode::empty())?)
}

/// Create the folder `name` in `dir` with mode 0700 less the umask, and on
/// a local volume none of the ACL entries `dir` gives new folders. Return
/// whether this call created it. Anything already at the name is left for
/// the caller.
fn make_dir(dir: BorrowedFd<'_>, name: &OsStr, system: &System) -> io::Result<bool> {
    let made = if (system.local)(dir)? {
        mkdir_uninherited(dir, name)
    } else {
        mkdir_plain(dir, name)
    };
    match made {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

fn mkdir_plain(dir: BorrowedFd<'_>, name: &OsStr) -> io::Result<()> {
    let mode = rustix::fs::Mode::from_raw_mode(PRIVATE_DIR_MODE);
    Ok(rustix::fs::mkdirat(dir, name, mode)?)
}

fn mkdir_uninherited(dir: BorrowedFd<'_>, name: &OsStr) -> io::Result<()> {
    let mut path = rustix::fs::getpath(dir)?.into_bytes();
    path.push(b'/');
    path.extend_from_slice(name.as_bytes());
    let path = CString::new(path)?;
    // SAFETY: The path ends with a NUL and outlives the call, and mkdirx_np
    // retains neither it nor the filesec.
    #[allow(unsafe_code)]
    let made = with_uninherited_filesec(PRIVATE_DIR_MODE, |fsec| unsafe {
        mkdirx_np(path.as_ptr(), fsec)
    });
    match made {
        // A file system without ACLs, such as FAT, refuses one at creation,
        // and has none for the folder to inherit.
        Err(err) if err.raw_os_error() == Some(libc::EINVAL) && !has_acls(dir) => {
            mkdir_plain(dir, name)
        }
        made => made.map(drop),
    }
}

/// Open `name` in `dir`, refusing anything but a folder, and a link. On a
/// local volume, also refuse it unless the expected user owns it, then
/// remove its ACL entries and give it mode 0700.
fn protect(dir: BorrowedFd<'_>, name: &OsStr, system: &System) -> io::Result<OwnedFd> {
    let folder = open_folder(dir, name)?;
    // A network share's owners, ACLs and modes are its server's. One that
    // maps every user to another uid would otherwise refuse each folder.
    if !(system.local)(folder.as_fd())? {
        return Ok(folder);
    }
    let stat = rustix::fs::fstat(&folder)?;
    if stat.st_uid != owner(system) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "another user owns this folder, so dohc can't keep it private",
        ));
    }
    clear_entries(folder.as_fd(), system.remove_acl)?;
    if stat.st_mode & 0o7777 != PRIVATE_DIR_MODE {
        let mode = rustix::fs::Mode::from_raw_mode(PRIVATE_DIR_MODE);
        rustix::fs::fchmod(&folder, mode)?;
    }
    Ok(folder)
}

/// `MNT_IGNORE_OWNERSHIP` in `<sys/mount.h>`.
const MNT_IGNORE_OWNERSHIP: u32 = 0x0020_0000;

/// The path `/.vol/<device>/<file ID>` of the folder `dir`. It names the
/// folder itself, not whatever has the folder's name. A concurrent probe on
/// APFS found no open through it that reached a folder put in its place.
/// Keep `dir` open while the path is in use, so its ID cannot pass to
/// another folder.
///
/// `Ok(None)` where a mode keeps no other user out, so the folder's plain
/// path serves: a network volume, whose server keeps its own owners, and a
/// volume that ignores owners, such as FAT, exFAT and most external disks.
/// Any other volume must resolve the path to `dir`, or this refuses with
/// [`NotPrivate`] naming `shown`.
pub fn path_by_id(dir: impl AsFd, shown: &Path) -> io::Result<Option<PathBuf>> {
    let dir = dir.as_fd();
    let named = |path: &Path| Ok(rustix::fs::stat(path)?);
    path_by_id_with(dir, shown, keeps_owners(dir)?, named)
}

/// [`path_by_id`], with seams for whether the volume keeps owners and for
/// what the path names.
fn path_by_id_with(
    dir: BorrowedFd<'_>,
    shown: &Path,
    keeps_owners: bool,
    named: impl FnOnce(&Path) -> io::Result<rustix::fs::Stat>,
) -> io::Result<Option<PathBuf>> {
    if !keeps_owners {
        return Ok(None);
    }
    let open = rustix::fs::fstat(dir)?;
    let path = PathBuf::from(format!("/.vol/{}/{}", open.st_dev, open.st_ino));
    match named(&path) {
        Ok(named) if (named.st_dev, named.st_ino) == (open.st_dev, open.st_ino) => Ok(Some(path)),
        _ => Err(io::Error::other(NotPrivate {
            path: shown.to_owned(),
            reason: NotPrivateReason::UncheckedVolume,
        })),
    }
}

/// Whether `dir`'s volume keeps owners, so a mode keeps other users out.
fn keeps_owners(dir: BorrowedFd<'_>) -> io::Result<bool> {
    let volume = rustix::fs::fstatfs(dir)?;
    Ok(owned_volume(volume.f_flags, &volume.f_fstypename))
}

/// Whether a volume with the mount flags `flags`, of the kind
/// `f_fstypename` names, keeps owners: it is local, does not ignore owners,
/// and is not FAT or exFAT, which have none.
fn owned_volume(flags: u32, kind: &[c_char]) -> bool {
    let local = flags & libc::MNT_LOCAL as u32 != 0;
    local
        && flags & MNT_IGNORE_OWNERSHIP == 0
        && !matches!(type_name(kind).as_slice(), b"msdos" | b"exfat")
}

/// Whether `path` names a folder by ID, as [`path_by_id`] does, or lies
/// below one.
pub fn is_path_by_id(path: &Path) -> bool {
    path.starts_with("/.vol")
}

/// The folder's current path when `path` names it by ID, as [`path_by_id`]
/// does, which has no names to climb. Any other path is returned as it is.
pub fn path_by_name(path: &Path) -> io::Result<PathBuf> {
    use rustix::fs::{Mode, OFlags};
    if !is_path_by_id(path) {
        return Ok(path.to_owned());
    }
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
    let dir = rustix::fs::open(path, flags, Mode::empty())?;
    let current = rustix::fs::getpath(&dir)?.into_bytes();
    Ok(OsStr::from_bytes(&current).into())
}

/// Remove the ACL entries of the file `name` in the folder `dir`, without
/// following a link at the name or opening the file. macOS has no ACL call
/// relative to a folder, and closing a descriptor on the file would drop any
/// lock this process holds on it, so this goes by the folder's
/// [`path_by_id`], or where that keeps the plain path, its current path. A
/// refusal names the folder `shown`. The caller checks that the volume is
/// local. A file whose entries the volume keeps fails with
/// [`VolumeSharesNewFiles`]. A file that is gone, or on a file system without
/// ACLs, has none.
pub fn remove_acl_entries_in(dir: impl AsFd, shown: &Path, name: &OsStr) -> io::Result<()> {
    remove_acl_entries_in_with(dir.as_fd(), shown, name, || {})
}

/// [`remove_acl_entries_in`], with a test seam just after the path is read.
fn remove_acl_entries_in_with(
    dir: BorrowedFd<'_>,
    shown: &Path,
    name: &OsStr,
    before_change: impl FnOnce(),
) -> io::Result<()> {
    let mut path = match path_by_id(dir, shown)? {
        Some(folder) => folder.into_os_string().into_vec(),
        None => rustix::fs::getpath(dir)?.into_bytes(),
    };
    path.push(b'/');
    path.extend_from_slice(name.as_bytes());
    let path = CString::new(path)?;
    before_change();
    // SAFETY: The path ends with a NUL and outlives each call, which retains
    // nothing. Each ACL is checked for null and freed once.
    #[allow(unsafe_code)]
    let has_entries = || any_entry(unsafe { acl_get_link_np(path.as_ptr(), ACL_TYPE_EXTENDED) });
    if has_entries()? {
        #[allow(unsafe_code)]
        unsafe {
            let acl = acl_init(0);
            if !acl.is_null() {
                acl_set_link_np(path.as_ptr(), ACL_TYPE_EXTENDED, acl);
                acl_free(acl);
            }
        }
        if has_entries()? {
            return Err(io::Error::other(VolumeSharesNewFiles));
        }
    }
    Ok(())
}

fn clear_entries(fd: BorrowedFd<'_>, remove_acl: fn(BorrowedFd<'_>)) -> io::Result<()> {
    if has_entries(fd)? {
        remove_acl(fd);
        if has_entries(fd)? {
            return Err(io::Error::other(VolumeSharesNewFiles));
        }
    }
    Ok(())
}

/// Whether `fd` is on a volume the kernel marks local. A network share is
/// not, and its owners, ACLs and modes belong to its server.
pub fn is_local(fd: BorrowedFd<'_>) -> io::Result<bool> {
    Ok(rustix::fs::fstatfs(fd)?.f_flags & libc::MNT_LOCAL as u32 != 0)
}

/// Give `fd` an empty ACL. A volume that keeps its entries anyway shows them
/// when the caller reads the ACL back.
fn remove_acl(fd: BorrowedFd<'_>) {
    // SAFETY: `acl` is checked for null and freed once. The descriptor stays
    // open for the call, which copies the ACL.
    #[allow(unsafe_code)]
    unsafe {
        let acl = acl_init(0);
        if !acl.is_null() {
            acl_set_fd_np(fd.as_raw_fd(), acl, ACL_TYPE_EXTENDED);
            acl_free(acl);
        }
    }
}

/// Give `to`, which has no ACL entries, exactly `from`'s access control
/// list, inherited entries included. Nothing else is copied. A file system
/// without ACLs has none to copy. An error means `from`'s ACL did not reach
/// `to`.
pub fn copy_acl(from: impl AsFd, to: impl AsFd) -> io::Result<()> {
    // SAFETY: The descriptor stays open for the call, which retains nothing.
    #[allow(unsafe_code)]
    let acl = unsafe { acl_get_fd_np(from.as_fd().as_raw_fd(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ENOENT | libc::ENOTSUP | libc::EOPNOTSUPP) => Ok(()),
            _ => Err(err),
        };
    }
    // SAFETY: `acl` came from acl_get_fd_np, the descriptor stays open for
    // the call, which copies the ACL, and `acl` is freed once, here.
    #[allow(unsafe_code)]
    let (set, err) = unsafe {
        let set = acl_set_fd_np(to.as_fd().as_raw_fd(), acl, ACL_TYPE_EXTENDED);
        let err = io::Error::last_os_error();
        acl_free(acl);
        (set, err)
    };
    if set != 0 {
        return Err(err);
    }
    Ok(())
}

/// Copy the extended attributes macOS keeps when an app saves a new version
/// of a file, such as Finder tags, and a quarantine, which a save does not
/// keep but a download must. Attributes tied to the old content, such as
/// `com.apple.TextEncoding`, are left out, and so are the resource fork and
/// any value over 1 MiB. An attribute that cannot be copied is skipped.
pub fn copy_saved_xattrs(from: impl AsFd, to: impl AsFd) {
    let (from, to) = (from.as_fd(), to.as_fd());
    let Some(names) = read_bounded(|list| rustix::fs::flistxattr(from, list)) else {
        return;
    };
    for name in names.split_inclusive(|&byte| byte == 0) {
        let Ok(name) = CStr::from_bytes_with_nul(name) else {
            continue;
        };
        if name == c"com.apple.ResourceFork"
            || !(name == c"com.apple.quarantine" || kept_on_save(name))
        {
            continue;
        }
        if let Some(value) = read_bounded(|value| rustix::fs::fgetxattr(from, name, value)) {
            let _ = rustix::fs::fsetxattr(to, name, &value, rustix::fs::XattrFlags::empty());
        }
    }
}

fn kept_on_save(name: &CStr) -> bool {
    // SAFETY: `name` ends with a NUL and outlives the call, which only reads
    // it.
    #[allow(unsafe_code)]
    let kept = unsafe { xattr_preserve_for_intent(name.as_ptr(), XATTR_OPERATION_INTENT_SAVE) };
    kept != 0
}

/// Flush `fd` to its drive, then issue a write barrier there
/// (`F_BARRIERFSYNC`). The drive persists everything flushed before the
/// barrier ahead of any later write, but may still hold it in its cache:
/// this orders writes and does not make them durable. The kernel issues
/// `F_FULLFSYNC` instead on file systems without barriers. A storage driver
/// that ignores barriers loses the ordering, as one that ignores
/// `F_FULLFSYNC` loses durability.
pub fn barrier_fsync(fd: impl AsFd) -> io::Result<()> {
    let fd = fd.as_fd();
    loop {
        // SAFETY: The descriptor stays open for the call, which takes no
        // argument and retains nothing.
        #[allow(unsafe_code)]
        let result = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_BARRIERFSYNC) };
        if result != -1 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

/// Keep `dir` and everything in it out of iCloud Drive and other file
/// providers. The folder stays on this Mac, and the provider deletes any
/// copy it already uploaded. Never follows a symlink, and leaves an existing
/// attribute untouched.
pub fn exclude_from_sync(dir: &Path) -> io::Result<()> {
    match rustix::fs::lsetxattr(dir, SYNC_IGNORE_XATTR, b"1", rustix::fs::XattrFlags::CREATE) {
        Ok(()) | Err(rustix::io::Errno::EXIST) => Ok(()),
        Err(errno) => Err(errno.into()),
    }
}

/// `AT_NODELETEBUSY` in `<sys/fcntl.h>`.
const AT_NODELETEBUSY: u32 = 0x4000;

/// The file systems known to refuse `AT_NODELETEBUSY` on a busy file: APFS,
/// HFS+, ExFAT and FAT, tested on disk images, and the SMB and NFS clients,
/// whose remove calls `vnode_isinuse` for the flag.
const BUSY_CHECKED: [&[u8]; 6] = [b"apfs", b"hfs", b"exfat", b"msdos", b"smbfs", b"nfs"];

/// Close `file` and unlink `path`, its name, unless any process of any user
/// has the file open or mapped. Return whether it was unlinked. A reader
/// counts as much as a writer; opens for events only (`O_EVTONLY`) do not.
/// The file system checks inside the unlink call, so no open can come between
/// the check and the unlink. On a file system not known to check, the file
/// is never unlinked. A program on another computer that has a network
/// share's file open is never seen.
pub fn remove_unless_open(file: std::fs::File, path: &std::path::Path) -> io::Result<bool> {
    if !refuses_busy_unlink(&file)? {
        return Ok(false);
    }
    drop(file);
    match rustix::fs::unlinkat(
        rustix::fs::CWD,
        path,
        rustix::fs::AtFlags::from_bits_retain(AT_NODELETEBUSY),
    ) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::BUSY) => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Whether `file`'s file system is known to refuse unlinking a file a
/// process has open, so [`remove_unless_open`] can ever unlink it.
pub fn refuses_busy_unlink(file: impl AsFd) -> io::Result<bool> {
    Ok(checks_busy(&rustix::fs::fstatfs(file)?.f_fstypename))
}

/// Whether the file system named by `f_fstypename` is in [`BUSY_CHECKED`].
fn checks_busy(kind: &[c_char]) -> bool {
    BUSY_CHECKED.contains(&type_name(kind).as_slice())
}

/// The file system's name in `f_fstypename`, up to its NUL.
fn type_name(kind: &[c_char]) -> Vec<u8> {
    kind.iter()
        .take_while(|&&byte| byte != 0)
        .map(|&byte| byte as u8)
        .collect()
}

/// Read a value whose size `read` reports for an empty buffer, unless it is
/// larger than [`MAX_XATTR_BYTES`] or grows between the two reads.
fn read_bounded(read: impl Fn(&mut [u8]) -> rustix::io::Result<usize>) -> Option<Vec<u8>> {
    let len = read(&mut []).ok()?;
    if len > MAX_XATTR_BYTES {
        return None;
    }
    let mut value = vec![0; len];
    let read_len = read(&mut value).ok()?;
    value.truncate(read_len);
    Some(value)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_barrier_flush_succeeds_on_a_file_and_its_folder() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("barrier-fsync").unwrap();
        let path = scratch.path().join("note.md");
        std::fs::write(&path, b"ordered").unwrap();
        super::barrier_fsync(std::fs::File::open(&path).unwrap()).unwrap();
        super::barrier_fsync(std::fs::File::open(scratch.path()).unwrap()).unwrap();
    }

    #[test]
    fn a_folder_excluded_from_sync_carries_the_provider_ignore_attribute_once() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("exclude-from-sync").unwrap();
        let dir = scratch.path().join("engine");
        std::fs::create_dir(&dir).unwrap();
        let read = || {
            let mut value = [0; 8];
            rustix::fs::lgetxattr(&dir, super::SYNC_IGNORE_XATTR, &mut value)
                .map(|len| value[..len].to_vec())
        };
        assert_eq!(read(), Err(rustix::io::Errno::NOATTR));
        super::exclude_from_sync(&dir).unwrap();
        assert_eq!(read().unwrap(), b"1");
        // A second call keeps the attribute instead of failing or rewriting it.
        rustix::fs::lsetxattr(
            &dir,
            super::SYNC_IGNORE_XATTR,
            b"kept",
            rustix::fs::XattrFlags::empty(),
        )
        .unwrap();
        super::exclude_from_sync(&dir).unwrap();
        assert_eq!(read().unwrap(), b"kept");
    }

    #[test]
    fn an_open_file_is_not_removed() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("remove-unless-open").unwrap();
        let path = scratch.path().join("log.txt");
        std::fs::write(&path, b"kept").unwrap();
        let open = || std::fs::File::open(&path).unwrap();
        let writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        assert!(!super::remove_unless_open(open(), &path).unwrap());
        drop(writer);
        let reader = open();
        assert!(!super::remove_unless_open(open(), &path).unwrap());
        drop(reader);
        assert!(super::remove_unless_open(open(), &path).unwrap());
        assert!(!path.exists());
    }

    #[test]
    fn only_file_systems_known_to_check_busy_files_unlink() {
        let name = |kind: &str| {
            let mut field = [0; 16];
            for (slot, byte) in field.iter_mut().zip(kind.bytes()) {
                *slot = byte as std::ffi::c_char;
            }
            super::checks_busy(&field)
        };
        for kind in ["apfs", "hfs", "exfat", "msdos", "smbfs", "nfs"] {
            assert!(name(kind), "{kind}");
        }
        for kind in [
            "macfuse", "osxfuse", "fskit", "webdav", "afpfs", "apfsx", "",
        ] {
            assert!(!name(kind), "{kind}");
        }
    }

    /// Whether `ls -le` lists any ACL entry for `path`.
    fn has_entries(path: &std::path::Path) -> bool {
        let listing = std::process::Command::new("/bin/ls")
            .arg("-led")
            .arg(path)
            .output()
            .unwrap();
        assert!(listing.status.success());
        String::from_utf8(listing.stdout).unwrap().lines().count() > 1
    }

    #[test]
    fn a_created_file_takes_none_of_its_folders_acl() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = dohc_test_scratch::ScratchDir::new_named("create-uninherited").unwrap();
        let dir = scratch.path().join("shared");
        std::fs::create_dir(&dir).unwrap();
        add_entry(&dir, "group:everyone allow read,file_inherit");
        let folder = std::fs::File::open(&dir).unwrap();
        std::fs::write(dir.join("inheriting"), b"").unwrap();
        assert!(has_entries(&dir.join("inheriting")));

        let name = std::ffi::OsStr::new("temp");
        let file = super::create_uninherited(&folder, name, 0o600).unwrap();
        assert!(!has_entries(&dir.join("temp")));
        let meta = std::fs::File::from(file).metadata().unwrap();
        assert_eq!(meta.permissions().mode() & 0o777, 0o600);
        let again = super::create_uninherited(&folder, name, 0o600).unwrap_err();
        assert_eq!(again.kind(), std::io::ErrorKind::AlreadyExists);
    }

    const INHERITED: &str = "group:everyone allow read,execute,file_inherit,directory_inherit";

    fn mode(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    }

    fn relative() -> &'static std::path::Path {
        std::path::Path::new(".dohc/engine")
    }

    /// A workspace whose `.dohc/engine` an earlier build made: mode 0755 and
    /// the entries of a workspace folder that passes them on.
    fn shared_workspace(scratch: &dohc_test_scratch::ScratchDir) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let workspace = scratch.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        add_entry(&workspace, INHERITED);
        let engine = workspace.join(relative());
        std::fs::create_dir_all(&engine).unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(engine.join("engine.db"), b"store").unwrap();
        assert!(has_entries(&engine));
        workspace
    }

    /// A system that expects `owner` and finds every volume local.
    fn system(owner: Option<u32>) -> super::System {
        super::System {
            owner,
            local: |_| Ok(true),
            ..super::System::REAL
        }
    }

    #[test]
    fn a_new_private_folder_takes_none_of_its_folders_acl() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-new").unwrap();
        let dir = scratch.path().join("shared");
        std::fs::create_dir(&dir).unwrap();
        add_entry(&dir, INHERITED);
        let engine = dir.join(relative());
        super::ensure_private_dir(&dir, super::Path::new(".dohc/engine")).unwrap();
        for folder in [dir.join(".dohc"), engine.clone()] {
            assert!(!has_entries(&folder), "{}", folder.display());
            assert_eq!(mode(&folder), 0o700, "{}", folder.display());
        }
        // What is created inside inherits nothing either.
        std::fs::write(engine.join("engine.db"), b"").unwrap();
        std::fs::create_dir(engine.join("displaced")).unwrap();
        assert!(!has_entries(&engine.join("engine.db")));
        assert!(!has_entries(&engine.join("displaced")));
        super::ensure_private_dir(&dir, super::Path::new(".dohc/engine")).unwrap();
    }

    #[test]
    fn an_existing_folder_is_made_private_and_keeps_its_contents() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-existing").unwrap();
        let workspace = shared_workspace(&scratch);
        let engine = workspace.join(relative());
        super::ensure_private_dir(&workspace, relative()).unwrap();
        assert!(!has_entries(&engine));
        assert_eq!(mode(&engine), 0o700);
        assert_eq!(std::fs::read(engine.join("engine.db")).unwrap(), b"store");
    }

    /// A link at `.dohc`, or at the folder itself, is refused before the
    /// folder it names is changed. A link above the base is followed.
    #[test]
    fn a_link_below_the_base_is_refused_and_its_target_left_alone() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-link").unwrap();
        let target = shared_workspace(&scratch);
        let workspace = scratch.path().join("linked");
        std::fs::create_dir(&workspace).unwrap();
        std::os::unix::fs::symlink(target.join(".dohc"), workspace.join(".dohc")).unwrap();
        let err = super::ensure_private_dir(&workspace, relative()).unwrap_err();
        assert_eq!(refusal(&err), (".dohc", super::NotPrivateReason::Link));
        std::fs::remove_file(workspace.join(".dohc")).unwrap();
        std::fs::create_dir(workspace.join(".dohc")).unwrap();
        std::os::unix::fs::symlink(target.join(relative()), workspace.join(relative())).unwrap();
        let err = super::ensure_private_dir(&workspace, relative()).unwrap_err();
        assert_eq!(
            refusal(&err),
            (".dohc/engine", super::NotPrivateReason::Link)
        );
        assert!(has_entries(&target.join(relative())));
        assert_eq!(mode(&target.join(relative())), 0o755);

        let above = scratch.path().join("above");
        std::os::unix::fs::symlink(&target, &above).unwrap();
        super::ensure_private_dir(&above, relative()).unwrap();
        assert_eq!(mode(&target.join(relative())), 0o700);
    }

    /// Making a folder another user owns needs root, so the seam expects
    /// another owner instead. Then `.dohc` is another user's too, and the
    /// refusal names it, because the folder in it can't be moved out.
    #[test]
    fn a_folder_another_user_owns_is_refused_and_left_alone() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-owner").unwrap();
        let workspace = shared_workspace(&scratch);
        let other = system(Some(rustix::process::geteuid().as_raw() + 1));
        let err = super::ensure_private_dir_with(&workspace, relative(), &other).unwrap_err();
        assert_eq!(
            refusal(&err),
            (".dohc", super::NotPrivateReason::OtherOwner)
        );
        assert!(has_entries(&workspace.join(relative())));
        assert_eq!(mode(&workspace.join(relative())), 0o755);
        let engine = std::path::Path::new("engine");
        let err =
            super::ensure_private_dir_with(&workspace.join(".dohc"), engine, &other).unwrap_err();
        assert_eq!(
            refusal(&err),
            ("engine", super::NotPrivateReason::OtherOwner)
        );
    }

    /// A file where `.dohc` or the folder in it belongs is named as not a
    /// folder, and left as it was.
    #[test]
    fn a_file_in_a_folders_place_is_refused() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-file-squat").unwrap();
        for squatted in [".dohc", ".dohc/engine"] {
            let workspace = scratch.path().join(squatted.replace('/', "-"));
            std::fs::create_dir(&workspace).unwrap();
            std::fs::create_dir_all(workspace.join(squatted).parent().unwrap()).unwrap();
            std::fs::write(workspace.join(squatted), b"mine").unwrap();
            let err = super::ensure_private_dir(&workspace, relative()).unwrap_err();
            assert_eq!(
                refusal(&err),
                (squatted, super::NotPrivateReason::NotFolder)
            );
            assert_eq!(std::fs::read(workspace.join(squatted)).unwrap(), b"mine");
        }
    }

    /// The path and reason a refusal names.
    fn refusal(err: &std::io::Error) -> (&str, super::NotPrivateReason) {
        let refused = super::not_private(err).unwrap_or_else(|| panic!("{err}"));
        (refused.path.to_str().unwrap(), refused.reason)
    }

    /// A network share keeps its server's ACLs and modes. The seam stands in
    /// for one, and fails the test if anything writes an ACL.
    const REMOTE: super::System = super::System {
        local: |_| Ok(false),
        remove_acl: |_| panic!("wrote a network folder's ACL"),
        ..super::System::REAL
    };

    /// Another owner, as a share that maps every user to one uid shows, is
    /// taken too. A link is still refused.
    #[test]
    fn a_folder_on_a_network_volume_opens_unchanged() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-remote").unwrap();
        let workspace = shared_workspace(&scratch);
        let squashed = super::System {
            owner: Some(rustix::process::geteuid().as_raw() + 1),
            ..REMOTE
        };
        super::ensure_private_dir_with(&workspace, relative(), &squashed).unwrap();
        assert!(has_entries(&workspace.join(relative())));
        assert_eq!(mode(&workspace.join(relative())), 0o755);
        let linked = scratch.path().join("linked");
        std::fs::create_dir(&linked).unwrap();
        std::os::unix::fs::symlink(workspace.join(".dohc"), linked.join(".dohc")).unwrap();
        let err = super::ensure_private_dir_with(&linked, relative(), &REMOTE).unwrap_err();
        assert_eq!(refusal(&err), (".dohc", super::NotPrivateReason::Link));
        // The refusal names the link, never the owner the share shows.
        std::fs::remove_file(linked.join(".dohc")).unwrap();
        std::fs::create_dir(linked.join(".dohc")).unwrap();
        std::os::unix::fs::symlink(workspace.join(relative()), linked.join(relative())).unwrap();
        let err = super::ensure_private_dir_with(&linked, relative(), &squashed).unwrap_err();
        assert_eq!(
            refusal(&err),
            (".dohc/engine", super::NotPrivateReason::Link)
        );
        // This test's own volume is local.
        let folder = std::fs::File::open(scratch.path()).unwrap();
        assert!(super::is_local(std::os::fd::AsFd::as_fd(&folder)).unwrap());
    }

    /// A new folder on a network volume is created with a plain mkdir, so it
    /// takes what its parent gives it, as the server would decide, and no ACL
    /// is written.
    #[test]
    fn a_folder_created_on_a_network_volume_writes_no_acl() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-remote-new").unwrap();
        let workspace = scratch.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        add_entry(&workspace, INHERITED);
        super::ensure_private_dir_with(&workspace, relative(), &REMOTE).unwrap();
        for folder in [workspace.join(".dohc"), workspace.join(relative())] {
            assert!(has_entries(&folder), "{}", folder.display());
            assert_eq!(mode(&folder), 0o700, "{}", folder.display());
        }
    }

    #[test]
    fn removing_a_files_entries_leaves_it_none() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-file").unwrap();
        let path = scratch.path().join("engine.db");
        std::fs::write(&path, b"store").unwrap();
        add_entry(&path, "group:everyone allow read");
        let folder = std::fs::File::open(scratch.path()).unwrap();
        let name = std::ffi::OsStr::new("engine.db");
        super::remove_acl_entries_in(&folder, relative(), name).unwrap();
        assert!(!has_entries(&path));
        super::remove_acl_entries_in(&folder, relative(), name).unwrap();
        // A file that is gone has none.
        super::remove_acl_entries_in(&folder, relative(), std::ffi::OsStr::new("gone")).unwrap();
    }

    /// A folder renamed after its path is read, with another put at its
    /// name, keeps its own file's entries from being removed only if the path
    /// names it by ID (#2375).
    #[test]
    fn removing_a_files_entries_reaches_its_folder_after_a_swap() {
        use std::os::fd::AsFd;
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-file-swap").unwrap();
        let dir = scratch.path().join("engine");
        let moved = scratch.path().join("moved");
        let store = |dir: &std::path::Path, text: &[u8]| {
            std::fs::write(dir.join("engine.db"), text).unwrap();
            add_entry(&dir.join("engine.db"), "group:everyone allow read");
        };
        std::fs::create_dir(&dir).unwrap();
        store(&dir, b"store");
        let folder = std::fs::File::open(&dir).unwrap();
        let swap = || {
            std::fs::rename(&dir, &moved).unwrap();
            std::fs::create_dir(&dir).unwrap();
            store(&dir, b"theirs");
        };
        let name = std::ffi::OsStr::new("engine.db");
        super::remove_acl_entries_in_with(folder.as_fd(), relative(), name, swap).unwrap();
        assert!(!has_entries(&moved.join("engine.db")));
        assert!(has_entries(&dir.join("engine.db")));
    }

    /// On a volume that keeps owners, a path by ID that names another folder,
    /// or that the volume can't look up, is refused rather than traded for
    /// the plain path. The seam stands in for both.
    #[test]
    fn a_path_by_id_that_misses_the_folder_is_refused() {
        use std::os::fd::AsFd;
        let scratch = dohc_test_scratch::ScratchDir::new_named("path-by-id-missed").unwrap();
        let folder = std::fs::File::open(scratch.path()).unwrap();
        let other = scratch.path().join("other");
        std::fs::create_dir(&other).unwrap();
        let elsewhere = |_: &std::path::Path| Ok(rustix::fs::stat(&other)?);
        let missing = |_: &std::path::Path| Err(std::io::ErrorKind::NotFound.into());
        for err in [
            super::path_by_id_with(folder.as_fd(), relative(), true, elsewhere).unwrap_err(),
            super::path_by_id_with(folder.as_fd(), relative(), true, missing).unwrap_err(),
        ] {
            assert_eq!(
                refusal(&err),
                (".dohc/engine", super::NotPrivateReason::UncheckedVolume)
            );
        }
    }

    /// A volume that ignores owners, such as FAT, exFAT or an external disk,
    /// keeps the plain path without looking up the path by ID.
    #[test]
    fn a_volume_without_owners_keeps_the_plain_path() {
        use std::os::fd::AsFd;
        let scratch = dohc_test_scratch::ScratchDir::new_named("path-by-id-owners").unwrap();
        let folder = std::fs::File::open(scratch.path()).unwrap();
        let looked_up = |_: &std::path::Path| panic!("looked up a path by ID");
        let plain = super::path_by_id_with(folder.as_fd(), relative(), false, looked_up);
        assert_eq!(plain.unwrap(), None);
    }

    #[test]
    fn only_local_volumes_that_keep_owners_go_by_id() {
        let kind = |name: &str| {
            let mut field = [0; 16];
            for (slot, byte) in field.iter_mut().zip(name.bytes()) {
                *slot = byte as std::ffi::c_char;
            }
            field
        };
        let local = libc::MNT_LOCAL as u32;
        assert!(super::owned_volume(local, &kind("apfs")));
        assert!(super::owned_volume(local, &kind("hfs")));
        let ignored = local | super::MNT_IGNORE_OWNERSHIP;
        assert!(!super::owned_volume(ignored, &kind("apfs")));
        assert!(!super::owned_volume(local, &kind("msdos")));
        assert!(!super::owned_volume(local, &kind("exfat")));
        assert!(!super::owned_volume(0, &kind("smbfs")));
    }

    /// A file written through the path by ID lands in the folder after its
    /// name moves, and none lands in a folder put at the name.
    #[test]
    fn a_path_by_id_names_the_folder_and_never_one_in_its_place() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("path-by-id").unwrap();
        let dir = scratch.path().join("engine");
        std::fs::create_dir(&dir).unwrap();
        let folder = std::fs::File::open(&dir).unwrap();
        let by_id = super::path_by_id(&folder, relative())
            .unwrap()
            .expect("APFS resolves a path by ID");
        let moved = scratch.path().join("moved");
        std::fs::rename(&dir, &moved).unwrap();
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(by_id.join("engine.db"), b"store").unwrap();
        assert_eq!(std::fs::read(moved.join("engine.db")).unwrap(), b"store");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let current = std::fs::canonicalize(&moved).unwrap();
        assert_eq!(super::path_by_name(&by_id).unwrap(), current);
        assert_eq!(super::path_by_name(&dir).unwrap(), dir);
    }

    /// A local volume can keep a folder's entries too. The seam keeps them
    /// the way such a volume would.
    #[test]
    fn a_folder_the_volume_keeps_shared_is_refused() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-served").unwrap();
        let keeps = super::System {
            remove_acl: |_| {},
            before_protect: |path| {
                add_entry(path, "group:everyone allow list");
                Ok(())
            },
            ..system(None)
        };
        let err = super::ensure_private_dir_with(scratch.path(), relative(), &keeps).unwrap_err();
        assert!(super::volume_shares_new_files(&err), "{err}");
        assert!(
            !scratch.path().join(relative()).exists(),
            "the folder this call created stays"
        );

        let workspace = shared_workspace(&scratch);
        let keeps = super::System {
            remove_acl: |_| {},
            ..system(None)
        };
        let err = super::ensure_private_dir_with(&workspace, relative(), &keeps).unwrap_err();
        assert!(super::volume_shares_new_files(&err), "{err}");
        let store = workspace.join(relative()).join("engine.db");
        assert!(store.exists(), "an existing folder is removed");
    }

    /// The create succeeds, then the step after it fails while another
    /// process puts a file in the folder and the volume adds entries. The
    /// folder stays, and the next call makes it private before using it.
    #[test]
    fn a_folder_left_by_a_failed_create_is_made_private_next_time() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-failed").unwrap();
        let fail = super::System {
            before_protect: |path| {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
                add_entry(path, INHERITED);
                std::fs::write(path.join("ROOT_BINDING.lock"), b"").unwrap();
                Err(std::io::Error::other("open failed"))
            },
            ..system(None)
        };
        let engine_dir = scratch.path().join(relative());
        super::ensure_private_dir_with(scratch.path(), relative(), &fail).unwrap_err();
        assert!(has_entries(&engine_dir));
        super::ensure_private_dir(scratch.path(), relative()).unwrap();
        assert!(!has_entries(&engine_dir));
        assert_eq!(mode(&engine_dir), 0o700);
    }

    fn add_entry(path: &std::path::Path, entry: &str) {
        let added = std::process::Command::new("/bin/chmod")
            .args(["+a", entry])
            .arg(path)
            .status()
            .unwrap();
        assert!(added.success());
    }

    /// The folder is renamed after its path is read and another takes its
    /// name, so the file is created in the replacement.
    #[test]
    fn a_file_created_in_a_swapped_folder_is_removed() {
        use std::os::fd::AsFd;
        let scratch = dohc_test_scratch::ScratchDir::new_named("create-swapped").unwrap();
        let dir = scratch.path().join("ws");
        std::fs::create_dir(&dir).unwrap();
        let folder = std::fs::File::open(&dir).unwrap();
        let swap = || {
            std::fs::rename(&dir, scratch.path().join("moved")).unwrap();
            std::fs::create_dir(&dir).unwrap();
        };
        let name = std::ffi::OsStr::new("temp");
        let err =
            super::create_uninherited_with(folder.as_fd(), name, 0o600, swap, |_| {}).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{err}");
        assert!(!dir.join("temp").exists(), "the replacement keeps a file");
        assert!(!scratch.path().join("moved/temp").exists());
    }

    /// A network file system can apply the server's entries in place of the
    /// empty ACL. The seam adds one the way such a server would.
    #[test]
    fn a_file_given_acl_entries_is_removed_and_refused() {
        use std::os::fd::AsFd;
        use std::os::unix::ffi::OsStrExt;
        let scratch = dohc_test_scratch::ScratchDir::new_named("create-served-acl").unwrap();
        let folder = std::fs::File::open(scratch.path()).unwrap();
        let grant = |path: &std::ffi::CStr| {
            let path = std::path::Path::new(std::ffi::OsStr::from_bytes(path.to_bytes()));
            add_entry(path, "group:everyone allow read");
        };
        let name = std::ffi::OsStr::new("temp");
        let err =
            super::create_uninherited_with(folder.as_fd(), name, 0o600, || {}, grant).unwrap_err();
        assert!(super::volume_shares_new_files(&err), "{err}");
        assert!(!scratch.path().join("temp").exists());
    }

    #[test]
    fn cleanup_never_removes_an_entry_that_took_the_files_place() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("create-cleanup").unwrap();
        let path = scratch.path().join("temp");
        std::fs::write(&path, b"created").unwrap();
        let created = std::os::fd::OwnedFd::from(std::fs::File::open(&path).unwrap());
        std::fs::rename(&path, scratch.path().join("aside")).unwrap();
        std::fs::write(&path, b"unrelated").unwrap();
        let c_path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        super::remove_if_same(&created, &c_path);
        assert_eq!(std::fs::read(&path).unwrap(), b"unrelated");
        std::fs::rename(scratch.path().join("aside"), &path).unwrap();
        super::remove_if_same(&created, &c_path);
        assert!(!path.exists());
    }
}
