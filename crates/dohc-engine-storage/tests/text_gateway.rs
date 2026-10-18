use dohc_engine_storage::text;
use rusqlite::{Connection, OptionalExtension, params};

fn database() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,byte_length INTEGER NOT NULL,text TEXT NOT NULL) STRICT;
        CREATE TABLE heads(id INTEGER PRIMARY KEY,sha TEXT);").unwrap();
    conn
}

#[test]
fn bodies_keep_exact_bytes_and_existing_insert_semantics() {
    let conn = database();
    let body = "a\0e\u{301}é🦀\r\n";
    assert_eq!(
        text::insert(&conn, "key", body.len() as i64, body, true).unwrap(),
        1
    );
    assert_eq!(
        text::insert(&conn, "key", 99, "replacement", true).unwrap(),
        0
    );
    assert!(matches!(
        text::insert(&conn, "key", 99, "replacement", false),
        Err(rusqlite::Error::SqliteFailure(..))
    ));
    assert_eq!(
        text::read(&conn, "key").unwrap().as_bytes(),
        body.as_bytes()
    );
    assert_eq!(
        text::with_length(&conn, "key").unwrap(),
        (body.len() as i64, body.into())
    );
    assert_eq!(text::read(&conn, "absent").optional().unwrap(), None);
}

#[test]
fn capped_reads_keep_actual_and_recorded_lengths_separate() {
    let conn = database();
    text::insert(&conn, "small", 1, "🦀", false).unwrap();
    text::insert(&conn, "large", 100, "x", false).unwrap();
    assert_eq!(text::capped(&conn, "small", 2).unwrap(), (1, 4, None));
    assert_eq!(text::capped(&conn, "large", 2).unwrap(), (100, 1, None));
    assert_eq!(
        text::capped(&conn, "small", 4).unwrap(),
        (1, 4, Some("🦀".into()))
    );
    assert_eq!(text::lengths(&conn, "small").unwrap(), (1, 4));
    assert!(matches!(
        text::read_sized(&conn, "small", 4),
        Err(rusqlite::Error::QueryReturnedNoRows)
    ));
    assert!(!text::equals(&conn, "small", "x").unwrap());
    assert!(text::equals(&conn, "small", "🦀").unwrap());
}

