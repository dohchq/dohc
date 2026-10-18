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
        text::read::<String>(&conn, "key").unwrap().as_bytes(),
        body.as_bytes()
    );
    assert_eq!(
        text::with_length(&conn, "key").unwrap(),
        (body.len() as i64, body.into())
    );
    assert_eq!(
        text::read::<String>(&conn, "absent").optional().unwrap(),
        None
    );
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
    let mut stmt = conn.prepare("SELECT b.sha256,CASE WHEN h.id=1 THEN b.sha256 ELSE 123 END FROM heads h LEFT JOIN blobs b ON b.sha256=h.sha ORDER BY h.id").unwrap();
    let values = stmt
        .query_map([], |row| {
            Ok((
                text::from_row::<Option<String>, _>(&conn, row, 0)?,
                text::length_from_row::<i64, _>(&conn, row, 1)?,
                text::capped_from_row(&conn, row, 0, 3)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        values,
        vec![(Some("🦀".into()), 4, None), (None, 123, None)]
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
