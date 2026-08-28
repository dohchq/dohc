//! The local append path validates update bytes ONCE, in the durable layer's
//! `validate_update_bytes`, inside the append transaction. A malformed first
//! seed must still be rejected end-to-end through the actor AND must not
//! strand a bare `file_objects` row for the deterministic object id (which
//! regular writes then treat as already existing). Mutation check: move
//! `validate_update_bytes` after the transaction's parent-row insert commits,
//! or drop it, and the stranded-row assertion below fails.

use dohc_engine_collab::{CollabError, ContentKind, Regime, Ydoc};
use dohc_engine_runtime::{CancellationToken, NoFaults, RuntimeError, WorkspaceSupervisor};
use dohc_engine_storage::EngineStore;
use dohc_engine_testkit::ScratchDir;
use std::sync::Arc;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn malformed_seed_is_rejected_without_stranding_the_parent_row() {
    const WS: &str = "ws-malformed-seed";
    const PATH: &str = "notes/malformed-seed.md";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1).expect("actor").actor;
    actor
        .ensure_main_version(
            WS.to_owned(),
            1,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("main");
    let open = actor
        .ydoc_open_state(
            WS.to_owned(),
            2,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Plaintext),
            CancellationToken::new(),
        )
        .await
        .expect("open ydoc");

    // One byte declaring a client entry and then ending: scan_v1 rejects it
    // deterministically, every time.
    let malformed = vec![0x01];
    let error = actor
        .ydoc_record_update(
            open.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            malformed,
            None,
            None,
            true,
            None,
            None,
            3,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("a malformed seed must be rejected");
    assert!(
        matches!(
            error,
            RuntimeError::Collab(CollabError::ReplayParityViolation { .. })
        ),
        "the durable validator names the defect: {error:?}"
    );
    supervisor.close(&db).expect("close actor");

    // The rejection rolled the WHOLE transaction back: no parent row, no
    // marker, no journaled update.
    let object_id = open.key.object_id.clone();
    {
        let store = EngineStore::open(&db, 100).expect("open store");
        let (parents, markers, updates): (i64, i64, i64) = store
            .read_with(|conn| -> Result<_, rusqlite::Error> {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM file_objects WHERE workspace_id=?1 AND object_id=?2",
                        rusqlite::params![WS, object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id=?1 AND object_id=?2",
                        rusqlite::params![WS, object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id=?1 AND object_id=?2",
                        rusqlite::params![WS, object_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("count");
        assert_eq!(parents, 0, "a malformed seed must not strand a parent row");
        assert_eq!(markers, 0, "a malformed seed must not create a marker");
        assert_eq!(updates, 0, "a malformed seed must never be journaled");
    }

    // The genuine seed still lands afterward: the rejection left nothing that
    // makes the object look like it already exists.
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).expect("reopen actor").actor;
    let appended = actor
        .ydoc_record_update(
            open.key.clone(),
            PATH.to_owned(),
            ContentKind::Plaintext,
            Regime::LocalOnly,
            Ydoc::wire().plaintext_insert(0, "genuine seed"),
            None,
            None,
            true,
            None,
            None,
            5,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("genuine seed lands");
    assert!(!appended.outcome.deduped, "the seed is a fresh append");
    supervisor.close(&db).expect("close actor");
}
