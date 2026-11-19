//! Folders and files opened by path and refused unless the handle is still at
//! that path, so a link anywhere along it can't lead outside. The open itself
//! still follows the link before the refusal, so a link to a network share
//! still reaches that share. No handle is held between opens: a held handle on
//! a folder stops every ancestor of it from being renamed.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::OpenOptionsExt;
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use windows_sys::Win32::Foundation::{ERROR_CANT_RESOLVE_FILENAME, ERROR_NO_MORE_FILES};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_BOTH_DIR_INFO, FILE_LIST_DIRECTORY, FILE_NAME_NORMALIZED,
    FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
    GetFinalPathNameByHandleW, SYNCHRONIZE, VOLUME_NAME_DOS,
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const NAME_SURROGATE: u32 = 0x2000_0000;

/// The folder `path` names, through any links, in the form the other opens
/// here take.
pub fn root(path: &Path) -> io::Result<PathBuf> {
    final_path(&folder(path)?)
}

fn final_path(file: &File) -> io::Result<PathBuf> {
    let mut buffer = vec![0u16; 512];
    loop {
        let capacity = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
        // SAFETY: The handle is open and the buffer holds `capacity` writable
        // units for this synchronous call. Windows keeps neither.
        #[allow(unsafe_code)]
        let written = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if written == 0 {
            return Err(io::Error::last_os_error());
        }
        if written < buffer.len() {
            buffer.truncate(written);
            return Ok(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(written, 0);
    }
}

/// `file`, opened at `path`, with the path it was found at. Only the last
/// name may differ, and only in ASCII case, as a case-insensitive folder
/// finds it. Any other difference, or a path Windows can't name, refuses it
/// with an error that isn't "not found", so the walk keeps what it saw there.
fn in_place(file: File, path: &Path) -> io::Result<(File, PathBuf)> {
    match final_path(&file) {
        Ok(found)
            if found == path
                || found.parent() == path.parent()
                    && found
                        .file_name()
                        .zip(path.file_name())
                        .is_some_and(|(found, name)| found.eq_ignore_ascii_case(name)) =>
        {
            Ok((file, found))
        }
        _ => Err(io::Error::from_raw_os_error(
            ERROR_CANT_RESOLVE_FILENAME as i32,
        )),
    }
}

/// A folder to list, following links only to check none was on the way.
fn open_folder(path: &Path) -> io::Result<File> {
    Ok(in_place(folder(path)?, path)?.0)
}

fn folder(path: &Path) -> io::Result<File> {
    File::options()
        .access_mode(FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

/// A file to read.
pub fn open_file(path: &Path) -> io::Result<File> {
    let file = File::options()
        .read(true)
        .share_mode(SHARE_ALL)
        .open(path)?;
    Ok(in_place(file, path)?.0)
}

/// The entry at `path` itself, a link or not, for its metadata, with the
/// path it was found at.
pub fn open_entry(path: &Path) -> io::Result<(File, PathBuf)> {
    let file = File::options()
        .access_mode(FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(SHARE_ALL)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    in_place(file, path)
}

/// One name in a folder, with its facts as the listing reports them.
pub struct Entry {
    pub name: OsString,
    pub folder: bool,
    /// A symlink, junction or other link to another name. Cloud placeholders
    /// and other reparse points that hold their own data are not links.
    pub link: bool,
    pub size: u64,
    pub modified: Option<SystemTime>,
}

/// The names in the folder at `path`, read from one handle opened there.
/// The first batch is read here, so a path that opens but can't be listed,
/// such as a file, fails like `read_dir` rather than on its first entry.
pub fn list(path: &Path) -> io::Result<Listing> {
    let mut listing = Listing {
        folder: open_folder(path)?,
        buffer: vec![0; 8 * 1024],
        next: None,
        restart: true,
        done: false,
    };
    listing.fetch()?;
    Ok(listing)
}

pub struct Listing {
    folder: File,
    /// `u64`s keep the records 8-byte aligned, as Windows writes them.
    buffer: Vec<u64>,
    next: Option<usize>,
    restart: bool,
    done: bool,
}

impl Iterator for Listing {
    type Item = io::Result<Entry>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some(offset) = self.next.take() {
                match self.entry_at(offset) {
                    Ok(Some(entry)) => return Some(Ok(entry)),
                    Ok(None) => continue,
                    Err(error) => {
                        self.done = true;
                        return Some(Err(error));
                    }
                }
            }
            if self.done {
                return None;
            }
            if let Err(error) = self.fetch() {
                self.done = true;
                return Some(Err(error));
            }
        }
    }
}

impl Listing {
    /// Reads the next batch of records into the buffer.
    fn fetch(&mut self) -> io::Result<()> {
        let class = if self.restart {
            FileIdBothDirectoryRestartInfo
        } else {
            FileIdBothDirectoryInfo
        };
        self.restart = false;
        let bytes = u32::try_from(self.buffer.len() * 8).unwrap_or(u32::MAX);
        // SAFETY: The handle is open and the buffer holds `bytes` writable,
        // 8-byte aligned bytes for this synchronous call.
        #[allow(unsafe_code)]
        let listed = unsafe {
            GetFileInformationByHandleEx(
                self.folder.as_raw_handle(),
                class,
                self.buffer.as_mut_ptr().cast(),
                bytes,
            )
        };
        if listed == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            self.done = true;
        } else {
            self.next = Some(0);
        }
        Ok(())
    }
}

impl Listing {
    /// The record at `offset`, or `None` for `.` and `..`.
    fn entry_at(&mut self, offset: usize) -> io::Result<Option<Entry>> {
        use std::mem::offset_of;
        // SAFETY: Any bytes are valid `u8`s, and the view lives no longer
        // than the borrow of the buffer it reads.
        #[allow(unsafe_code)]
        let bytes = unsafe {
            std::slice::from_raw_parts(self.buffer.as_ptr().cast::<u8>(), self.buffer.len() * 8)
        };
        let malformed = || io::Error::new(io::ErrorKind::InvalidData, "a malformed folder listing");
        let record = bytes.get(offset..).ok_or_else(malformed)?;
        let u32_at = |at: usize| {
            record
                .get(at..at + 4)
                .map(|field| u32::from_ne_bytes(field.try_into().unwrap_or_default()))
                .ok_or_else(malformed)
        };
        let i64_at = |at: usize| {
            record
                .get(at..at + 8)
                .map(|field| i64::from_ne_bytes(field.try_into().unwrap_or_default()))
                .ok_or_else(malformed)
        };
        let next = u32_at(offset_of!(FILE_ID_BOTH_DIR_INFO, NextEntryOffset))? as usize;
        let attributes = u32_at(offset_of!(FILE_ID_BOTH_DIR_INFO, FileAttributes))?;
        // A reparse point's tag takes the place of its extended attributes' size.
        let tag = u32_at(offset_of!(FILE_ID_BOTH_DIR_INFO, EaSize))?;
        let size = i64_at(offset_of!(FILE_ID_BOTH_DIR_INFO, EndOfFile))?;
        let modified = i64_at(offset_of!(FILE_ID_BOTH_DIR_INFO, LastWriteTime))?;
        let name_bytes = u32_at(offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength))? as usize;
        let name_at = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let name: Vec<u16> = record
            .get(name_at..name_at + name_bytes)
            .ok_or_else(malformed)?
            .chunks_exact(2)
            .map(|unit| u16::from_ne_bytes([unit[0], unit[1]]))
            .collect();
        if next != 0 {
            self.next = Some(offset + next);
        }
        if name == [u16::from(b'.')] || name == [u16::from(b'.'); 2] {
            return Ok(None);
        }
        if name.is_empty()
            || name
                .iter()
                .any(|&unit| [b'\\', b'/', b':'].map(u16::from).contains(&unit))
        {
            return Err(malformed());
        }
        let link = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 && tag & NAME_SURROGATE != 0;
        Ok(Some(Entry {
            name: OsString::from_wide(&name),
            folder: attributes & FILE_ATTRIBUTE_DIRECTORY != 0 && !link,
            link,
            size: u64::try_from(size).unwrap_or(0),
            modified: system_time(modified),
        }))
    }
}

/// A Windows file time: 100-nanosecond steps since 1601.
fn system_time(steps: i64) -> Option<SystemTime> {
    const UNIX_EPOCH_STEPS: i64 = 116_444_736_000_000_000;
    let since = steps.checked_sub(UNIX_EPOCH_STEPS)?;
    let span = Duration::new(
        since.unsigned_abs() / 10_000_000,
        (since.unsigned_abs() % 10_000_000) as u32 * 100,
    );
    if since < 0 {
        SystemTime::UNIX_EPOCH.checked_sub(span)
    } else {
        SystemTime::UNIX_EPOCH.checked_add(span)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_test_scratch::ScratchDir;

    fn junction(link: &Path, target: &Path) {
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
    }

    #[test]
    fn a_listing_reports_what_the_path_metadata_reports() {
        let scratch = ScratchDir::new_named("in-place-list").unwrap();
        let root = root(scratch.path()).unwrap();
        std::fs::create_dir(root.join("folder")).unwrap();
        std::fs::write(root.join("file.md"), "four").unwrap();
        junction(&scratch.path().join("link"), &scratch.path().join("folder"));
        let mut entries: Vec<_> = list(&root).unwrap().map(Result::unwrap).collect();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<_> = entries.iter().map(|entry| entry.name.clone()).collect();
        assert_eq!(names, ["file.md", "folder", "link"]);
        for entry in &entries {
            let metadata = std::fs::symlink_metadata(root.join(&entry.name)).unwrap();
            assert_eq!(entry.folder, metadata.is_dir(), "{:?}", entry.name);
            assert_eq!(entry.link, metadata.is_symlink(), "{:?}", entry.name);
            assert_eq!(entry.modified, metadata.modified().ok(), "{:?}", entry.name);
        }
        assert_eq!(entries[0].size, 4);
    }

    #[test]
    fn listing_a_file_fails_before_any_entry() {
        let scratch = ScratchDir::new_named("in-place-list-file").unwrap();
        let file = root(scratch.path()).unwrap().join("file.md");
        std::fs::write(&file, "not a folder").unwrap();
        assert!(list(&file).is_err());
    }

    #[test]
    fn a_listing_reads_past_one_buffer() {
        let scratch = ScratchDir::new_named("in-place-many").unwrap();
        let root = root(scratch.path()).unwrap();
        for i in 0..2000 {
            std::fs::write(root.join(format!("a-long-enough-name-{i:04}.md")), "").unwrap();
        }
        assert_eq!(list(&root).unwrap().count(), 2000);
    }

    #[test]
    fn a_link_on_the_way_is_refused() {
        let scratch = ScratchDir::new_named("in-place-link").unwrap();
        std::fs::create_dir_all(scratch.path().join("outside").join("deeper")).unwrap();
        std::fs::write(
            scratch
                .path()
                .join("outside")
                .join("deeper")
                .join("secret.md"),
            "secret",
        )
        .unwrap();
        junction(
            &scratch.path().join("link"),
            &scratch.path().join("outside"),
        );
        let root = root(scratch.path()).unwrap();
        let at = |names: &[&str]| {
            names
                .iter()
                .fold(root.clone(), |path, name| path.join(name))
        };
        let refused =
            |error: io::Error| error.raw_os_error() == Some(ERROR_CANT_RESOLVE_FILENAME as i32);
        assert!(refused(list(&at(&["link", "deeper"])).err().unwrap()));
        assert!(refused(list(&at(&["link"])).err().unwrap()));
        assert!(refused(
            open_file(&at(&["link", "deeper", "secret.md"])).unwrap_err()
        ));
        assert!(refused(open_entry(&at(&["link", "deeper"])).unwrap_err()));
        let (link, _) = open_entry(&at(&["link"])).unwrap();
        assert!(link.metadata().unwrap().is_symlink());
        let (_, found) = open_entry(&at(&["OUTSIDE"])).unwrap();
        assert_eq!(found, at(&["outside"]));
        assert!(refused(
            open_file(&at(&["OUTSIDE", "deeper", "secret.md"])).unwrap_err()
        ));
        assert!(open_file(&at(&["outside", "deeper", "secret.md"])).is_ok());
    }

    #[test]
    fn a_listed_name_that_is_not_one_name_is_refused() {
        use std::mem::offset_of;
        let scratch = ScratchDir::new_named("in-place-name").unwrap();
        let parse = |name: &str| {
            let mut bytes = vec![0u8; 1024];
            let units: Vec<u16> = name.encode_utf16().collect();
            let length = offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength);
            bytes[length..length + 4].copy_from_slice(&(units.len() as u32 * 2).to_ne_bytes());
            let at = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
            for (i, unit) in units.iter().enumerate() {
                bytes[at + i * 2..at + i * 2 + 2].copy_from_slice(&unit.to_ne_bytes());
            }
            let mut listing = list(&root(scratch.path()).unwrap()).unwrap();
            listing.buffer = bytes
                .chunks_exact(8)
                .map(|chunk| u64::from_ne_bytes(chunk.try_into().unwrap()))
                .collect();
            listing
                .entry_at(0)
                .map(|entry| entry.map(|entry| entry.name))
        };
        assert_eq!(parse("note.md").unwrap(), Some("note.md".into()));
        for name in ["C:\\outside", "..\\outside", "a/b", "file.md:stream", ""] {
            let error = parse(name).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData, "{name:?}");
        }
    }
}