#[test]
fn joined_reads_preserve_nulls_and_binary_length_projections() {
    let conn = database();
    text::insert(&conn, "key", 4, "🦀", false).unwrap();
    conn.execute_batch("INSERT INTO heads VALUES(1,'key'),(2,NULL);")
        .unwrap();
    let mut stmt = conn
        .prepare("SELECT b.sha256,123,b.text FROM heads h LEFT JOIN blobs b ON b.sha256=h.sha ORDER BY h.id")
        .unwrap();
    let values = stmt
        .query_map([], |row| {
            Ok((
                text::optional_from_row(&conn, row, 0)?,
                text::length_from_row(&conn, row, 0, 1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        values,
        vec![(Some("🦀".into()), 4, Some("🦀".into())), (None, 123, None)]
    );
}

#[test]
fn character_prefixes_and_byte_ranges_match_sqlite_including_nul() {
    let conn = database();
    for (key, body) in [
        ("unicode", "é🦀".repeat(40_000)),
        ("nul", "x\0🦀z".repeat(20_000)),
    ] {
        text::insert(&conn, key, body.len() as i64, &body, false).unwrap();
        let (actual, expected): (String, String) = conn
            .query_row(
                "SELECT sha256,substr(text,1,65536) FROM blobs WHERE sha256=?1",
                [key],
                |row| Ok((text::prefix_from_row(&conn, row, 0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(actual.as_bytes(), expected.as_bytes());
        for start in [1, 2, 65_535, 65_536, 65_537] {
            let expected: Vec<u8> = conn
                .query_row(
                    "SELECT substr(CAST(text AS BLOB),?2,?3) FROM blobs WHERE sha256=?1",
                    params![key, start, 65_536],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                text::byte_range(&conn, key, start, 65_536).unwrap(),
                expected
            );
        }
    }
}
#[test]
fn missing_body_in_selected_row_is_corruption_not_absence() {
    use rusqlite::OptionalExtension;
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE blobs(sha256 TEXT PRIMARY KEY, byte_length INTEGER, text TEXT);",
    )
    .unwrap();
    // The metadata row exists, but its body does not. Outer optional must
    // distinguish this from a missing metadata row, including after chunking.
    let result: rusqlite::Result<Option<Option<String>>> = conn
        .query_row("SELECT 'missing'", [], |row| {
            text::optional_from_row(&conn, row, 0)
        })
        .optional();
    assert!(
        matches!(result, Err(rusqlite::Error::SqliteFailure(ref e, _)) if e.code == rusqlite::ErrorCode::DatabaseCorrupt),
        "{result:?}"
    );
}

#[test]
fn batch_missing_key_is_corruption_including_duplicate_requests() {
    let conn = database();
    text::insert(&conn, "present", 1, "x", false).unwrap();
    let result = text::read_batch(&conn, ["present", "present", "missing"], None);
    assert!(
        matches!(result, Err(rusqlite::Error::SqliteFailure(ref error, _))
        if error.code == rusqlite::ErrorCode::DatabaseCorrupt)
    );
}

#[test]
fn batch_handles_long_lists_and_returns_each_body() {
    let conn = database();
    let keys: Vec<_> = (0..2_000).map(|i| format!("key-{i}")).collect();
    for key in &keys {
        text::insert(&conn, key, key.len() as i64, key, false).unwrap();
    }
    let mut bodies = text::read_batch(&conn, keys.iter().map(String::as_str), None).unwrap();
    assert_eq!(bodies.len(), keys.len());
    for key in &keys {
        assert_eq!(bodies.get_mut(key).unwrap().take_text().as_ref(), Some(key));
    }
}

#[test]
fn batch_keeps_joined_nulls_order_duplicates_and_caps() {
    let conn = database();
    for (key, recorded, body) in [("a", 4, "🦀"), ("b", 1, "b"), ("lie", 1, "long")] {
        text::insert(&conn, key, recorded, body, false).unwrap();
    }
    conn.execute_batch("INSERT INTO heads VALUES(1,'b'),(2,NULL),(3,'a'),(4,'b'),(5,'absent');")
        .unwrap();
    let keys: Vec<Option<String>> = conn
        .prepare("SELECT b.sha256 FROM heads h LEFT JOIN blobs b ON b.sha256=h.sha ORDER BY h.id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut bodies =
        text::read_batch(&conn, keys.iter().filter_map(Option::as_deref), Some(3)).unwrap();
    let values: Vec<_> = keys
        .iter()
        .map(|key| {
            key.as_ref()
                .and_then(|key| bodies.get_mut(key).unwrap().take_text())
        })
        .collect();
    assert_eq!(
        values,
        vec![Some("b".into()), None, None, Some("b".into()), None]
    );
    let bodies = text::read_batch(&conn, ["a", "lie"], Some(3)).unwrap();
    assert_eq!((bodies["a"].recorded, bodies["a"].actual), (4, 4));
    assert_eq!((bodies["lie"].recorded, bodies["lie"].actual), (1, 4));
    assert!(bodies["lie"].text.is_none());
    assert!(text::read_batch(&conn, [], None).unwrap().is_empty());
}

#[test]
fn batch_reader_keeps_metadata_snapshot_across_write_and_delete() {
    let scratch = dohc_test_scratch::ScratchDir::new_named("text-batch-snapshot").unwrap();
    let path = scratch.join("test.db");
    let writer = Connection::open(&path).unwrap();
    writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE blobs(sha256 TEXT PRIMARY KEY,byte_length INTEGER,text TEXT); CREATE TABLE heads(sha TEXT); INSERT INTO blobs VALUES('old',3,'old'); INSERT INTO heads VALUES('old');").unwrap();
    // The second connection reads while the first commits a replacement and GC.
    let reader = Connection::open(&path).unwrap();
    let snapshot = text::ReadSnapshot::new(&reader).unwrap();
    let key: String = reader
        .query_row("SELECT sha FROM heads", [], |row| row.get(0))
        .unwrap();
    writer.execute_batch("BEGIN IMMEDIATE; INSERT INTO blobs VALUES('new',3,'new'); UPDATE heads SET sha='new'; DELETE FROM blobs WHERE sha256='old'; COMMIT;").unwrap();
    let mut bodies = text::read_batch(&reader, [key.as_str()], None).unwrap();
    assert_eq!(
        bodies.get_mut(&key).unwrap().take_text().as_deref(),
        Some("old")
    );
    snapshot.finish(Ok(()), |error| error).unwrap();
    assert!(reader.is_autocommit());
    assert_eq!(
        reader
            .query_row("SELECT sha FROM heads", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "new"
    );
}

#[test]
fn snapshot_preserves_caller_transaction_and_releases_on_error() {
    let conn = database();
    conn.execute_batch("BEGIN").unwrap();
    let snapshot = text::ReadSnapshot::new(&conn).unwrap();
    snapshot.finish(Ok(()), |error| error).unwrap();
    assert!(!conn.is_autocommit());
    conn.execute_batch("ROLLBACK").unwrap();
    let snapshot = text::ReadSnapshot::new(&conn).unwrap();
    assert!(!conn.is_autocommit());
    drop(snapshot);
    assert!(conn.is_autocommit());
    let snapshot = text::ReadSnapshot::new(&conn).unwrap();
    let result = snapshot.finish::<(), _>(Err(rusqlite::Error::InvalidQuery), |error| error);
    assert!(matches!(result, Err(rusqlite::Error::InvalidQuery)));
    assert!(conn.is_autocommit());
}
