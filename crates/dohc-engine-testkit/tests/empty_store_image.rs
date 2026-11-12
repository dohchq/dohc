use std::fs;
use std::path::PathBuf;
use std::process::Command;

use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_testkit::{
    EMPTY_STORE_IMAGE_ENV, ScratchDir, engine_db_path, open_empty_store, write_empty_store_image,
};

#[test]
#[ignore = "runner invokes this once before the test processes start"]
fn prepare_empty_store_image() {
    let path = PathBuf::from(std::env::var_os(EMPTY_STORE_IMAGE_ENV).expect("schema image output"));
    write_empty_store_image(&path);
}

#[test]
fn separate_processes_copy_one_closed_image_and_reopen_their_own_writes() {
    let scratch = ScratchDir::new().unwrap();
    let image = scratch.join("empty.db");
    write_empty_store_image(&image);
    let original = fs::read(&image).unwrap();
    let mut identities = Vec::new();
    for name in ["first", "second"] {
        let path = engine_db_path(&scratch.join(name)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "copy_image_in_child"])
            .env(EMPTY_STORE_IMAGE_ENV, &image)
            .env("DOHC_TEST_IMAGE_CHILD_DATABASE", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        let reopened = EngineStore::open(&path, 456).unwrap();
        identities.push(reopened.engine_uuid().unwrap());
        let contents: String = reopened
            .read_with(|connection| {
                connection.query_row("SELECT text FROM blobs", [], |row| row.get(0))
            })
            .unwrap();
        assert_eq!(contents, name);
        assert_eq!(reopened.database_path(), path.as_path());
    }
    assert_ne!(identities[0], identities[1]);
    assert_eq!(fs::read(&image).unwrap(), original);
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!scratch.join(format!("empty.db{suffix}")).exists());
    }
}

#[test]
#[ignore = "subprocess probe for the shared image contract"]
fn copy_image_in_child() {
    let path = PathBuf::from(
        std::env::var_os("DOHC_TEST_IMAGE_CHILD_DATABASE").expect("child fixture database"),
    );
    let mut store = open_empty_store(&path, 123);
    assert!(!store.was_freshly_created());
    assert_eq!(store.table_row_count("blobs").unwrap(), 0);
    assert_eq!(store.table_row_count("shadow_clone").unwrap(), 0);
    store
        .read_with(|connection| -> rusqlite::Result<()> {
            let journal: String =
                connection.pragma_query_value(None, "journal_mode", |r| r.get(0))?;
            let synchronous: i64 =
                connection.pragma_query_value(None, "synchronous", |r| r.get(0))?;
            let foreign_keys: bool =
                connection.pragma_query_value(None, "foreign_keys", |r| r.get(0))?;
            let created: i64 =
                connection.query_row("SELECT created_at_ms FROM engine_ownership", [], |r| {
                    r.get(0)
                })?;
            assert_eq!(journal, "wal");
            assert_eq!(synchronous, 1);
            assert!(foreign_keys);
            assert_eq!(created, 123);
            Ok(())
        })
        .unwrap();
    let name = path
        .ancestors()
        .nth(3)
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    store
        .write_with(&NoFaults, |transaction| -> Result<(), StorageError> {
            transaction
                .execute(
                    "INSERT INTO blobs(sha256,byte_length,text) VALUES ('fixture',?1,?2)",
                    rusqlite::params![name.len() as i64, name],
                )
                .unwrap();
            Ok(())
        })
        .unwrap();

    // The environment cannot turn a production open into fixture setup.
    let fresh_path = path.with_file_name("fresh.db");
    let mut fresh = EngineStore::open(&fresh_path, 123).unwrap();
    assert!(fresh.was_freshly_created());
    assert!(fresh.bind_root_token("child-root", &NoFaults).unwrap());
    drop(fresh);
    let mut reopened = EngineStore::open(&fresh_path, 456).unwrap();
    assert!(reopened.bind_root_token("child-root", &NoFaults).unwrap());
    assert!(!reopened.bind_root_token("other-root", &NoFaults).unwrap());
}
