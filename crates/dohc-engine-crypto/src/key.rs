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

/// Load the workspace data key, returning `Ok(None)` when no key file exists.
/// A present-but-malformed/unreadable/symlinked file fails CLOSED. On a
/// successful read the file's permissions are re-tightened to 0600 (Unix; TS
/// parity — the TS store chmods existing key files after read, so a
/// restored or hand-copied key never stays world-readable).
pub fn load_key_file(root: &std::path::Path) -> Result<Option<SecretDataKey>, CryptoError> {
    let path = root.join(SECRET_KEY_FILE_RELATIVE);
    let mut file = match open_no_follow(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(CryptoError::KeyFileMalformed),
    };
    // The file exists: its directory must be the workspace's real
    // `.dohc/engine` (a symlinked ancestor would mean this key belongs to
    // some other tree). Same strict-equality rule as the mint path.
    verify_key_dir(root)?;
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

/// The key directory must canonicalize to the workspace's real lexical
/// `.dohc/engine` — never an aliased tree. Shared by load and mint.
fn verify_key_dir(root: &std::path::Path) -> Result<(), CryptoError> {
    let parent = root
        .join(SECRET_KEY_FILE_RELATIVE)
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or(CryptoError::KeyFileMalformed)?;
    let real_parent = parent
        .canonicalize()
        .map_err(|_| CryptoError::KeyFileMalformed)?;
    let mut expected = root
        .canonicalize()
        .map_err(|_| CryptoError::KeyFileMalformed)?;
    for segment in std::path::Path::new(SECRET_KEY_FILE_RELATIVE)
        .parent()
        .into_iter()
        .flat_map(|p| p.components())
    {
        expected.push(segment);
    }
    if real_parent == expected {
        Ok(())
    } else {
        Err(CryptoError::KeyFileMalformed)
    }
}

/// Mint and durably publish a fresh workspace data key. CALLER CONTRACT: only
/// invoke when the workspace has NO existing secret state — minting over
/// orphaned ciphertext would strand it silently; the capture layer checks the
/// encrypted store first and fails closed instead (TS parity:
/// `loadSecretDataKey` checks protected rows before its create branch).
/// Creation requires hard-link support; unsupported filesystems refuse creation.
pub fn create_key_file(root: &std::path::Path) -> Result<SecretDataKey, CryptoError> {
    let path = root.join(SECRET_KEY_FILE_RELATIVE);
    let key = SecretDataKey::generate()?;
    if let Some(parent) = path.parent() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        // The key's directory must not advertise its existence to
        // other local users (the file itself is 0600 below).
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(parent)
            .map_err(|_| CryptoError::KeyFileMalformed)?;
    }
    // The key directory must be the workspace's real `.dohc/engine` — an
    // aliased `.dohc` would redirect key custody off-workspace. (An ancestor
    // swapped between this check and the writes below is the same documented
    // residual as the capture sink's: fully closing it needs openat/dirfd
    // APIs deliberately out of scope pre-cutover.)
    verify_key_dir(root)?;
    // Durable publish: temp (0600) + fsync + hard-link. The key file must
    // be durably on disk before any ciphertext is committed under it —
    // a crash that lost a visible-but-unflushed key would strand every
    // sealed snapshot, and a later restart would silently re-mint. The
    // link-publish also means a partially written key can never be visible
    // at the final path.
    // Unique per attempt: pid + a process-wide counter, so two same-process
    // minters can never share (and cross-delete) one temp file.
    static MINT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = MINT_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = path.with_extension(format!("tmp-{}-{seq}", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        use std::io::Write;
        // The serialized payload carries the key; it must zeroize on drop
        // like every other buffer holding key material.
        let payload = Zeroizing::new(key.to_key_file());
        file.write_all(payload.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(CryptoError::KeyFileMalformed);
    }
    let publication = std::fs::hard_link(&temp, &path);
    finish_key_publication(&path, &temp, publication)
}

fn finish_key_publication(
    path: &std::path::Path,
    temp: &std::path::Path,
    publication: std::io::Result<()>,
) -> Result<SecretDataKey, CryptoError> {
    // Hard links publish atomically without replacing a concurrent winner.
    // Replacing the winner would orphan data already encrypted with its key.
    // Refuse filesystems that cannot provide that guarantee.
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
        let file = dir.join(SECRET_KEY_FILE_RELATIVE);
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
        let path = dir.join(SECRET_KEY_FILE_RELATIVE);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "a freshly minted key file must not be readable by other local users"
        );
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(
            dir_mode, 0o700,
            "the key directory must not advertise the key to other local users"
        );
    }

    #[cfg(unix)]
    #[test]
    fn load_retightens_lax_permissions_to_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = dohc_test_scratch::ScratchDir::new_named("keyperm-test").unwrap();
        let key = create_key_file(&dir).expect("mint");
        let path = dir.join(SECRET_KEY_FILE_RELATIVE);
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
        let directory = dir
            .join(SECRET_KEY_FILE_RELATIVE)
            .parent()
            .unwrap()
            .to_path_buf();
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    }
}
