//! Safe Windows file operations.

#[cfg(windows)]
mod private_dir;
#[cfg(windows)]
pub use private_dir::{NotPrivate, NotPrivateReason, ensure_private_dir, not_private};

#[cfg(windows)]
/// Move a file without replacing the destination or copying across volumes.
pub fn move_file_no_replace(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    use std::io::ErrorKind;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let wide = |path: &std::path::Path| -> std::io::Result<Vec<u16>> {
        let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(std::io::Error::new(
                ErrorKind::InvalidInput,
                "a file path contains a null character",
            ));
        }
        value.push(0);
        Ok(value)
    };
    let from = wide(from)?;
    let to = wide(to)?;
    // SAFETY: Both buffers remain alive and end with one null. The API
    // reads these paths synchronously and retains neither pointer.
    #[allow(unsafe_code)]
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) };
    if moved == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
/// Read the stored leaf name of an exact path, rejecting name-surrogate reparse points.
pub fn stored_leaf_name(path: &std::path::Path) -> std::io::Result<std::ffi::OsString> {
    use std::io::{Error, ErrorKind};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::Component;
    use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FindClose, FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW,
    };

    // FindFirstFileW accepts wildcards. Never turn an exact lookup into a search.
    // The verbatim path prefix can contain '?'; normal components cannot.
    let is_wildcard = |c| {
        [b'*', b'?', b'<', b'>', b'"']
            .into_iter()
            .any(|wildcard| c == u16::from(wildcard))
    };
    if path.file_name().is_none()
        || path.components().any(|part| {
            matches!(part, Component::Normal(name) if name.encode_wide().any(|c| c == 0 || is_wildcard(c)))
        })
    {
        return Err(Error::new(ErrorKind::InvalidInput, "expected an exact file path"));
    }
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "a file path contains a null character",
        ));
    }
    wide.push(0);
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: The null-terminated input and writable output live through this
    // synchronous call. Neither pointer is retained by Windows.
    #[allow(unsafe_code)]
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        return Err(Error::last_os_error());
    }
    // Case-sensitive directories can contain case variants, including hard
    // links. A name search must identify exactly one stored directory entry.
    let mut next = WIN32_FIND_DATAW::default();
    // SAFETY: The search handle is still open, and the writable output lives
    // through this synchronous call. Windows retains neither pointer.
    #[allow(unsafe_code)]
    let more = unsafe { FindNextFileW(handle, &mut next) };
    let search_error = (more == 0).then(Error::last_os_error);
    // SAFETY: This is the valid search handle just returned by FindFirstFileW.
    // It is closed exactly once, before any subsequent failure can return.
    #[allow(unsafe_code)]
    if unsafe { FindClose(handle) } == 0 {
        return Err(Error::last_os_error());
    }
    match search_error {
        Some(error) if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) => {}
        Some(error) => return Err(error),
        None => {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "multiple stored names match the file path",
            ));
        }
    }
    // Non-link reparse points, such as cloud placeholders, still name this file.
    if data.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        && data.dwReserved0 & 0x2000_0000 != 0
    {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "a name-surrogate reparse point has no spelling proof",
        ));
    }
    let end = data.cFileName.iter().position(|&c| c == 0).ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidData,
            "the stored file name is not terminated",
        )
    })?;
    Ok(std::ffi::OsString::from_wide(&data.cFileName[..end]))
}
