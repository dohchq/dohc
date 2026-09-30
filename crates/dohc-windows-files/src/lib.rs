//! Safe exclusive Windows file rename.

#[cfg(windows)]
#[allow(unsafe_code)]
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
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
