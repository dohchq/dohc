//! Fuzz coverage for corrupted database bytes at the open/migration boundary.
//!
//! Plain proptest keeps this target native-Windows compatible. The default is
//! 256 cases per property and can be scaled with `PROPTEST_CASES`.

use dohc_engine_storage::{
    CorruptionKind, ENGINE_SCHEMA_VERSION, EngineStore, SQLITE_DATABASE_HEADER_BYTES, classify,
};
use dohc_engine_testkit::ScratchDir;
use proptest::prelude::*;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug)]
enum ValidDbMutation {
    HeaderFlip { offset: usize, mask: u8 },
    Truncate { length: usize },
    OversizeHeader { offset: usize, bytes: Vec<u8> },
}

fn valid_db_mutation() -> impl Strategy<Value = ValidDbMutation> {
    prop_oneof![
        (0usize..16, 1u8..=u8::MAX)
            .prop_map(|(offset, mask)| ValidDbMutation::HeaderFlip { offset, mask }),
        (1usize..100).prop_map(|length| ValidDbMutation::Truncate { length }),
        (0usize..16, prop::collection::vec(any::<u8>(), 1..1024),)
            .prop_map(|(offset, bytes)| ValidDbMutation::OversizeHeader { offset, bytes }),
    ]
}

/// The canonical valid `engine.db` image, built once per test process. What
/// varies across cases is the mutation, not the base bytes, and creating a real
/// store (migration ledger + WAL fsyncs) cost ~87ms — two orders of magnitude
/// more than the case itself, which is what made a large `PROPTEST_CASES`
/// corpus impractical.
fn valid_db_image() -> &'static [u8] {
    static IMAGE: OnceLock<Vec<u8>> = OnceLock::new();
    IMAGE.get_or_init(|| {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        let store = EngineStore::open(&path, 1_000).expect("create valid engine db");
        drop(store);
        remove_sidecars(&path);
        std::fs::read(&path).expect("read valid engine db")
    })
}

/// A scratch workspace holding a byte-identical copy of the canonical image.
fn fresh_db() -> (ScratchDir, PathBuf, Vec<u8>) {
    let bytes = valid_db_image().to_vec();
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    std::fs::write(&path, &bytes).expect("seed valid engine db");
    (scratch, path, bytes)
}

fn remove_sidecars(path: &Path) {
    let parent = path.parent().expect("engine db parent");
    let _ = std::fs::remove_file(parent.join("engine.db-wal"));
    let _ = std::fs::remove_file(parent.join("engine.db-shm"));
}

fn assert_rejected_as_corruption(path: &Path) {
    match EngineStore::open(path, 2_000) {
        Ok(_) => panic!("corrupted database must not open or migrate"),
        Err(error) => assert_eq!(
            classify(&error),
            CorruptionKind::Corruption,
            "unexpected open error: {}",
            error.code()
        ),
    }
}

