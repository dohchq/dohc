//! [`SecretDataKey`]: the 32-byte per-workspace AES-256-GCM data key, and the
//! versioned `.dohc/engine/secret.key` file format it round-trips through.
//!
//! Custody mirrors the TS store: the key lives in
//! a `0600` file as `dohc-secret-key-v1:<base64(32 bytes)>` plus a trailing
//! newline. The base64 parse is forgiving (Node parity, matrix §4.7); the real
//! guard is the exact 32-byte length. The key handle zeroizes on drop and
//! redacts under `Debug`, so it can never spill into a log or a serialized
//! payload.

use crate::base64;
use crate::error::CryptoError;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// The versioned prefix of the on-disk key file. The format is versioned so an
/// OS-keychain wrap can be layered on later without a migration.
const SECRET_KEY_FILE_PREFIX: &str = "dohc-secret-key-v1:";

/// AES-256 key size.
pub const SECRET_KEY_BYTES: usize = 32;

/// A 32-byte workspace data key. Zeroized on drop; `Debug` is redacted.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct SecretDataKey([u8; SECRET_KEY_BYTES]);

impl SecretDataKey {
    /// Wrap raw 32 bytes as a data key.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        let arr: [u8; SECRET_KEY_BYTES] = bytes
            .try_into()
            .map_err(|_| CryptoError::InvalidKeyLength)?;
        Ok(SecretDataKey(arr))
    }

    /// Generate a fresh random data key from the OS CSPRNG. Used on the first
    /// secret capture for a workspace (`loadSecretDataKey` create branch).
    pub fn generate() -> Result<Self, CryptoError> {
        let mut bytes = [0u8; SECRET_KEY_BYTES];
        // A CSPRNG failure is unrecoverable for key generation; surface it as an
        // invalid-key error rather than panicking.
        getrandom::fill(&mut bytes).map_err(|_| CryptoError::InvalidKeyLength)?;
        Ok(SecretDataKey(bytes))
    }

    /// Borrow the raw key bytes (for the AEAD primitive only).
    #[must_use]
    pub(crate) fn as_bytes(&self) -> &[u8; SECRET_KEY_BYTES] {
        &self.0
    }

    /// Parse the versioned key-file content. Forgiving base64 (Node parity); the
    /// 32-byte length is the authoritative guard. A missing prefix or wrong
    /// length is `key-corrupt` — dohc never regenerates a key over an existing
    /// file, so a malformed file fails closed rather than orphaning snapshots.
    fn parse_key_file(content: &str) -> Result<Self, CryptoError> {
        let trimmed = content.trim();
        let encoded = trimmed
            .strip_prefix(SECRET_KEY_FILE_PREFIX)
            .ok_or(CryptoError::KeyFileMalformed)?;
        // Raw key material must only ever live in a zeroizing buffer — the
        // decoded bytes are scrubbed on drop whether or not the length check
        // passes.
        let bytes = Zeroizing::new(base64::forgiving_decode(encoded));
        if bytes.len() != SECRET_KEY_BYTES {
            return Err(CryptoError::KeyFileMalformed);
        }
        Self::from_bytes(&bytes)
    }

    /// Serialize to the versioned key-file content (with trailing newline),
    /// byte-identical to what the TS store writes.
    #[must_use]
    fn to_key_file(&self) -> String {
        format!(
            "{SECRET_KEY_FILE_PREFIX}{}\n",
            base64::encode_standard(&self.0)
        )
    }
}

/// Redacted debug: never prints key bytes.
impl core::fmt::Debug for SecretDataKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("SecretDataKey(<redacted>)")
    }
}

/// Workspace-relative location of the key file.
pub const SECRET_KEY_FILE_RELATIVE: &str = ".dohc/engine/secret.key";

/// A key file is ~60 bytes; anything past this bound is not a key file and
/// must fail closed before buffering (a planted multi-GB `secret.key` must
/// not balloon memory just to fail the parse).
const MAX_KEY_FILE_BYTES: u64 = 4096;

/// Read up to the bound from an already-opened, already-validated descriptor.
fn read_bounded(file: &mut std::fs::File) -> std::io::Result<String> {
    use std::io::Read;
    let mut content = String::new();
    file.take(MAX_KEY_FILE_BYTES.saturating_add(1))
        .read_to_string(&mut content)?;
    if content.len() as u64 > MAX_KEY_FILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret key file exceeds the key-file bound",
        ));
    }
    Ok(content)
}

