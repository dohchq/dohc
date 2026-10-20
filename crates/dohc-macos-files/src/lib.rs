//! Create a file without the ACL entries its folder gives new files, keep a
//! folder private to its owner, copy a file's macOS ACL and extended
//! attributes between open descriptors, flush a descriptor behind a drive
//! write barrier, keep a folder out of iCloud Drive, and unlink a file only
//! when no process has it open.
#![cfg(target_vendor = "apple")]
use std::ffi::{CStr, CString, OsStr, c_char, c_int, c_uint, c_void};
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

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
    if acl.is_null() {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ENOENT | libc::ENOTSUP | libc::EOPNOTSUPP) => Ok(false),
            _ => Err(err),
        };
    }
    let mut entry = std::ptr::null_mut();
    // SAFETY: `acl` came from acl_get_fd_np. acl_get_entry only reads it and
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

/// Create the folder `path`, and any missing folder above it, or take the
/// folder already there, and make it private: refuse it unless this
/// process's user owns it, then give it mode 0700 and no ACL entries. Others
/// then cannot reach anything in it, whatever its files' own modes and ACLs.
/// A folder created here takes none of the entries its parent gives new
/// folders, so nothing created in it inherits any. A link at `path` is
/// refused. A folder the volume keeps ACL entries on fails with
/// [`VolumeSharesNewFiles`]. On a refusal, only an empty folder this call
/// created is removed.
pub fn ensure_private_dir(path: &Path) -> io::Result<()> {
    let owner = rustix::process::geteuid().as_raw();
    ensure_private_dir_with(path, owner, |_| Ok(()), remove_acl)
}

/// [`ensure_private_dir`], with seams for the owner it expects, a step just
/// before the folder is made private, and the ACL removal.
fn ensure_private_dir_with(
    path: &Path,
    owner: u32,
    before_protect: impl FnOnce(&Path) -> io::Result<()>,
    remove_acl: impl FnOnce(BorrowedFd<'_>),
) -> io::Result<()> {
    let (parent, name) = split(path)?;
    create_dirs(parent)?;
    let parent = std::fs::File::open(parent)?;
    let created = mkdir_uninherited(parent.as_fd(), name)?;
    let protected =
        before_protect(path).and_then(|()| protect(parent.as_fd(), name, owner, remove_acl));
    if protected.is_err() && created {
        // Removes the folder only while it is empty.
        let _ = rustix::fs::unlinkat(&parent, name, rustix::fs::AtFlags::REMOVEDIR);
    }
    protected
}

/// Create `path` and any missing folder above it the way
/// [`ensure_private_dir`] creates one. A folder that exists is left as it is.
fn create_dirs(path: &Path) -> io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    let (parent, name) = split(path)?;
    create_dirs(parent)?;
    mkdir_uninherited(std::fs::File::open(parent)?.as_fd(), name).map(drop)
}

fn split(path: &Path) -> io::Result<(&Path, &OsStr)> {
    let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::ErrorKind::InvalidInput.into());
    };
    if parent.as_os_str().is_empty() {
        return Ok((Path::new("."), name));
    }
    Ok((parent, name))
}

/// Create the folder `name` in `dir` with mode 0700 less the umask and none
/// of the ACL entries `dir` gives new folders. Return whether this call
/// created it. Anything already at the name is left for the caller.
fn mkdir_uninherited(dir: BorrowedFd<'_>, name: &OsStr) -> io::Result<bool> {
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
    let made = match made {
        // A file system without ACLs, such as FAT, refuses one at creation,
        // and has none for the folder to inherit.
        Err(err) if err.raw_os_error() == Some(libc::EINVAL) && !has_acls(dir) => {
            let mode = rustix::fs::Mode::from_raw_mode(PRIVATE_DIR_MODE);
            rustix::fs::mkdirat(dir, name, mode).map_err(io::Error::from)
        }
        made => made.map(drop),
    };
    match made {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err),
    }
}

