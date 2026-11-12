//! Closed schema images for ordinary fixtures. Production opens remain unchanged.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use dohc_engine_storage::EngineStore;
use rusqlite::{Connection, OpenFlags, params};

use crate::scratch::{ScratchDir, engine_db_path};

/// The runner creates this image once with the same build, before starting tests.
/// It owns the absolute path and removes the image after all test processes exit.
pub const EMPTY_STORE_IMAGE_ENV: &str = "DOHC_TEST_EMPTY_STORE_IMAGE";

/// Open an empty fixture at a new path, optionally copying the runner's image.
///
/// Each copy has its own writable file, engine UUID, and creation timestamp.
/// A copied store is an existing, unbound store. Tests of fresh creation, root
/// binding, migrations, or the open itself must use `EngineStore::open` directly.
/// Without the image variable, this runs the ordinary fresh-create path.
#[track_caller]
pub fn open_empty_store(path: &Path, now_ms: i64) -> EngineStore {
    let image = std::env::var_os(EMPTY_STORE_IMAGE_ENV);
    open_empty_store_from(path, now_ms, image.as_deref().map(Path::new))
}

/// Create a closed, empty current-schema image at a new absolute path.
///
/// The generator always exercises production fresh creation. Never reuse this
/// artifact across builds: the runner must generate it before each test run.
pub fn write_empty_store_image(path: &Path) {
    assert!(path.is_absolute(), "schema image path must be absolute");
    assert_no_sidecars(path);
    let scratch = ScratchDir::new().expect("schema image scratch");
    let database = engine_db_path(&scratch).expect("schema image database path");
    let store = EngineStore::open(&database, 0).expect("create schema image");
    assert!(store.was_freshly_created());
    drop(store);
    assert_no_sidecars(&database);
    write_new(
        path,
        &fs::read(&database).expect("read closed schema image"),
    );
}

fn open_empty_store_from(path: &Path, now_ms: i64, image: Option<&Path>) -> EngineStore {
    assert!(
        !path.try_exists().expect("stat fixture"),
        "fixture must be new"
    );
    assert_no_sidecars(path);
    if let Some(image) = image {
        assert!(image.is_absolute(), "schema image path must be absolute");
        assert_no_sidecars(image);
        write_new(path, &fs::read(image).expect("read run schema image"));

        // Set fixture metadata before the real open, so its commit counters and
        // connection hooks start at zero. Never open the shared image itself.
        let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            .expect("open schema copy");
        let transaction = connection
            .transaction()
            .expect("fixture metadata transaction");
        let bindings: i64 = transaction
            .query_row("SELECT COUNT(*) FROM shadow_clone", [], |row| row.get(0))
            .expect("fixture root bindings");
        assert_eq!(bindings, 0, "schema image must not bind a workspace root");
        assert_eq!(
            transaction
                .execute(
                    "UPDATE engine_ownership SET engine_uuid=lower(hex(randomblob(16))), \
                     created_at_ms=?1 WHERE rowid_guard=1",
                    [now_ms],
                )
                .expect("fixture identity"),
            1,
        );
        transaction
            .execute(
                "UPDATE engine_migrations SET started_at=?1, completed_at=?1 \
                 WHERE completed_at IS NOT NULL",
                params![now_ms],
            )
            .expect("fixture migration timestamps");
        transaction.commit().expect("commit fixture metadata");
        connection.close().expect("close schema copy");
    }
    EngineStore::open(path, now_ms).expect("open empty fixture")
}

fn write_new(path: &Path, bytes: &[u8]) {
    // create_new refuses aliases to an existing database; writing bytes gives
    // the copy writable permissions even when the runner's image is read-only.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .expect("create fixture database")
        .write_all(bytes)
        .expect("write fixture database");
}

fn assert_no_sidecars(path: &Path) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        assert!(
            !Path::new(&sidecar).try_exists().expect("stat sidecar"),
            "schema fixture must be closed: {}",
            Path::new(&sidecar).display(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_storage::NoFaults;

    #[test]
    fn absent_image_keeps_fresh_creation_and_root_binding() {
        let scratch = ScratchDir::new().unwrap();
        let path = engine_db_path(&scratch).unwrap();
        let mut store = open_empty_store_from(&path, 123, None);
        assert!(store.was_freshly_created());
        assert!(store.bind_root_token("root-a", &NoFaults).unwrap());
        let identity = store.engine_uuid().unwrap();
        drop(store);

        let mut reopened = EngineStore::open(&path, 456).unwrap();
        assert!(!reopened.was_freshly_created());
        assert_eq!(reopened.engine_uuid().unwrap(), identity);
        assert!(reopened.bind_root_token("root-a", &NoFaults).unwrap());
        assert!(!reopened.bind_root_token("root-b", &NoFaults).unwrap());
    }

    #[test]
    fn image_copy_matches_fresh_schema_and_initial_rows() {
        let scratch = ScratchDir::new().unwrap();
        let image = scratch.join("empty.db");
        write_empty_store_image(&image);
        let mut copied = open_empty_store_from(&scratch.join("copy.db"), 123, Some(&image));
        let fresh = open_empty_store_from(&scratch.join("fresh.db"), 123, None);
        assert!(!copied.was_freshly_created());
        assert!(!copied.bind_root_token("unrelated-root", &NoFaults).unwrap());
        assert_ne!(copied.engine_uuid().unwrap(), fresh.engine_uuid().unwrap());
        assert_eq!(schema_and_rows(&copied), schema_and_rows(&fresh));
    }

    #[test]
    fn copies_refuse_existing_destinations_and_images_with_sidecars() {
        let scratch = ScratchDir::new().unwrap();
        let image = scratch.join("empty.db");
        write_empty_store_image(&image);
        let existing = scratch.join("existing.db");
        fs::write(&existing, b"keep this database").unwrap();
        assert!(
            std::panic::catch_unwind(|| {
                open_empty_store_from(&existing, 123, Some(&image));
            })
            .is_err()
        );
        assert_eq!(fs::read(&existing).unwrap(), b"keep this database");

        for suffix in ["-wal", "-shm", "-journal"] {
            let sidecar = scratch.join(format!("empty.db{suffix}"));
            fs::write(&sidecar, b"live sidecar").unwrap();
            let destination = scratch.join("unused.db");
            assert!(
                std::panic::catch_unwind(|| {
                    open_empty_store_from(&destination, 123, Some(&image));
                })
                .is_err()
            );
            assert!(!destination.exists());
            fs::remove_file(sidecar).unwrap();
        }
    }

    fn schema_and_rows(store: &EngineStore) -> Vec<Vec<rusqlite::types::Value>> {
        store.read_with(|connection| -> rusqlite::Result<_> {
            let mut state = rows(connection, "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?;
            let tables = connection
                .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for table in tables {
                let quoted = table.replace('"', "\"\"");
                let sql = if table == "engine_ownership" {
                    "SELECT rowid_guard,created_at_ms,engine_build,schema_version,store_role FROM engine_ownership".to_owned()
                } else {
                    format!("SELECT * FROM \"{quoted}\"")
                };
                state.extend(rows(connection, &sql)?);
            }
            Ok(state)
        }).unwrap()
    }

    fn rows(
        connection: &Connection,
        sql: &str,
    ) -> rusqlite::Result<Vec<Vec<rusqlite::types::Value>>> {
        let mut statement = connection.prepare(sql)?;
        let columns = statement.column_count();
        statement
            .query_map([], |row| (0..columns).map(|index| row.get(index)).collect())?
            .collect()
    }
}
