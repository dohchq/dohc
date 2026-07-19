use dohc_engine_runtime::{
    CancellationToken, CaptureIngest, CaptureRetire, NoFaults, RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

#[test]
fn blocking_capture_variants_round_trip_through_the_actor() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");

    let written = handle
        .capture_ingest_blocking(
            CaptureIngest {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                text: "captured".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                author_json: None,
                now_ms: 10,
                request_id: Some("actor-capture-request".to_owned()),
            },
            Arc::new(NoFaults),
        )
        .expect("blocking capture");

    assert_eq!(written.snapshot.text, "captured");
    assert_eq!(written.snapshot.path, "notes/a.md");

    let retired = handle
        .capture_retire_blocking(
            CaptureRetire {
                workspace_id: "ws-actor-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/a.md".to_owned(),
                now_ms: 20,
                request_id: Some("actor-retire-request".to_owned()),
                only_if_text_head: false,
            },
            Arc::new(NoFaults),
        )
        .expect("blocking retire");
    assert!(retired.retired.is_some());
    supervisor.close(&db).expect("close actor");
}

#[tokio::test]
async fn async_capture_variants_round_trip_and_honor_precancellation() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");

    let written = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/async.md".to_owned(),
                text: "captured asynchronously".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                author_json: None,
                now_ms: 10,
                request_id: Some("actor-async-capture-request".to_owned()),
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async capture");
    assert_eq!(written.snapshot.text, "captured asynchronously");

    let retired = handle
        .capture_retire(
            CaptureRetire {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/async.md".to_owned(),
                now_ms: 20,
                request_id: Some("actor-async-retire-request".to_owned()),
                only_if_text_head: false,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async retire");
    assert!(retired.retired.is_some());

    let retained = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/retained.md".to_owned(),
                text: "must survive cancelled retire".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                author_json: None,
                now_ms: 25,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture retained path");

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/cancelled.md".to_owned(),
                text: "must not be written".to_owned(),
                metadata_origin: "actor-test".to_owned(),
                author_json: None,
                now_ms: 30,
                request_id: None,
            },
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("pre-cancelled capture must fail");
    assert!(matches!(error, RuntimeError::Cancelled));

    let cancelled_read = handle
        .versioned_text_read(
            "ws-actor-async-capture".to_owned(),
            "main".to_owned(),
            "notes/cancelled.md".to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read cancelled ingest path");
    assert!(cancelled_read.is_none());

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = handle
        .capture_retire(
            CaptureRetire {
                workspace_id: "ws-actor-async-capture".to_owned(),
                version_id: "main".to_owned(),
                path: "notes/retained.md".to_owned(),
                now_ms: 40,
                request_id: None,
                only_if_text_head: false,
            },
            Arc::new(NoFaults),
            cancelled,
        )
        .await
        .expect_err("pre-cancelled retire must fail");
    assert!(matches!(error, RuntimeError::Cancelled));

    let retained_read = handle
        .versioned_text_read(
            "ws-actor-async-capture".to_owned(),
            "main".to_owned(),
            "notes/retained.md".to_owned(),
            CancellationToken::new(),
        )
        .await
        .expect("read retained path")
        .expect("retained path must remain present");
    assert_eq!(retained_read, retained.snapshot);

    supervisor.close(&db).expect("close actor");

    let store = EngineStore::open(&db, 50).expect("reopen store");
    let (cancelled_snapshots, cancelled_moments, retained_snapshots, retained_moments): (
        i64,
        i64,
        i64,
        i64,
    ) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/cancelled.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/cancelled.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/retained.md"],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 \
                     AND version_id = ?2 AND path = ?3",
                    ["ws-actor-async-capture", "main", "notes/retained.md"],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("capture persistence counts");
    assert_eq!((cancelled_snapshots, cancelled_moments), (0, 0));
    assert_eq!((retained_snapshots, retained_moments), (1, 1));
}

#[tokio::test]
async fn binary_capture_round_trips_through_the_actor_both_ways() {
    use dohc_engine_runtime::CaptureIngestBinary;

    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor");
    let input = |bytes: &[u8], now_ms: i64| CaptureIngestBinary {
        workspace_id: "ws-actor-capture-bin".to_owned(),
        version_id: "main".to_owned(),
        path: "photo.png".to_owned(),
        bytes: bytes.to_vec(),
        metadata_origin: "actor-test".to_owned(),
        author_json: None,
        now_ms,
        request_id: None,
    };

    let written = handle
        .capture_ingest_binary(
            input(&[0xff, 0x00], 10),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("async binary capture");
    assert!(!written.deduped);

    // Content-equality dedupe through the actor (the blocking variant is
    // exercised end-to-end by the capture-sink tests, which run outside a
    // tokio runtime as the real reconcile driver will).
    let deduped = handle
        .capture_ingest_binary(
            input(&[0xff, 0x00], 20),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("equal binary capture");
    assert!(deduped.deduped);
    assert_eq!(deduped.moment_order, written.moment_order);

    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let err = handle
        .capture_ingest_binary(input(&[1], 30), Arc::new(NoFaults), cancelled)
        .await
        .expect_err("pre-cancelled binary capture is refused");
    assert!(matches!(err, RuntimeError::Cancelled));

    supervisor.close(&db).expect("close actor");
}
