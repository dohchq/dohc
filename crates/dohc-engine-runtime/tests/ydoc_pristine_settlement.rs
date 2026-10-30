use dohc_engine_collab::{CloseOutcome, CompactOutcome, ContentKind, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{CreateNamedVersion, VersionedTextStore, WriteText};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor, YdocOpenState,
    YdocSettlement,
};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::sync::Arc;

const WS: &str = "pristine-settlement";
const PATH: &str = "note.md";
const SOURCE: &str = "seed\r\n";

async fn open(actor: &ActorHandle, now: i64) -> YdocOpenState {
    actor
        .ydoc_open_state(
            WS.to_owned(),
            now,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
        .expect("open note")
}

async fn record(actor: &ActorHandle, state: &YdocOpenState, update: Vec<u8>, seed: bool) {
    actor
        .ydoc_record_update(
            state.key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            update,
            None,
            None,
            state.lineage_claim_id.clone(),
            seed,
            if seed {
                state.owner_seed_source.clone()
            } else {
                None
            },
            None,
            20,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .expect("record update");
}

async fn settle(
    actor: &ActorHandle,
    scratch: &ScratchDir,
    state: &YdocOpenState,
) -> Box<YdocSettlement> {
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            state.key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            state.lineage_claim_id.clone(),
            state.head_blob_sha256.clone(),
            "pristine-session".to_owned(),
            Arc::new(()),
            30,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("settle note")
        .settled()
        .expect("settled")
}

fn setup(sync: bool) -> ScratchDir {
    let scratch = ScratchDir::new().expect("scratch");
    std::fs::write(scratch.path().join(PATH), SOURCE).expect("source file");
    let db = engine_db_path(&scratch).expect("database");
    let mut store = EngineStore::open(&db, 1).expect("store");
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .expect("main");
    versions
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                object_id: "note".to_owned(),
                path: PATH.to_owned(),
                text: SOURCE.to_owned(),
                moment_id: "original-head".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("source head");
    if sync {
        store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO sync_identity (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) VALUES (?1, 'origin', 'epoch', 'stream', 1)", [WS]).map_err(StorageError::persist_public)?;
            tx.execute("INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) VALUES (?1, 'origin', 0)", [WS]).map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        }).expect("enable sync");
    }
    scratch
}

async fn pristine_cycles(sync: bool, edit: bool) -> ScratchDir {
    let scratch = setup(sync);
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 3).expect("actor").actor;
    let path = scratch.path().join(PATH);
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let source_sha = dohc_engine_storage::hex_sha256(SOURCE.as_bytes());
    for cycle in 0..2 {
        let state = open(&actor, 10 + cycle).await;
        let doc = if state.lineage_existing {
            let store = EngineStore::open(&db, 11).expect("store");
            dohc_engine_collab::load_persisted(&store, &state.key)
                .unwrap()
                .unwrap()
                .doc
        } else {
            assert_eq!(state.seed_content.as_deref(), Some(SOURCE));
            let doc = Ydoc::wire();
            let seed = doc.richdoc_append_paragraph("seed");
            record(&actor, &state, seed, true).await;
            doc
        };
        assert_ne!(doc.project(ContentKind::Richdoc).unwrap().content, SOURCE);
        let state = open(&actor, 25).await;
        {
            let store = EngineStore::open(&db, 26).expect("store");
            let marker = dohc_engine_collab::read_marker(&store, &state.key)
                .unwrap()
                .unwrap();
            assert_eq!(
                marker.regime,
                if sync {
                    Regime::Replicated
                } else {
                    Regime::LocalOnly
                }
            );
            assert_eq!(
                dohc_engine_collab::read_pristine_seed_lineage_source(&store, &state.key).unwrap(),
                Some(source_sha.clone())
            );
        }
        // Repeated settles within one session must retain the same witness too.
        for _ in 0..2 {
            let settled = settle(&actor, &scratch, &state).await;
            assert_eq!(settled.sha256, source_sha, "sync={sync}, cycle {cycle}");
            assert_eq!(settled.moment_id, "original-head");
            assert_eq!(settled.content.as_deref(), Some(SOURCE));
            assert!(settled.materialized);
        }
        assert_eq!(std::fs::read(&path).unwrap(), SOURCE.as_bytes());
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        {
            let mut store = EngineStore::open(&db, 31).expect("store");
            assert_eq!(
                dohc_engine_collab::read_last_settled_sha(&store, &state.key).unwrap(),
                None
            );
            let head = VersionedTextStore::new(&mut store)
                .read_text(WS, "main", PATH)
                .expect("read head")
                .expect("head");
            assert_eq!(head.text, SOURCE);
            assert_eq!(head.blob_sha256, source_sha);
            assert_eq!(head.latest_moment_id, "original-head");
        }
        if edit && cycle == 1 {
            record(
                &actor,
                &state,
                doc.richdoc_append_paragraph("edited"),
                false,
            )
            .await;
            let edited = settle(&actor, &scratch, &state).await;
            assert_ne!(edited.sha256, source_sha);
            assert_ne!(edited.moment_id, "original-head");
            let expected = doc.project(ContentKind::Richdoc).unwrap().content;
            assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
            let store = EngineStore::open(&db, 32).expect("store");
            assert_eq!(
                dohc_engine_collab::read_last_settled_sha(&store, &state.key).unwrap(),
                Some(edited.sha256)
            );
            assert_eq!(
                dohc_engine_collab::read_pristine_seed_lineage_source(&store, &state.key).unwrap(),
                None
            );
        }
        let closed = actor
            .ydoc_close_session_materialized(
                scratch.path().to_path_buf(),
                state.key,
                Arc::new(()),
                40,
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("close session");
        if sync && edit && cycle == 1 {
            assert!(matches!(
                closed.outcome,
                Some(CloseOutcome::Compacted(CompactOutcome::Compacted { .. }))
            ));
        }
    }
    supervisor.close(&db).expect("close actor");
    scratch
}

