use super::*;
use dohc_engine_storage::StorageError;
use dohc_engine_testkit::ScratchDir;
use std::time::{Duration, Instant};

/// Adds a table to the closed store at `db` and damages its one page, which
/// no open reads.
fn damage_a_page(db: &std::path::Path) {
    let (root_page, page_size) = {
        let conn = rusqlite::Connection::open(db).unwrap();
        conn.execute_batch(
            "CREATE TABLE unread_pages (value); INSERT INTO unread_pages VALUES (1);",
        )
        .unwrap();
        let root_page: i64 = conn
            .query_row(
                "SELECT rootpage FROM sqlite_schema WHERE name = 'unread_pages'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let page_size: i64 = conn
            .pragma_query_value(None, "page_size", |row| row.get(0))
            .unwrap();
        (root_page as u64, page_size as u64)
    };
    use std::io::{Seek, SeekFrom, Write};
    let mut file = std::fs::OpenOptions::new().write(true).open(db).unwrap();
    // Page type 0 is no b-tree page.
    file.seek(SeekFrom::Start((root_page - 1) * page_size))
        .unwrap();
    file.write_all(&[0]).unwrap();
    file.sync_all().unwrap();
}

fn spawn(
    db: &std::path::Path,
    generation: u64,
    passive: bool,
) -> Result<WorkspaceActor, RuntimeError> {
    let identity = EngineDbIdentity::of_existing(db).unwrap();
    if passive {
        WorkspaceActor::spawn_passive(
            db.to_path_buf(),
            identity,
            generation,
            0,
            None,
            None,
            Default::default(),
        )
    } else {
        WorkspaceActor::spawn(
            db.to_path_buf(),
            identity,
            generation,
            0,
            None,
            Default::default(),
        )
    }
}

#[test]
fn an_actor_opens_a_damaged_store_then_stops_and_its_next_open_is_refused() {
    for passive in [false, true] {
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join("engine.db");
        if passive {
            drop(EngineStore::open_passive(&db, 0, None, None).unwrap());
        } else {
            drop(EngineStore::open(&db, 0).unwrap());
        }
        damage_a_page(&db);

        // The open serves before the store's pages are checked.
        let actor = spawn(&db, 1, passive).expect("the store opens");
        let handle = actor.handle();
        // The check runs on its own thread and ends the actor without a command from anyone.
        let waited = Instant::now();
        while handle.lifecycle() != LifecycleState::Damaged {
            assert!(
                waited.elapsed() < Duration::from_secs(30),
                "the actor stops once its store's page check finds damage"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(matches!(
            handle.run_blocking(|_, _| Ok(())),
            Err(RuntimeError::ActorUnavailable)
        ));
        drop(actor);

        assert!(matches!(
            spawn(&db, 2, passive),
            Err(RuntimeError::Storage(StorageError::StateCorrupt { .. }))
        ));
    }
}