/// Read the key file without following a symlink at the leaf, bound to the
/// opened descriptor. Serves the publish read-backs; `load_key_file` opens
/// its own descriptor so the 0600 re-tighten can be descriptor-bound too.
fn read_key_file_no_follow(path: &std::path::Path) -> std::io::Result<String> {
    let mut file = open_no_follow(path)?;
    let metadata = file.metadata()?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret key file must be a regular file",
        ));
    }
    read_bounded(&mut file)
}

#[cfg(unix)]
fn open_no_follow(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    // O_NOFOLLOW: a symlink leaf is refused BY THE KERNEL at open time (no
    // check-then-open race). O_NONBLOCK: a FIFO swapped in cannot block the
    // open; the is_file check below then refuses it.
    match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => Ok(file),
        Err(err) if err.raw_os_error() == Some(libc::ELOOP) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret key file must not be a symlink",
        )),
        Err(err) => Err(err),
    }
}

#[cfg(windows)]
fn open_no_follow(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "secret key file must not be a reparse point",
        ));
    }
    Ok(file)
}

/// The key file's name in the folder that holds the workspace's store.
const SECRET_KEY_FILE_NAME: &str = "secret.key";

/// Load the workspace data key from `engine_dir`, the folder that holds the
/// workspace's store, by the path the store opened through. On a Mac that
/// path names the folder the engine checked, not whatever has its name now.
/// Returns `Ok(None)` when no key file exists.
/// A present-but-malformed/unreadable/symlinked file fails CLOSED. On a
/// successful read the file's permissions are re-tightened to 0600 (Unix; TS
/// parity — the TS store chmods existing key files after read, so a
/// restored or hand-copied key never stays world-readable).
pub fn load_key_file(engine_dir: &std::path::Path) -> Result<Option<SecretDataKey>, CryptoError> {
    let path = engine_dir.join(SECRET_KEY_FILE_NAME);
    let mut file = match open_no_follow(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(CryptoError::KeyFileMalformed),
    };
    // The file exists: its folder must not resolve anywhere else (a link at
    // `.dohc` or the folder would mean this key belongs to some other tree).
    // Same rule as the mint path.
    verify_key_dir(engine_dir)?;
    let read = (|| -> std::io::Result<String> {
        let metadata = file.metadata()?;
        if !metadata.file_type().is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "secret key file must be a regular file",
            ));
        }
        read_bounded(&mut file)
    })();
    let content = match read {
        Ok(content) => Zeroizing::new(content),
        Err(_) => return Err(CryptoError::KeyFileMalformed),
    };
    // Tighten permissions before parsing (a malformed-but-readable file must
    // not stay world-readable just because the parse fails closed), and
    // DESCRIPTOR-BOUND (fchmod-equivalent). If the mode cannot be verified
    // tight afterwards — a foreign-owned restored file — fail closed rather
    // than operate with a key other local users can read.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
        let mode = file
            .metadata()
            .map_err(|_| CryptoError::KeyFileMalformed)?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            return Err(CryptoError::KeyFileMalformed);
        }
    }
    let key = SecretDataKey::parse_key_file(&content)?;
    Ok(Some(key))
}

