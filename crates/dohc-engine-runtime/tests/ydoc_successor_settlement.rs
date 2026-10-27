use dohc_engine_collab::{ContentKind, DocKey};
use dohc_engine_domain::{
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, DomainError,
    ResolveConflictKind, ResolveTextConflict, TextConflict, TextSnapshot, VersionedTextStore,
    WriteText, insert_text_conflict_if_absent,
};
use dohc_engine_storage::{EngineStore, NoFaults, StorageError};
use dohc_engine_testkit::ScratchDir;

fn document_conflict_store(incoming_text: &str) -> (ScratchDir, EngineStore, DocKey) {
    let scratch = ScratchDir::new().expect("scratch");
    let mut store = EngineStore::open(
        &dohc_engine_testkit::engine_db_path(&scratch).expect("db path"),
        1_000,
    )
    .expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("workspace");
    let current = VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "document-object".to_owned(),
                path: "doc.md".to_owned(),
                text: "Current body".to_owned(),
                moment_id: "moment-current".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("current document");
    let key = DocKey::new("ws", "main", "document-object").expect("document key");
    let doc = dohc_engine_collab::Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, "Current body")
        .expect("import current document");
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        11,
    )
    .expect("claim document base");
    let incoming = TextSnapshot {
        workspace_id: "ws".to_owned(),
        version_id: "peer".to_owned(),
        object_id: "peer-document-object".to_owned(),
        path: "doc.md".to_owned(),
        text: incoming_text.to_owned(),
        blob_sha256: dohc_engine_storage::hex_sha256(incoming_text.as_bytes()),
        updated_at_ms: 12,
        latest_moment_id: "moment-incoming".to_owned(),
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
    };
    let conflict = TextConflict {
        conflict_id: "document-conflict".to_owned(),
        workspace_id: "ws".to_owned(),
        path: "doc.md".to_owned(),
        target_version_id: "main".to_owned(),
        source_version_id: "peer".to_owned(),
        created_at_ms: 12,
        updated_at_ms: 12,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("sync"),
        base: ConflictFileState::text("doc.md", None),
        current: ConflictFileState::text("doc.md", Some(current.snapshot)),
        incoming: ConflictFileState::text("doc.md", Some(incoming)),
    };
    store
        .write_with(&NoFaults, |tx| {
            insert_text_conflict_if_absent(tx, &conflict).map(|_| ())
        })
        .expect("open document conflict");
    (scratch, store, key)
}

fn sync_as_domain(error: dohc_engine_sync::SyncError) -> DomainError {
    match error {
        dohc_engine_sync::SyncError::Storage(storage) => DomainError::Storage(storage),
        dohc_engine_sync::SyncError::InvalidInput { reason } => {
            DomainError::InvalidInput { reason }
        }
        other => DomainError::Storage(StorageError::corrupt_public(other)),
    }
}

fn resolve_document_conflict(store: &mut EngineStore) {
    let input = ResolveTextConflict {
        workspace_id: "ws".to_owned(),
        conflict_id: "document-conflict".to_owned(),
        resolution: ResolveConflictKind::ApplyIncoming,
        object_id: "document-object".to_owned(),
        write_moment_id: "moment-resolved-20".to_owned(),
        delete_moment_id: "moment-delete-unused-20".to_owned(),
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 20,
        request_id: Some("resolve-content-20".to_owned()),
        conflict_answer_budget_bytes: usize::MAX,
    };
    let result = VersionedTextStore::new(store)
        .resolve_text_conflict_with(
            &input,
            &NoFaults,
            |tx, conflict, _| {
                let prepared =
                    dohc_engine_sync::prepare_local_conflict_resolve_v1_in_tx(tx, &input, conflict)
                        .map_err(sync_as_domain)?;
                prepared
                    .ensure_no_live_ydoc_session(&dohc_engine_sync::NoLiveLeases)
                    .map_err(sync_as_domain)?;
                Ok(prepared)
            },
            |tx, result, prepared| {
                dohc_engine_sync::commit_local_conflict_resolve_v1_in_tx(tx, &prepared, result)
                    .map_err(sync_as_domain)
            },
        )
        .expect("resolve document conflict");
    assert_eq!(result.conflict.status, ConflictStatus::Resolved);
}