proptest! {
    // `ProptestConfig::default()` is 256 cases and honors the standard
    // `PROPTEST_CASES` env var; `with_cases(256)` pinned it and silently
    // ignored the env var, so evidence runs asking for a large corpus got 256.
    #![proptest_config(ProptestConfig::default())]

    /// Non-empty arbitrary bytes are refused with the typed corruption
    /// classification and the rejected evidence remains byte-for-byte intact.
    #[test]
    fn arbitrary_file_bytes_fail_closed(bytes in prop::collection::vec(any::<u8>(), 1..4096)) {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        std::fs::write(&path, &bytes).expect("write fuzz database");

        assert_rejected_as_corruption(&path);
        let after = std::fs::read(&path).expect("read rejected database");
        prop_assert_eq!(after, bytes, "open must preserve rejected evidence");
    }

    /// Critical-header flips, short truncations, and oversized insertions into
    /// a valid SQLite header are typed corruption, never an implicit rebuild.
    #[test]
    fn corrupted_valid_database_never_opens_or_migrates(mutation in valid_db_mutation()) {
        let (_scratch, path, mut bytes) = fresh_db();
        match mutation {
            ValidDbMutation::HeaderFlip { offset, mask } => bytes[offset] ^= mask,
            ValidDbMutation::Truncate { length } => bytes.truncate(length),
            ValidDbMutation::OversizeHeader { offset, bytes: extra } => {
                bytes.splice(offset..offset, extra);
            }
        }
        std::fs::write(&path, &bytes).expect("write corrupted engine db");

        assert_rejected_as_corruption(&path);
        let after = std::fs::read(&path).expect("read rejected engine db");
        prop_assert_eq!(after, bytes, "open must not repair corrupted evidence");
    }

    /// A valid SQLite engine database carrying a foreign or unsupported
    /// fingerprint is fenced before migration and remains byte-for-byte unchanged.
    #[test]
    fn foreign_or_unsupported_fingerprint_is_refused_before_migration(fingerprint in any::<i32>()) {
        prop_assume!(i64::from(fingerprint) != ENGINE_SCHEMA_VERSION);
        let (_scratch, path, mut bytes) = fresh_db();
        bytes[60..64].copy_from_slice(&fingerprint.to_be_bytes());
        std::fs::write(&path, &bytes).expect("write foreign fingerprint");

        match EngineStore::open(&path, 2_000) {
            Ok(_) => prop_assert!(false, "foreign fingerprint must not open or migrate"),
            Err(error) => {
                if fingerprint == 0 {
                    prop_assert_eq!(error.code(), "foreign-database");
                    prop_assert_eq!(classify(&error), CorruptionKind::Corruption);
                } else {
                    prop_assert_eq!(error.code(), "unsupported-fingerprint");
                    prop_assert_eq!(classify(&error), CorruptionKind::UnsupportedFingerprint);
                }
            }
        }
        let after = std::fs::read(&path).expect("read fenced database");
        prop_assert_eq!(after, bytes, "fingerprint fence must preserve evidence");
    }
}

#[test]
fn seed_valid_database_opens() {
    let (_scratch, path, _bytes) = fresh_db();
    assert!(EngineStore::open(&path, 2_000).is_ok());
}

#[test]
fn seed_all_zeros_classifies_as_corruption() {
    let scratch = ScratchDir::new().expect("scratch");
    let path = scratch.engine_db_path().expect("db path");
    std::fs::write(&path, [0u8; 512]).expect("write zeros");
    assert_rejected_as_corruption(&path);
}

/// The exact input that escaped the fence on macOS: a valid engine.db
/// truncated to one byte. SQLite's unix VFS reports a file size of exactly 1 as
/// 0 (`unixFileSize`, ticket #3260 — the OS-X msdos `findInodeInfo`
/// workaround), so the open ritual saw a brand-new empty database and
/// initialized the whole v2 schema over the damaged store. The win32 VFS makes
/// no such adjustment, which is why the same case always passed on Windows.
#[test]
fn seed_single_byte_database_is_refused() {
    let (_scratch, path, mut bytes) = fresh_db();
    bytes.truncate(1);
    std::fs::write(&path, &bytes).expect("write single-byte engine db");
    assert_rejected_as_corruption(&path);
    let after = std::fs::read(&path).expect("read rejected engine db");
    assert_eq!(
        after, bytes,
        "open must not initialize over a 1-byte engine.db"
    );
}

/// The whole escaping class, derived structurally rather than as magic
/// lengths: no non-empty file shorter than the SQLite database header can be a
/// database, so every truncation below it is typed corruption on every
/// platform and leaves the evidence byte-for-byte intact.
#[test]
fn seed_sub_header_truncations_are_refused() {
    let (_scratch, path, bytes) = fresh_db();
    let header_bytes = usize::try_from(SQLITE_DATABASE_HEADER_BYTES).expect("header size fits");
    for length in 1..header_bytes {
        let mut truncated = bytes.clone();
        truncated.truncate(length);
        remove_sidecars(&path);
        std::fs::write(&path, &truncated).expect("write truncated engine db");
        assert_rejected_as_corruption(&path);
        let after = std::fs::read(&path).expect("read rejected engine db");
        assert_eq!(
            after, truncated,
            "open must not repair a {length}-byte engine.db"
        );
    }
}
