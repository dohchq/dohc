//! Recovery for drives that refuse ignore-readonly deletion. The normal NTFS
//! path never changes attributes and never creates this journal.

use std::fs::{File, OpenOptions};
use std::io::{self, ErrorKind, Read, Write};
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

#[derive(serde::Serialize, serde::Deserialize)]
struct Restore {
    incoming: PathBuf,
    target: PathBuf,
    volume: u64,
    index: u64,
    created: Option<u64>,
    attributes: u32,
}

const SUFFIX: &str = ".restore-attributes";

fn journal(incoming: &Path) -> PathBuf {
    let mut name = incoming.as_os_str().to_owned();
    name.push(SUFFIX);
    PathBuf::from(name)
}

fn open(path: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .access_mode(0x80 | 0x100) // FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES
        .custom_flags(0x0020_0000) // FILE_FLAG_OPEN_REPARSE_POINT
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || super::metadata_is_reparse_point(&metadata) {
        return Err(io::Error::from(ErrorKind::InvalidData));
    }
    Ok(file)
}

#[allow(
    clippy::permissions_set_readonly_false,
    reason = "Windows-only journaled attribute restoration"
)]
pub(super) fn remove(
    incoming: &Path,
    target: &Path,
    unlink: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    // Only displaced files need this fallback. Other placement inputs are
    // writable temps; never clear attributes where startup cannot find the log.
    let staging = incoming.parent().ok_or(ErrorKind::InvalidInput)?;
    let root = staging.ancestors().nth(3).ok_or(ErrorKind::InvalidInput)?;
    if root.join(super::STAGING_DIR) != staging {
        return Err(io::Error::from(ErrorKind::Unsupported));
    }
    validate_target(root, target)?;
    recover_one(incoming, target)?;
    let file = open(incoming)?;
    let info = winapi_util::file::information(&file)?;
    let original = file.metadata()?.permissions();
    let record = Restore {
        incoming: incoming.to_owned(),
        target: target.to_owned(),
        volume: info.volume_serial_number(),
        index: info.file_index(),
        created: info.creation_time(),
        attributes: file.metadata()?.file_attributes(),
    };
    let path = journal(incoming);
    // A partial record cannot precede an attribute change. Publish the complete,
    // flushed record before clearing read-only, even under DurabilityPolicy::none.
    let pending = path.with_extension("restore-attributes-pending");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?;
    output.write_all(&serde_json::to_vec(&record)?)?;
    output.sync_all()?;
    drop(output);
    std::fs::rename(&pending, &path)?;
    let mut writable = original.clone();
    writable.set_readonly(false);
    file.set_permissions(writable)?;
    let removed = unlink();
    file.set_permissions(original)?;
    std::fs::remove_file(path)?;
    removed
}

fn read(path: &Path) -> io::Result<Restore> {
    // A journal contains two paths and fixed-size metadata, never file content.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || super::metadata_is_reparse_point(&metadata) {
        return Err(io::Error::from(ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(1024 * 1024).read_to_end(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|err| io::Error::new(ErrorKind::InvalidData, err))
}

fn restore(path: &Path, record: &Restore) -> io::Result<()> {
    for name in [&record.incoming, &record.target] {
        let file = match open(name) {
            Ok(file) => file,
            Err(err) if err.kind() == ErrorKind::NotFound => continue,
            Err(err) => return Err(err),
        };
        let info = winapi_util::file::information(&file)?;
        if (
            info.volume_serial_number(),
            info.file_index(),
            info.creation_time(),
        ) != (record.volume, record.index, record.created)
        {
            continue;
        }
        // Only read-only was changed. Preserve the inode's other attributes,
        // including any that another application changed since the crash.
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(record.attributes & 1 != 0);
        file.set_permissions(permissions)?;
        return std::fs::remove_file(path);
    }
    // Neither name still identifies the original file. Do not change a replacement.
    std::fs::remove_file(path)
}

pub(super) fn recover_one(incoming: &Path, target: &Path) -> io::Result<()> {
    let path = journal(incoming);
    match read(&path) {
        Ok(record) => {
            if record.incoming != incoming || record.target != target {
                return Err(io::Error::from(ErrorKind::InvalidData));
            }
            restore(&path, &record)?;
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    // A crash during journal preparation changed no inode attributes.
    remove_pending(&path.with_extension("restore-attributes-pending"))
}

fn remove_pending(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

pub(super) fn recover_all(root: &Path, staging: &Path) -> io::Result<()> {
    let entries = match std::fs::read_dir(staging) {
        Ok(entries) => entries,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let path = entry?.path();
        if path
            .extension()
            .is_some_and(|ext| ext == "restore-attributes-pending")
        {
            remove_pending(&path)?;
            continue;
        }
        if path
            .extension()
            .is_none_or(|ext| ext != "restore-attributes")
        {
            continue;
        }
        let record = read(&path)?;
        if journal(&record.incoming) != path {
            return Err(io::Error::from(ErrorKind::InvalidData));
        }
        validate_target(root, &record.incoming)?;
        validate_target(root, &record.target)?;
        restore(&path, &record)?;
    }
    Ok(())
}

fn validate_target(root: &Path, path: &Path) -> io::Result<()> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| ErrorKind::InvalidData)?;
    if relative
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(io::Error::from(ErrorKind::InvalidData));
    }
    super::ensure_target_symlink_free(root, path).map_err(|err| io::Error::other(err.to_string()))
}