#[tokio::test]
async fn pristine_seed_keeps_bytes_across_repeated_settles_and_closes() {
    pristine_cycles(false, false).await;
    pristine_cycles(true, false).await;
}

#[tokio::test]
async fn pristine_seed_edits_still_settle_after_repeated_opens() {
    pristine_cycles(false, true).await;
    pristine_cycles(true, true).await;
}

#[tokio::test]
async fn closed_pristine_synced_seed_unloads_without_pending_settlement() {
    let scratch = pristine_cycles(true, false).await;
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 50).expect("actor").actor;
    let owner = actor
        .live_application_owner(WS.to_owned())
        .await
        .expect("live application owner");
    let key = dohc_engine_collab::DocKey::new(WS, "main", "note").expect("document key");
    let pending = owner
        .unload(
            key.object_id.clone(),
            None,
            vec![key],
            scratch.path().to_path_buf(),
            51,
        )
        .await
        .expect("unload pristine synced note");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        pending, None,
        "an untouched seed has no settlement to await"
    );
}

#[tokio::test]
async fn closed_pristine_synced_seed_allows_a_named_version() {
    let scratch = pristine_cycles(true, false).await;
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 50).expect("actor").actor;
    assert_eq!(
        actor
            .ydoc_version_unsettled_content_kind(
                WS.to_owned(),
                "main".to_owned(),
                Vec::new(),
                CancellationToken::new(),
            )
            .await
            .expect("fork guard"),
        None,
        "a closed pristine synced note has no unsaved edits to block a fork"
    );
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: "copy".to_owned(),
                name: "Copy".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 51,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create named version");
    supervisor.close(&db).expect("close actor");
    let mut store = EngineStore::open(&db, 52).expect("store");
    let copied = VersionedTextStore::new(&mut store)
        .read_text(WS, "copy", PATH)
        .expect("read copied head")
        .expect("copied head");
    assert_eq!(copied.text, SOURCE);
}

#[tokio::test]
async fn capture_after_a_closed_pristine_synced_seed_creates_no_recovery_sibling() {
    let scratch = pristine_cycles(true, false).await;
    let db = engine_db_path(&scratch).expect("database");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 50).expect("actor").actor;
    let outside = "Written outside dohc.\n";
    std::fs::write(scratch.path().join(PATH), outside).expect("outside edit");
    actor
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: outside.to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 51,
                request_id: None,
                claim_foreign_head: true,
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture outside edit");
    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), WS.to_owned(), 52)
        .await
        .expect("materialize pending writes");
    supervisor.close(&db).expect("close actor");
    let mut store = EngineStore::open(&db, 53).expect("store");
    let paths = store
        .read_with(|conn| {
            let mut query = conn.prepare(
                "SELECT path FROM snapshots WHERE workspace_id=?1 AND version_id='main' ORDER BY path",
            )?;
            query
                .query_map([WS], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("recorded files");
    assert_eq!(paths, [PATH], "capture must not recover an unedited seed");
    let head = VersionedTextStore::new(&mut store)
        .read_text(WS, "main", PATH)
        .expect("read head")
        .expect("head");
    assert_eq!(head.text, outside);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).unwrap(),
        outside
    );
    let extra_files = std::fs::read_dir(scratch.path())
        .expect("workspace files")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name != PATH && name != ".dohc")
        .collect::<Vec<_>>();
    assert!(extra_files.is_empty(), "unexpected files: {extra_files:?}");
}
