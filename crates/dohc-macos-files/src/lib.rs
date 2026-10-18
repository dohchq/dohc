//! Copy a file's macOS ACL and extended attributes between open descriptors,
//! flush a descriptor behind a drive write barrier, and keep a folder out of
//! iCloud Drive.
#![cfg(target_vendor = "apple")]
use std::ffi::{CStr, c_char, c_int, c_uint, c_void};
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd};
use std::path::Path;

/// The attribute that tells macOS file providers, iCloud Drive among them,
/// not to sync an item or anything inside it.
pub const SYNC_IGNORE_XATTR: &CStr = c"com.apple.fileprovider.ignore#P";

/// The largest attribute value, or list of names, the copy reads.
const MAX_XATTR_BYTES: usize = 1 << 20;

/// `XATTR_OPERATION_INTENT_SAVE` in `<xattr_flags.h>`.
const XATTR_OPERATION_INTENT_SAVE: c_uint = 2;

/// `ACL_TYPE_EXTENDED` in `<sys/acl.h>`.
const ACL_TYPE_EXTENDED: c_int = 0x100;

// SAFETY: These match `<xattr_flags.h>`, macOS 10.10 and later, where
// `xattr_operation_intent_t` is `unsigned int`, and `<sys/acl.h>`, where
// `acl_type_t` is a C enum and `acl_t` is a pointer.
#[allow(unsafe_code)]
unsafe extern "C" {
    fn xattr_preserve_for_intent(name: *const c_char, intent: c_uint) -> c_int;
    fn acl_get_fd_np(fd: c_int, kind: c_int) -> *mut c_void;
    fn acl_free(acl: *mut c_void) -> c_int;
}

/// Copy `from`'s access control list to `to`, merged with the entries `to`
/// inherited from its folder. Permission bits, flags, ownership and times
/// are not copied, but fcopyfile always carries over a quarantine. An error
/// means `from`'s ACL may not have reached `to`. Success means only that `to`
/// has some ACL when `from` has one, not that `from`'s entries reached it.
pub fn copy_acl(from: impl AsFd, to: impl AsFd) -> io::Result<()> {
    let (from, to) = (from.as_fd(), to.as_fd());
    // SAFETY: Both descriptors stay open for the call and fcopyfile retains
    // neither. A null state asks fcopyfile to allocate and free its own.
    #[allow(unsafe_code)]
    let copied = unsafe {
        libc::fcopyfile(
            from.as_raw_fd(),
            to.as_raw_fd(),
            std::ptr::null_mut(),
            libc::COPYFILE_ACL,
        )
    };
    if copied < 0 {
        return Err(io::Error::last_os_error());
    }
    // fcopyfile reports success when it could not set the ACL. This check
    // catches a copy left with no ACL at all. It cannot tell inherited
    // entries from `from`'s.
    if has_acl(from)? && !has_acl(to)? {
        return Err(io::Error::other("the copy has no ACL"));
    }
    Ok(())
}

/// Whether the file has an access control list. A file system without ACLs
/// has none.
fn has_acl(fd: BorrowedFd<'_>) -> io::Result<bool> {
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
    // SAFETY: `acl` came from acl_get_fd_np and is freed once, here.
    #[allow(unsafe_code)]
    let _ = unsafe { acl_free(acl) };
    Ok(true)
}

/// Copy the extended attributes macOS keeps when an app saves a new version
/// of a file, such as Finder tags. Attributes tied to the old content, such
/// as `com.apple.TextEncoding`, are left out, and so are the resource fork
/// and any value over 1 MiB. An attribute that cannot be copied is skipped.
pub fn copy_saved_xattrs(from: impl AsFd, to: impl AsFd) {
    let (from, to) = (from.as_fd(), to.as_fd());
    let Some(names) = read_bounded(|list| rustix::fs::flistxattr(from, list)) else {
        return;
    };
    for name in names.split_inclusive(|&byte| byte == 0) {
        let Ok(name) = CStr::from_bytes_with_nul(name) else {
            continue;
        };
        if name == c"com.apple.ResourceFork" || !kept_on_save(name) {
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
}