/// The key folder must not resolve anywhere else: neither it nor the folder
/// above it, `.dohc` in a workspace, may be reached through a link, as each
/// load and mint checked on main. A folder the engine reaches as the folder it
/// checked has no names to follow: by its ID on a Mac, and by the descriptor
/// it holds on Linux. Shared by load and mint.
fn verify_key_dir(engine_dir: &std::path::Path) -> Result<(), CryptoError> {
    #[cfg(target_vendor = "apple")]
    if dohc_macos_files::is_path_by_id(engine_dir) {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if dohc_linux_files::held::is_path_by_fd(engine_dir) {
        return Ok(());
    }
    let parent = engine_dir.parent();
    let (Some(dohc), Some(engine)) = (parent, engine_dir.file_name()) else {
        return Err(CryptoError::KeyFileMalformed);
    };
    let (Some(root), Some(dohc_name)) = (dohc.parent(), dohc.file_name()) else {
        return Err(CryptoError::KeyFileMalformed);
    };
    let real = engine_dir
        .canonicalize()
        .map_err(|_| CryptoError::KeyFileMalformed)?;
    let expected = root
        .canonicalize()
        .map_err(|_| CryptoError::KeyFileMalformed)?
        .join(dohc_name)
        .join(engine);
    if real == expected {
        Ok(())
    } else {
        Err(CryptoError::KeyFileMalformed)
    }
}

/// Mint and durably publish a fresh workspace data key in `engine_dir`, the
/// folder that holds the workspace's store, by the path the store opened
/// through. The engine made that folder private when it opened the store,
/// and on a Mac the path names the folder it checked. CALLER CONTRACT: only
/// invoke when the workspace has NO existing secret state — minting over
/// orphaned ciphertext would strand it silently; the capture layer checks the
/// encrypted store first and fails closed instead (TS parity:
/// `loadSecretDataKey` checks protected rows before its create branch).
/// A drive without hard links, such as exFAT or FAT32, gets the key created
/// at its name instead (`create_in_place`).
pub fn create_key_file(engine_dir: &std::path::Path) -> Result<SecretDataKey, CryptoError> {
    create_key_file_with(engine_dir, |temp, path| std::fs::hard_link(temp, path))
}

/// [`create_key_file`], publishing with `link`.
fn create_key_file_with(
    engine_dir: &std::path::Path,
    link: impl FnOnce(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<SecretDataKey, CryptoError> {
    let path = engine_dir.join(SECRET_KEY_FILE_NAME);
    let key = SecretDataKey::generate()?;
    // A link at `.dohc` or the folder would send key custody off the
    // workspace.
    verify_key_dir(engine_dir)?;
    // Durable publish: temp (0600) + fsync + hard-link. The key file must
    // be durably on disk before any ciphertext is committed under it —
    // a crash that lost a visible-but-unflushed key would strand every
    // sealed snapshot, and a later restart would silently re-mint. The
    // link-publish also means a partially written key can never be visible
    // at the final path, except on a drive without hard links.
    // Unique per attempt: pid + a process-wide counter, so two same-process
    // minters can never share (and cross-delete) one temp file.
    static MINT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = MINT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp-{}-{seq}", std::process::id()));
    // The serialized payload carries the key; it must zeroize on drop
    // like every other buffer holding key material.
    let payload = Zeroizing::new(key.to_key_file());
    let mut file = create_new_key_file(&temp).map_err(|err| key_create_error(&err))?;
    let written = write_and_flush(&mut file, &payload);
    drop(file);
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(CryptoError::KeyFileMalformed);
    }
    let publication = match link(&temp, &path) {
        Err(err) if hard_links_unsupported(&err) => {
            let _ = std::fs::remove_file(&temp);
            create_in_place(&path, &payload)
        }
        published => published,
    };
    finish_key_publication(&path, &temp, publication)
}

/// Create a key file that does not exist yet, readable only by its owner.
/// On macOS a 0600 mode does not limit an ACL entry the workspace folder
/// gives every new file, so the key takes none of them. A failed create
/// removes what it made, so nothing is left here for a path to clean up.
fn create_new_key_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    #[cfg(target_vendor = "apple")]
    {
        let invalid = || std::io::Error::from(std::io::ErrorKind::InvalidInput);
        let folder = std::fs::File::open(path.parent().ok_or_else(invalid)?)?;
        let name = path.file_name().ok_or_else(invalid)?;
        Ok(dohc_macos_files::create_uninherited(folder, name, 0o600)?.into())
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(path)
    }
}

fn write_and_flush(file: &mut std::fs::File, payload: &str) -> std::io::Result<()> {
    use std::io::Write;
    file.write_all(payload.as_bytes())?;
    file.sync_all()
}

/// Publish the key on a drive without hard links by creating it at its
/// name. The create still never replaces a key, and the key is flushed
/// before anything is sealed under it. A reader that comes between the
/// create and the write finds a key that fails closed for that try, as
/// every reader does after a crash in that moment.
fn create_in_place(path: &std::path::Path, payload: &str) -> std::io::Result<()> {
    let mut file = create_new_key_file(path)?;
    let written = write_and_flush(&mut file, payload);
    drop(file);
    // Nothing adopts a key it cannot parse, so only such a file can go.
    let complete = || {
        read_key_file_no_follow(path)
            .map(Zeroizing::new)
            .is_ok_and(|content| SecretDataKey::parse_key_file(&content).is_ok())
    };
    if written.is_err() && !complete() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Whether a hard link failed because the drive has none. The rule is
/// `materialize.rs::hard_links_unsupported`'s.
#[cfg(unix)]
fn hard_links_unsupported(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::Unsupported
        || err.raw_os_error().is_some_and(|code| {
            code == libc::EPERM || code == libc::ENOTSUP || code == libc::EOPNOTSUPP
        })
}

#[cfg(windows)]
fn hard_links_unsupported(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::Unsupported || matches!(err.raw_os_error(), Some(1 | 50))
}

/// The error for a key file that could not be created.
#[cfg(target_vendor = "apple")]
fn key_create_error(err: &std::io::Error) -> CryptoError {
    if dohc_macos_files::volume_shares_new_files(err) {
        CryptoError::VolumeSharesNewFiles
    } else {
        CryptoError::KeyFileMalformed
    }
}

#[cfg(not(target_vendor = "apple"))]
fn key_create_error(_: &std::io::Error) -> CryptoError {
    CryptoError::KeyFileMalformed
}

fn finish_key_publication(
    path: &std::path::Path,
    temp: &std::path::Path,
    publication: std::io::Result<()>,
) -> Result<SecretDataKey, CryptoError> {
    // Neither publication replaces a concurrent winner, which would orphan
    // data already encrypted with its key.
    let _ = std::fs::remove_file(temp);
    if publication.is_err_and(|err| err.kind() != std::io::ErrorKind::AlreadyExists) {
        return Err(CryptoError::KeyFileMalformed);
    }
    // Durability of the publish itself: fsync the parent directory where the
    // platform allows it (std cannot open directories on Windows; NTFS
    // metadata journaling is the best effort there). A failed directory sync
    // must fail the mint — returning a key whose publish may not survive a
    // crash would let ciphertext commit under a possibly-vanishing key.
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or(CryptoError::KeyFileMalformed)?;
        let dir = std::fs::File::open(parent).map_err(|_| CryptoError::KeyFileMalformed)?;
        dir.sync_all().map_err(|_| CryptoError::KeyFileMalformed)?;
    }
    // Return what is durably at the path — under any interleaving the
    // published file is the single source of truth.
    let content =
        Zeroizing::new(read_key_file_no_follow(path).map_err(|_| CryptoError::KeyFileMalformed)?);
    SecretDataKey::parse_key_file(&content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zeroize::Zeroize;

    /// A workspace folder whose ACL gives every new file read access for
    /// everyone must not pass that grant to the data key.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_folders_inherited_grant_never_reaches_the_key_file() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("key-acl").unwrap();
        let added = std::process::Command::new("/bin/chmod")
            .args([
                "+a",
                "group:everyone allow read,file_inherit,directory_inherit",
            ])
            .arg(scratch.path())
            .status()
            .unwrap();
        assert!(added.success());
        create_key_file(scratch.path()).unwrap();
        let listing = std::process::Command::new("/bin/ls")
            .arg("-led")
            .arg(scratch.path().join(SECRET_KEY_FILE_NAME))
            .output()
            .unwrap();
        let listing = String::from_utf8(listing.stdout).unwrap();
        assert_eq!(listing.lines().count(), 1, "{listing}");
    }

    /// The key's folder moves after the engine checks it, and another takes
    /// its name. The key still publishes and loads through the checked
    /// folder's path by ID, and the other folder gets nothing (#2375).
    #[cfg(target_vendor = "apple")]
    #[test]
    fn the_key_publishes_and_loads_in_the_folder_the_engine_checked() {
        let scratch = dohc_test_scratch::ScratchDir::new_named("key-swap").unwrap();
        let engine = scratch.path().join("engine");
        std::fs::create_dir(&engine).unwrap();
        let folder = std::fs::File::open(&engine).unwrap();
        let shown = std::path::Path::new("engine");
        let by_id = dohc_macos_files::path_by_id(&folder, shown)
            .unwrap()
            .unwrap();
        let moved = scratch.path().join("moved");
        std::fs::rename(&engine, &moved).unwrap();
        std::fs::create_dir(&engine).unwrap();
        let key = create_key_file(&by_id).unwrap();
        assert_eq!(std::fs::read_dir(&engine).unwrap().count(), 0);
        assert!(moved.join(SECRET_KEY_FILE_NAME).is_file());
        std::fs::write(engine.join(SECRET_KEY_FILE_NAME), "not the key").unwrap();
        assert_eq!(load_key_file(&by_id).unwrap(), Some(key));
    }

    /// On Linux the key goes through the descriptor held for the folder the
    /// engine checked. After that folder moves and another takes its name,
    /// the key still publishes and loads in the checked folder, and the
    /// other folder gets nothing.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_key_publishes_and_loads_through_the_held_folder() {
        use std::os::fd::AsFd;
        let scratch = dohc_test_scratch::ScratchDir::new_named("key-held").unwrap();
        let engine = scratch.path().join("engine");
        std::fs::create_dir(&engine).unwrap();
        let folder = std::fs::File::open(&engine).unwrap();
        let held =
            dohc_linux_files::held::held_path(folder.as_fd(), std::path::Path::new(".dohc/engine"))
                .unwrap();
        let moved = scratch.path().join("moved");
        std::fs::rename(&engine, &moved).unwrap();
        std::fs::create_dir(&engine).unwrap();
        let key = create_key_file(&held).unwrap();
        assert_eq!(std::fs::read_dir(&engine).unwrap().count(), 0);
        assert!(moved.join(SECRET_KEY_FILE_NAME).is_file());
        std::fs::write(engine.join(SECRET_KEY_FILE_NAME), "not the key").unwrap();
        assert_eq!(load_key_file(&held).unwrap(), Some(key));
    }

    #[cfg(target_vendor = "apple")]
    #[test]
    fn a_volume_that_shares_new_files_reaches_the_caller_by_its_code() {
        let refused = std::io::Error::other(dohc_macos_files::VolumeSharesNewFiles);
        let err = key_create_error(&refused);
        assert_eq!(err, CryptoError::VolumeSharesNewFiles);
        assert_eq!(err.code(), "volume-shares-new-files");
        let other = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert_eq!(key_create_error(&other), CryptoError::KeyFileMalformed);
    }

    #[test]
    fn key_file_round_trips_byte_exact() {
        let key = SecretDataKey::from_bytes(&[0xABu8; SECRET_KEY_BYTES]).unwrap();
        let file = key.to_key_file();
        assert!(file.starts_with(SECRET_KEY_FILE_PREFIX));
        assert!(file.ends_with('\n'));
        let parsed = SecretDataKey::parse_key_file(&file).unwrap();
        assert_eq!(parsed, key);
    }

    #[test]
    fn parse_tolerates_surrounding_whitespace() {
        let key = SecretDataKey::from_bytes(&[3u8; SECRET_KEY_BYTES]).unwrap();
        let file = key.to_key_file();
        let padded = format!("  \n{}\n\t ", file.trim_end());
        assert_eq!(SecretDataKey::parse_key_file(&padded).unwrap(), key);
    }

    #[test]
    fn malformed_prefix_or_length_fails_closed() {
        assert_eq!(
            SecretDataKey::parse_key_file("nope:AAAA").unwrap_err(),
            CryptoError::KeyFileMalformed
        );
        // Right prefix, wrong length.
        let short = format!(
            "{SECRET_KEY_FILE_PREFIX}{}",
            base64::encode_standard(&[1u8; 16])
        );
        assert_eq!(
            SecretDataKey::parse_key_file(&short).unwrap_err(),
            CryptoError::KeyFileMalformed
        );
    }

    #[test]
    fn wrong_length_bytes_rejected() {
        assert_eq!(
            SecretDataKey::from_bytes(&[0u8; 31]).unwrap_err(),
            CryptoError::InvalidKeyLength
        );
    }

    #[test]
    fn generate_produces_distinct_keys() {
        let a = SecretDataKey::generate().unwrap();
        let b = SecretDataKey::generate().unwrap();
        assert_ne!(a, b, "two fresh keys must differ (CSPRNG)");
    }

    #[test]
    fn explicit_zeroize_scrubs_key_bytes() {
        // Best-effort zeroization proof without unsafe: the same `Zeroize` impl
        // that runs on drop (via `ZeroizeOnDrop`) zeros the buffer here.
        let mut key = SecretDataKey::from_bytes(&[0xFFu8; SECRET_KEY_BYTES]).unwrap();
        key.zeroize();
        assert_eq!(key.as_bytes(), &[0u8; SECRET_KEY_BYTES]);
    }

    #[test]
    fn created_key_loads_unchanged_and_corruption_fails_closed() {
        let dir = dohc_test_scratch::ScratchDir::new_named("keyfile-test").unwrap();

        assert_eq!(load_key_file(&dir).expect("missing key"), None);
        let first = create_key_file(&dir).expect("mint");
        let file = dir.join(SECRET_KEY_FILE_NAME);
        let content = std::fs::read_to_string(&file).expect("key file written");
        assert!(content.starts_with(SECRET_KEY_FILE_PREFIX));

        let second = load_key_file(&dir).expect("load").expect("existing key");
        assert_eq!(first, second, "an existing key is loaded, never re-minted");

        // A malformed existing file fails closed — regenerating over it would
        // silently orphan every sealed snapshot.
        std::fs::write(&file, "garbage").unwrap();
        assert!(load_key_file(&dir).is_err());
        // "Fails closed" also means it LEAVES THE FILE ALONE. An error return that
        // truncated, deleted, or re-minted over the file would read as fail-closed
        // to the caller while destroying the only copy of the key — the operator's
        // one chance to restore the real one.
        //
        assert_eq!(
            std::fs::read_to_string(&file).expect("the malformed key file still exists"),
            "garbage",
            "a failed load must not rewrite or delete the key file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn freshly_minted_key_file_is_0600() {
        // `load_retightens_lax_permissions_to_0600` chmods the file to 0644 itself
        // before loading, so it can only prove the re-tighten on load — deleting
        // the create-time mode leaves it green. This asserts the mode the mint
        // chose, with no `set_permissions` step in between.
        //
        use std::os::unix::fs::PermissionsExt;
        let dir = dohc_test_scratch::ScratchDir::new_named("keymint-mode-test").unwrap();
        let _key = create_key_file(&dir).expect("mint");
        let path = dir.join(SECRET_KEY_FILE_NAME);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "a freshly minted key file must not be readable by other local users"
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_retightens_lax_permissions_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dohc_test_scratch::ScratchDir::new_named("keyperm-test").unwrap();
        let key = create_key_file(&dir).expect("mint");
        let path = dir.join(SECRET_KEY_FILE_NAME);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        let loaded = load_key_file(&dir).expect("load").expect("present");
        assert_eq!(loaded, key);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a restored/hand-copied key is re-tightened");
    }

    #[test]
    fn failed_atomic_publication_never_installs_or_replaces_a_key() {
        for kind in [
            std::io::ErrorKind::Unsupported,
            std::io::ErrorKind::PermissionDenied,
        ] {
            for has_winner in [false, true] {
                let dir = dohc_test_scratch::ScratchDir::new_named("key-publish-failure").unwrap();
                let path = dir.join("key");
                let temp = dir.join("pending-key");
                let candidate = SecretDataKey::from_bytes(&[1; SECRET_KEY_BYTES]).unwrap();
                let winner = SecretDataKey::from_bytes(&[2; SECRET_KEY_BYTES]).unwrap();
                std::fs::write(&temp, candidate.to_key_file()).unwrap();
                if has_winner {
                    std::fs::write(&path, winner.to_key_file()).unwrap();
                }

                let result = finish_key_publication(&path, &temp, Err(std::io::Error::from(kind)));

                assert_eq!(result.unwrap_err(), CryptoError::KeyFileMalformed);
                assert!(
                    !temp.exists(),
                    "failed attempt must release its temporary file"
                );
                if has_winner {
                    assert_eq!(
                        std::fs::read_to_string(&path).unwrap(),
                        winner.to_key_file()
                    );
                } else {
                    assert!(
                        !path.exists(),
                        "failed atomic publication must not install a key"
                    );
                }
            }
        }
    }

    /// A link put at `.dohc`, or at the engine's folder, after the workspace
    /// opened sends the key folder's path into another tree. A later load
    /// and a mint through that path both refuse, and the other tree gets no
    /// key.
    #[cfg(any(unix, windows))]
    fn a_link_after_the_open_refuses_the_key(link: impl Fn(&std::path::Path, &std::path::Path)) {
        for (n, linked) in [".dohc", ".dohc/engine"].into_iter().enumerate() {
            let name = format!("key-link-{n}");
            let scratch = dohc_test_scratch::ScratchDir::new_named(&name).unwrap();
            let root = scratch.path();
            let engine = root.join(".dohc").join("engine");
            std::fs::create_dir_all(&engine).unwrap();
            create_key_file(&engine).unwrap();
            let elsewhere = root.join("elsewhere");
            let other = elsewhere.join("engine");
            std::fs::create_dir_all(&other).unwrap();
            let key = SECRET_KEY_FILE_NAME;
            std::fs::copy(engine.join(key), other.join(key)).unwrap();
            std::fs::rename(root.join(".dohc"), root.join("moved")).unwrap();
            if linked == ".dohc" {
                link(&elsewhere, &root.join(".dohc"));
            } else {
                std::fs::create_dir(root.join(".dohc")).unwrap();
                link(&other, &engine);
            }
            let loaded = load_key_file(&engine);
            assert!(
                matches!(loaded, Err(CryptoError::KeyFileMalformed)),
                "{linked}"
            );
            std::fs::remove_file(other.join(key)).unwrap();
            let minted = create_key_file(&engine);
            assert!(
                matches!(minted, Err(CryptoError::KeyFileMalformed)),
                "{linked}"
            );
            assert_eq!(std::fs::read_dir(&other).unwrap().count(), 0, "{linked}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_after_the_open_refuses_the_key() {
        a_link_after_the_open_refuses_the_key(|target, link| {
            std::os::unix::fs::symlink(target, link).unwrap();
        });
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_after_the_open_refuses_the_key() {
        a_link_after_the_open_refuses_the_key(|target, link| {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(made.status.success(), "{made:?}");
        });
    }

    #[test]
    fn concurrent_minters_all_adopt_the_published_key() {
        let dir = dohc_test_scratch::ScratchDir::new_named("key-publish-race").unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let keys = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    let start = std::sync::Arc::clone(&start);
                    let root = &dir;
                    scope.spawn(move || {
                        start.wait();
                        create_key_file(root).expect("mint or adopt the winner")
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        let published = load_key_file(&dir).unwrap().expect("published key");
        for key in keys {
            assert_eq!(key, published);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// A hard link on exFAT or FAT32.
    fn no_hard_links(_: &std::path::Path, _: &std::path::Path) -> std::io::Result<()> {
        Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
    }

    #[test]
    fn a_drive_without_hard_links_creates_the_key_at_its_name() {
        let dir = dohc_test_scratch::ScratchDir::new_named("key-no-links").unwrap();
        let key = create_key_file_with(&dir, no_hard_links).unwrap();
        assert_eq!(load_key_file(&dir).unwrap(), Some(key));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join(SECRET_KEY_FILE_NAME);
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn a_drive_without_hard_links_keeps_the_published_key() {
        let dir = dohc_test_scratch::ScratchDir::new_named("key-no-links-winner").unwrap();
        let winner = create_key_file(&dir).unwrap();
        assert_eq!(create_key_file_with(&dir, no_hard_links).unwrap(), winner);
        assert_eq!(load_key_file(&dir).unwrap(), Some(winner));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    /// A minter there can fail a try while another writes the key, but no
    /// two minters ever return different keys.
    #[test]
    fn concurrent_minters_without_hard_links_return_only_the_published_key() {
        let dir = dohc_test_scratch::ScratchDir::new_named("key-no-links-race").unwrap();
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let keys = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..8)
                .map(|_| {
                    let start = std::sync::Arc::clone(&start);
                    let root = &dir;
                    scope.spawn(move || {
                        start.wait();
                        create_key_file_with(root, no_hard_links)
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Vec<_>>()
        });
        let published = load_key_file(&dir).unwrap().expect("published key");
        assert!(keys.iter().any(Result::is_ok));
        for key in keys.into_iter().flatten() {
            assert_eq!(key, published);
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn only_a_drive_without_hard_links_publishes_in_place() {
        for code in [libc::EPERM, libc::ENOTSUP, libc::EOPNOTSUPP] {
            assert!(hard_links_unsupported(&std::io::Error::from_raw_os_error(
                code
            )));
        }
        for code in [
            libc::EACCES,
            libc::EEXIST,
            libc::EXDEV,
            libc::EIO,
            libc::ENOSPC,
        ] {
            assert!(!hard_links_unsupported(&std::io::Error::from_raw_os_error(
                code
            )));
        }
    }
}
