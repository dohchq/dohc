//! Give a new file the access of the file it replaces.

use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows_sys::Win32::Foundation::{GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_NEW, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL,
};

use crate::private_dir::{Local, current_user, keeps_dacl, open, unsupported};

/// A file's DACL: its entries, and whether its folder's entries reach it.
pub struct Dacl(Local<core::ffi::c_void>);

impl Dacl {
    /// The DACL of the regular file at `path`, read without following a
    /// link. Nothing there, a link, a folder, or a volume that keeps no DACL
    /// gives `None`. Reading needs `READ_CONTROL`, which a file's owner has
    /// unless an OWNER RIGHTS entry takes it away.
    pub fn of_file_at(path: &Path) -> io::Result<Option<Self>> {
        // Neither right is subject to another handle's sharing.
        let file = match std::fs::OpenOptions::new()
            .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
        {
            Ok(file) => file,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err),
        };
        let kind = file.metadata()?.file_type();
        if kind.is_symlink() || !kind.is_file() {
            return Ok(None);
        }
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: The handle is open for this synchronous call. `descriptor`
        // is freed once, by `Local`.
        #[allow(unsafe_code)]
        let status = unsafe {
            GetSecurityInfo(
                file.as_raw_handle() as HANDLE,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            )
        };
        if status == 0 {
            return Ok(Some(Self(Local(descriptor))));
        }
        let err = io::Error::from_raw_os_error(status as i32);
        if unsupported(&err) {
            Ok(None)
        } else {
            Err(err)
        }
    }

    /// The DACL for a new private file in `folder`: protected from the
    /// folders above, with full control for this user, SYSTEM and
    /// Administrators, as a user's profile folder gives its files. A volume
    /// that keeps no DACL, or a network share, gives `None`, as
    /// [`crate::ensure_private_dir`] leaves its folders there.
    pub fn private_file_in(folder: &Path) -> io::Result<Option<Self>> {
        if !keeps_dacl(&open(folder, FILE_READ_ATTRIBUTES, 0)?)? {
            return Ok(None);
        }
        let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{})", current_user()?);
        let sddl: Vec<u16> = sddl.encode_utf16().chain([0]).collect();
        let mut descriptor = std::ptr::null_mut();
        // SAFETY: The string ends with one null and outlives this synchronous
        // call. The descriptor it returns is freed once, by `Local`.
        #[allow(unsafe_code)]
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        };
        if converted == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(Self(Local(descriptor))))
    }
}

/// Create a file at `path`, open for writing, with `dacl` from the moment it
/// exists, so nothing can open it while it has only its folder's entries.
/// It keeps the DACL's entries and protection; Windows does not keep the
/// flag that marks a DACL as auto-inherited, and a later change to the
/// folder still reaches the file. `None` gives the folder's entries, as a
/// new file has. Anything already at `path`, a link included, fails with
/// `AlreadyExists`.
pub fn create_new_with_dacl(path: &Path, dacl: Option<&Dacl>) -> io::Result<File> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "a file path contains a null character",
        ));
    }
    wide.push(0);
    let attributes = dacl.map(|dacl| SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: dacl.0.0,
        bInheritHandle: 0,
    });
    // SAFETY: The path ends with one null and, like the descriptor, outlives
    // this synchronous call, which copies the descriptor and retains neither.
    #[allow(unsafe_code)]
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            attributes
                .as_ref()
                .map_or(std::ptr::null(), std::ptr::from_ref),
            CREATE_NEW,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateFileW returned this open handle for the caller to close.
    #[allow(unsafe_code)]
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    Ok(File::from(handle))
}