async fn settle_document_successor(
    actor: &dohc_engine_runtime::ActorHandle,
    scratch: &ScratchDir,
    key: &DocKey,
    claim: &str,
    sha: &str,
    now_ms: i64,
) -> Box<dohc_engine_runtime::YdocSettlement> {
    use std::sync::Arc;
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            "doc.md".to_owned(),
            ContentKind::Richdoc,
            Some(claim.to_owned()),
            Some(sha.to_owned()),
            "successor-test".to_owned(),
            Arc::new(()),
            now_ms,
            Arc::new(NoFaults),
            dohc_engine_runtime::CancellationToken::new(),
            None,
        
            None,
        )
        .await
        .expect("runtime settlement")
        .settled()
        .expect("settled without deferred updates")
}

#[tokio::test]
async fn successor_no_edit_runtime_settlement_preserves_exact_source() {
    for incoming in [
        "- parent\n  - child\n".to_owned(),
        "- parent\n  - child\n- sibling\n".to_owned(),
        format!("{}quoted\n", "> ".repeat(120)),
    ] {
        let (scratch, mut store, key) = document_conflict_store(&incoming);
        resolve_document_conflict(&mut store);
        // Match the installed file before the editor opens its successor.
        let path = scratch.path().join("doc.md");
        std::fs::write(&path, &incoming).expect("installed successor file");
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let claim = dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .lineage_claim_id
            .unwrap();
        let sha = dohc_engine_storage::hex_sha256(incoming.as_bytes());
        let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
        drop(store);
        let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 21).unwrap().actor;
        let settled = settle_document_successor(&actor, &scratch, &key, &claim, &sha, 22).await;
        supervisor.close(&db).unwrap();
        assert_eq!(settled.projection.content, incoming);
        assert_eq!(settled.moment_id, "moment-resolved-20");
        assert!(settled.materialized);
        assert_eq!(std::fs::read(&path).unwrap(), incoming.as_bytes());
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
    }
}

#[tokio::test]
async fn successor_body_edit_canonicalizes_source_and_keeps_nested_list() {
    use std::sync::Arc;

    let incoming = "- parent\n  - child\n\nOriginal paragraph\n";
    let (scratch, mut store, key) = document_conflict_store(incoming);
    dohc_engine_sync::adopt_join_identity(
        &mut store,
        "ws",
        "local-origin",
        "epoch",
        "stream",
        12,
        &NoFaults,
    )
    .expect("replicated edit identity");
    resolve_document_conflict(&mut store);
    let path = scratch.path().join("doc.md");
    std::fs::write(&path, incoming).expect("installed successor file");
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    let loaded = dohc_engine_collab::load_persisted(&store, &key)
        .unwrap()
        .unwrap();
    let claim = dohc_engine_collab::read_marker(&store, &key)
        .unwrap()
        .unwrap()
        .lineage_claim_id
        .unwrap();
    let sha = dohc_engine_storage::hex_sha256(incoming.as_bytes());
    let db = dohc_engine_testkit::engine_db_path(&scratch).unwrap();
    drop(store);
    let supervisor = dohc_engine_runtime::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 21).unwrap().actor;
    let control = settle_document_successor(&actor, &scratch, &key, &claim, &sha, 22).await;
    assert_eq!(control.projection.content, incoming);
    assert_eq!(control.moment_id, "moment-resolved-20");
    assert!(control.materialized);
    assert_eq!(std::fs::read(&path).unwrap(), incoming.as_bytes());
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );

    let update = loaded.doc.richdoc_append_paragraph("Added paragraph");
    actor
        .ydoc_record_update(
            key.clone(),
            "doc.md".to_owned(),
            ContentKind::Richdoc,
            dohc_engine_collab::Regime::Replicated,
            update,
            None,
            None,
            Some(claim.clone()),
            false,
            None,
            None,
            23,
            Arc::new(NoFaults),
            dohc_engine_runtime::CancellationToken::new(),
            None,
        )
        .await
        .expect("persist body edit");
    let edited = settle_document_successor(&actor, &scratch, &key, &claim, &sha, 24).await;
    supervisor.close(&db).unwrap();
    let canonical = "- parent\n  - child\n\nOriginal paragraph\n\nAdded paragraph";
    assert_eq!(edited.projection.content, canonical);
    assert_ne!(edited.moment_id, control.moment_id);
    assert!(edited.materialized);
    assert_eq!(std::fs::read(&path).unwrap(), canonical.as_bytes());
}
