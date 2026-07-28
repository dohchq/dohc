use std::path::Path;
use std::sync::Arc;

use dohc_engine_domain::{
    CaptureIngest, ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus,
    CreateNamedVersion, ResolveConflictKind, ResolveTextConflict, TextConflict, TextSnapshot,
    VersionedTextStore, WriteText,
};
use dohc_engine_runtime::search::{ensure_search_index_for_version, search_workspace};
use dohc_engine_runtime::{CancellationToken, NoFaults, SearchResult, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_sync::{
    ApplyOutcome, NoLiveLeases, ReplicationEnvelope, SyncError, apply_conflict_envelope,
    apply_envelope_with, apply_ydoc_envelope,
};
use dohc_engine_testkit::ScratchDir;
use rusqlite::params;
use serde_json::json;

const WS: &str = "ws";
const VERSION: &str = "main";

fn open_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let mut store = EngineStore::open(&db, 1_000).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, VERSION, 1_000, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn write_text(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    now_ms: i64,
) -> TextSnapshot {
    VersionedTextStore::new(store)
        .write_text(
            &WriteText {
                workspace_id: WS.to_owned(),
                version_id: VERSION.to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment_id.to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("write text")
        .snapshot
}

fn certify(store: &EngineStore, root: &Path, now_ms: i64) {
    store
        .read_with(|connection| {
            ensure_search_index_for_version(connection, root, WS, VERSION, now_ms, &NoFaults)
        })
        .expect("certify search index");
}

fn search_store(store: &EngineStore, root: &Path, query: &str, now_ms: i64) -> Vec<SearchResult> {
    store
        .read_with(|connection| {
            search_workspace(connection, root, WS, VERSION, query, Some(100), now_ms)
        })
        .expect("search workspace")
}

fn envelope(
    origin_id: &str,
    origin_seq: i64,
    op_kind: &str,
    payload: serde_json::Value,
    recorded_at_ms: i64,
) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: WS.to_owned(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        op_kind: op_kind.to_owned(),
        payload,
        recorded_at_ms,
    }
}

#[test]
fn replicated_ydoc_base_projection_updates_certified_search_index() {
    const PATH: &str = "notes/replicated.md";
    const NEEDLE: &str = "replicatedydocmutationneedle";
    let (scratch, mut store) = open_store();
    certify(&store, scratch.path(), 1_100);

    let doc = dohc_engine_collab::Ydoc::wire();
    doc.plaintext_insert(0, NEEDLE);
    let blob_sha = store
        .put_binary_blob(&doc.encode_full_state())
        .expect("store Y.Doc base");
    let operation = envelope(
        "ydoc-peer",
        0,
        "ydoc.update",
        json!({
            "versionId": VERSION,
            "objectId": "replicated-ydoc-object",
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha,
            "isBaseState": true
        }),
        1_200,
    );

    assert!(matches!(
        apply_ydoc_envelope(&mut store, &operation, &NoFaults, &NoLiveLeases),
        Ok(ApplyOutcome::Applied(_))
    ));
    let hits = search_store(&store, scratch.path(), NEEDLE, 1_300);
    assert_eq!(
        hits.iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "replicated Y.Doc projection must update an already-certified index"
    );
}

#[test]
fn mirrored_text_conflict_resolution_replaces_certified_search_content() {
    const PATH: &str = "doc.md";
    const OLD: &str = "mirroredconflictoldneedle";
    const NEW: &str = "mirroredconflictnewneedle";
    let (scratch, mut store) = open_store();
    let current = write_text(
        &mut store,
        "current-object",
        PATH,
        OLD,
        "current-moment",
        1_100,
    );
    certify(&store, scratch.path(), 1_200);
    assert_eq!(search_store(&store, scratch.path(), OLD, 1_201).len(), 1);

    let opened = envelope(
        "conflict-peer",
        0,
        "conflict.open",
        json!({
            "id": "mirrored-conflict",
            "workspaceId": WS,
            "path": PATH,
            "targetVersionId": VERSION,
            "sourceVersionId": "peer-version",
            "createdAtMs": 1_300,
            "updatedAtMs": 1_300,
            "base": { "exists": false, "path": PATH, "contentKind": "text" },
            "current": {
                "exists": true,
                "path": PATH,
                "objectId": current.object_id,
                "contentKind": "text",
                "text": current.text,
                "updatedAtMs": current.updated_at_ms,
                "latestMomentId": current.latest_moment_id,
                "metadata": { "origin": current.metadata_origin }
            },
            "incoming": {
                "exists": true,
                "path": PATH,
                "objectId": "incoming-object",
                "contentKind": "text",
                "text": NEW,
                "updatedAtMs": 1_250,
                "latestMomentId": "incoming-moment",
                "metadata": { "origin": "sync" }
            },
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": "sync" }
        }),
        1_300,
    );
    assert!(matches!(
        apply_conflict_envelope(&mut store, &opened, &NoFaults),
        Ok(ApplyOutcome::Applied(_))
    ));

    // A sync-origin conflict is mirrored. The peer's kept-current decision
    // therefore applies the receiver's recorded incoming side.
    let resolved = envelope(
        "conflict-peer",
        1,
        "conflict.resolve",
        json!({
            "conflictId": "mirrored-conflict",
            "status": "resolved",
            "chosenFrom": "current",
            "resolution": "kept-current",
            "updatedAtMs": 1_400,
            "targetVersionId": VERSION
        }),
        1_400,
    );
    assert!(matches!(
        apply_conflict_envelope(&mut store, &resolved, &NoFaults),
        Ok(ApplyOutcome::Applied(result)) if result.matched && !result.deferred()
    ));

    let new_hits = search_store(&store, scratch.path(), NEW, 1_500);
    assert_eq!(
        new_hits
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "mirrored conflict resolution must index the resolved text"
    );
    assert!(
        search_store(&store, scratch.path(), OLD, 1_501).is_empty(),
        "mirrored conflict resolution must remove the old indexed body"
    );
}

#[test]
fn refused_replicated_mutation_rolls_back_fts_writes() {
    const PATH: &str = "baseline.md";
    const BASELINE: &str = "refusalbaselineindexneedle";
    const RESIDUE: &str = "refusalresidueindexneedle";
    let (scratch, mut store) = open_store();
    let baseline = write_text(
        &mut store,
        "baseline-object",
        PATH,
        BASELINE,
        "baseline-moment",
        1_100,
    );
    certify(&store, scratch.path(), 1_200);

    let refused = envelope(
        "refusal-peer",
        0,
        "moment.append",
        json!({ "probe": "fts-savepoint" }),
        1_300,
    );
    let outcome = apply_envelope_with(&mut store, &refused, &NoFaults, |tx, _| {
        // Exercise the same admission savepoint that wraps every replicated
        // mutation: both a destructive FTS edit and a fresh row must disappear
        // when the operation returns a refusal-class error.
        tx.execute(
            "DELETE FROM engine_search_files_fts \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![WS, VERSION, baseline.object_id],
        )
        .map_err(StorageError::persist_public)?;
        tx.execute(
            "INSERT INTO engine_search_files_fts \
             (workspace_id,version_id,object_id,path,text) VALUES (?1,?2,?3,?4,?5)",
            params![WS, VERSION, "refusal-residue-object", "residue.md", RESIDUE],
        )
        .map_err(StorageError::persist_public)?;
        Err::<(), SyncError>(SyncError::InvalidInput {
            reason: "probe refusal after FTS mutation",
        })
    })
    .expect("refusal is acknowledged");
    assert!(matches!(outcome, ApplyOutcome::Refused(_)));

    assert_eq!(
        search_store(&store, scratch.path(), BASELINE, 1_400)
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "the refusal savepoint must restore an FTS row deleted by the mutation"
    );
    assert!(
        search_store(&store, scratch.path(), RESIDUE, 1_401).is_empty(),
        "the refusal savepoint must leave no newly inserted FTS residue"
    );
}

fn capture_text(path: &str, text: &str, now_ms: i64) -> CaptureIngest {
    CaptureIngest {
        workspace_id: WS.to_owned(),
        version_id: VERSION.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        metadata_origin: "capture".to_owned(),
        author_json: None,
        now_ms,
        request_id: None,
        claim_foreign_head: true,
    }
}

async fn search_actor(
    actor: &dohc_engine_runtime::ActorHandle,
    root: &Path,
    query: &str,
    now_ms: i64,
) -> Vec<SearchResult> {
    actor
        .search(
            root.to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            query.to_owned(),
            Some(100),
            now_ms,
            CancellationToken::new(),
        )
        .await
        .expect("actor search")
}

fn local_conflict(
    conflict_id: &str,
    path: &str,
    current: TextSnapshot,
    incoming: ConflictFileState,
    now_ms: i64,
) -> TextConflict {
    TextConflict {
        conflict_id: conflict_id.to_owned(),
        workspace_id: WS.to_owned(),
        path: path.to_owned(),
        target_version_id: VERSION.to_owned(),
        source_version_id: "local-source".to_owned(),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
        status: ConflictStatus::Open,
        chosen_from: ConflictChoice::Current,
        resolution: None,
        metadata: ConflictMetadata::origin("agent"),
        base: ConflictFileState::text(path, None),
        current: ConflictFileState::text(path, Some(current)),
        incoming,
    }
}

fn local_resolution(conflict_id: &str, suffix: &str, now_ms: i64) -> ResolveTextConflict {
    ResolveTextConflict {
        workspace_id: WS.to_owned(),
        conflict_id: conflict_id.to_owned(),
        resolution: ResolveConflictKind::ApplyIncoming,
        object_id: format!("resolved-object-{suffix}"),
        write_moment_id: format!("resolved-write-{suffix}"),
        delete_moment_id: format!("resolved-delete-{suffix}"),
        metadata_origin: "agent".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

#[tokio::test]
async fn local_conflict_resolution_actor_indexes_text_and_deletion() {
    const PATH: &str = "notes/local-conflict.md";
    const OLD: &str = "localconflictoldneedle";
    const NEW: &str = "localconflictnewneedle";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1_000).expect("open actor").actor;

    let current = actor
        .capture_ingest(
            capture_text(PATH, OLD, 1_100),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed current head")
        .snapshot;
    actor
        .ensure_search_index(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            VERSION.to_owned(),
            1_200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("certify actor index");

    let incoming = TextSnapshot {
        workspace_id: WS.to_owned(),
        version_id: "local-source".to_owned(),
        object_id: "incoming-object".to_owned(),
        path: PATH.to_owned(),
        text: NEW.to_owned(),
        blob_sha256: hex_sha256(NEW.as_bytes()),
        updated_at_ms: 1_250,
        latest_moment_id: "incoming-moment".to_owned(),
        metadata_origin: "agent".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
    };
    actor
        .conflict_open(
            Box::new(local_conflict(
                "local-text-conflict",
                PATH,
                current,
                ConflictFileState::text(PATH, Some(incoming)),
                1_300,
            )),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("open local text conflict");
    let written = actor
        .conflict_resolve(
            local_resolution("local-text-conflict", "text", 1_400),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("resolve local text conflict")
        .write
        .expect("text resolution writes")
        .snapshot;

    assert_eq!(
        search_actor(&actor, scratch.path(), NEW, 1_500)
            .await
            .iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "local conflict resolution must index its resolved text through the actor"
    );
    assert!(
        search_actor(&actor, scratch.path(), OLD, 1_501)
            .await
            .is_empty(),
        "local conflict resolution must remove its previous indexed body"
    );

    actor
        .conflict_open(
            Box::new(local_conflict(
                "local-delete-conflict",
                PATH,
                written,
                ConflictFileState::text(PATH, None),
                1_600,
            )),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("open local delete conflict");
    actor
        .conflict_resolve(
            local_resolution("local-delete-conflict", "delete", 1_700),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("resolve local delete conflict");
    assert!(
        search_actor(&actor, scratch.path(), NEW, 1_800)
            .await
            .is_empty(),
        "local conflict deletion must remove the indexed row through the actor"
    );

    supervisor.close(&db).expect("close actor");
}

#[tokio::test]
async fn named_version_creation_leaves_search_uncertified_for_lazy_first_build() {
    const PATH: &str = "notes/forked.md";
    const NEEDLE: &str = "namedversionlazysearchneedle";
    const NAMED: &str = "named-version";
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db path");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 1_000).expect("open actor").actor;

    actor
        .capture_ingest(
            capture_text(PATH, NEEDLE, 1_100),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed source head");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: WS.to_owned(),
                new_version_id: NAMED.to_owned(),
                name: "Named".to_owned(),
                from_version_id: VERSION.to_owned(),
                now_ms: 1_200,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create named version");
    supervisor.close(&db).expect("close actor for inspection");

    let store = EngineStore::open(&db, 1_300).expect("inspect store");
    let (state_rows, index_rows): (i64, i64) = store
        .read_with(|connection| {
            Ok::<_, rusqlite::Error>((
                connection.query_row(
                    "SELECT COUNT(*) FROM engine_search_index_state \
                     WHERE workspace_id=?1 AND version_id=?2",
                    params![WS, NAMED],
                    |row| row.get(0),
                )?,
                connection.query_row(
                    "SELECT COUNT(*) FROM engine_search_files_fts \
                     WHERE workspace_id=?1 AND version_id=?2",
                    params![WS, NAMED],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect named-version search state");
    assert_eq!(
        (state_rows, index_rows),
        (0, 0),
        "version creation must leave search uncertified instead of coupling the fork transaction to a rebuild"
    );
    drop(store);

    let actor = supervisor
        .open(&db, 1_400)
        .expect("reopen actor for lazy search")
        .actor;
    let hits = actor
        .search(
            scratch.path().to_path_buf(),
            WS.to_owned(),
            NAMED.to_owned(),
            NEEDLE.to_owned(),
            Some(100),
            1_500,
            CancellationToken::new(),
        )
        .await
        .expect("first named-version search");
    assert_eq!(
        hits.iter()
            .map(|result| result.path.as_str())
            .collect::<Vec<_>>(),
        [PATH],
        "the first search must lazily build the copied version's complete index"
    );

    supervisor.close(&db).expect("close reopened actor");
}