/// Refuse `name` in `dir` unless it is a folder, not a link, that `owner`
/// owns. Then give it mode 0700 and, through `remove_acl`, no ACL entries.
fn protect(
    dir: BorrowedFd<'_>,
    name: &OsStr,
    owner: u32,
    remove_acl: impl FnOnce(BorrowedFd<'_>),
) -> io::Result<()> {
    use rustix::fs::{Mode, OFlags};
    let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let folder = rustix::fs::openat(dir, name, flags, Mode::empty())?;
    let stat = rustix::fs::fstat(&folder)?;
    if stat.st_uid != owner {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "another user owns this folder, so dohc can't keep it private",
        ));
    }
    if stat.st_mode & 0o7777 != PRIVATE_DIR_MODE {
        rustix::fs::fchmod(&folder, Mode::from_raw_mode(PRIVATE_DIR_MODE))?;
    }
    if has_entries(folder.as_fd())? {
        remove_acl(folder.as_fd());
        if has_entries(folder.as_fd())? {
            return Err(io::Error::other(VolumeSharesNewFiles));
        }
    }
    Ok(())
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
    let kind: Vec<u8> = kind
        .iter()
        .take_while(|&&byte| byte != 0)
        .map(|&byte| byte as u8)
        .collect();
    BUSY_CHECKED.contains(&kind.as_slice())
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

    /// A folder made the way an earlier build made `.dohc/engine`: mode 0755
    /// and the entries of a workspace folder that passes them on.
    fn shared_folder(scratch: &dohc_test_scratch::ScratchDir) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let workspace = scratch.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        add_entry(&workspace, INHERITED);
        let engine = workspace.join("engine");
        std::fs::create_dir(&engine).unwrap();
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(engine.join("engine.db"), b"store").unwrap();
        assert!(has_entries(&engine));
        engine
    }

    #[test]
    fn a_new_private_folder_takes_none_of_its_folders_acl() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-new").unwrap();
        let dir = scratch.path().join("shared");
        std::fs::create_dir(&dir).unwrap();
        add_entry(&dir, INHERITED);
        let engine = dir.join(".dohc/engine");
        super::ensure_private_dir(&engine).unwrap();
        for folder in [dir.join(".dohc"), engine.clone()] {
            assert!(!has_entries(&folder), "{}", folder.display());
            assert_eq!(mode(&folder), 0o700, "{}", folder.display());
        }
        // What is created inside inherits nothing either.
        std::fs::write(engine.join("engine.db"), b"").unwrap();
        std::fs::create_dir(engine.join("displaced")).unwrap();
        assert!(!has_entries(&engine.join("engine.db")));
        assert!(!has_entries(&engine.join("displaced")));
        super::ensure_private_dir(&engine).unwrap();
    }

    #[test]
    fn an_existing_folder_is_made_private_and_keeps_its_contents() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-existing").unwrap();
        let engine = shared_folder(&scratch);
        super::ensure_private_dir(&engine).unwrap();
        assert!(!has_entries(&engine));
        assert_eq!(mode(&engine), 0o700);
        assert_eq!(std::fs::read(engine.join("engine.db")).unwrap(), b"store");
    }

    #[test]
    fn a_link_at_the_folder_is_refused_and_its_target_left_alone() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-link").unwrap();
        let target = shared_folder(&scratch);
        let link = scratch.path().join("engine");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        super::ensure_private_dir(&link).unwrap_err();
        assert!(has_entries(&target));
        assert_eq!(mode(&target), 0o755);
    }

    /// Making a folder another user owns needs root, so the seam expects
    /// another owner instead.
    #[test]
    fn a_folder_another_user_owns_is_refused_and_left_alone() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-owner").unwrap();
        let engine = shared_folder(&scratch);
        let other = rustix::process::geteuid().as_raw() + 1;
        let err = super::ensure_private_dir_with(&engine, other, |_| Ok(()), super::remove_acl)
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied, "{err}");
        assert!(has_entries(&engine));
        assert_eq!(mode(&engine), 0o755);
    }

    /// A network file system can keep its server's entries on a folder. The
    /// seam keeps them the way such a server would.
    #[test]
    fn a_folder_the_volume_keeps_shared_is_refused() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-served").unwrap();
        let owner = rustix::process::geteuid().as_raw();
        let new = scratch.path().join("new");
        let grant = |path: &std::path::Path| {
            add_entry(path, "group:everyone allow list");
            Ok(())
        };
        let err = super::ensure_private_dir_with(&new, owner, grant, |_| {}).unwrap_err();
        assert!(super::volume_shares_new_files(&err), "{err}");
        assert!(!new.exists(), "the folder this call created stays");

        let existing = shared_folder(&scratch);
        let err = super::ensure_private_dir_with(&existing, owner, |_| Ok(()), |_| {}).unwrap_err();
        assert!(super::volume_shares_new_files(&err), "{err}");
        assert!(
            existing.join("engine.db").exists(),
            "an existing folder is removed"
        );
    }

    /// The create succeeds, then the step after it fails while another
    /// process puts a file in the folder and the volume adds entries. The
    /// folder stays, and the next call makes it private before using it.
    #[test]
    fn a_folder_left_by_a_failed_create_is_made_private_next_time() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = dohc_test_scratch::ScratchDir::new_named("private-failed").unwrap();
        let engine = scratch.path().join("engine");
        let owner = rustix::process::geteuid().as_raw();
        let fail = |path: &std::path::Path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
            add_entry(path, INHERITED);
            std::fs::write(path.join("ROOT_BINDING.lock"), b"").unwrap();
            Err(std::io::Error::other("open failed"))
        };
        super::ensure_private_dir_with(&engine, owner, fail, super::remove_acl).unwrap_err();
        assert!(has_entries(&engine));
        super::ensure_private_dir(&engine).unwrap();
        assert!(!has_entries(&engine));
        assert_eq!(mode(&engine), 0o700);
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
