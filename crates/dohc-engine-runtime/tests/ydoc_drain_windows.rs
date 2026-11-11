//! The open and close paths drain the deferred Y.Doc queue, then run a
//! fallible step. The queue rows carry the record facts the drain persisted
//! on them, so an error in that window must leave the rows in place:
//! a retry re-drains content-deduped and can still surface the facts.
//! Consuming them first drops the events with no path left to emit.
//!
//! Record facts derive only for bound collection records; these plaintext
//! tests pin the QUEUE-ROW ordering. The rows-to-events pipeline itself is
//! pinned by the `a_parked_update_drained_on_*` rpc tests.

use dohc_engine_collab::DocKey;
use dohc_engine_runtime::{CancellationToken, CaptureIngest, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError};
use dohc_engine_sync::{AlwaysLive, NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults, engine_db_path};
use std::sync::Arc;

const WS: &str = "ws-drain-windows";
const PATH: &str = "notes/live.md";

fn deferred_rows(db: &std::path::Path) -> i64 {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_deferred_updates", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .expect("count deferred rows")
}

fn applied_update_rows(db: &std::path::Path) -> i64 {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    store
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM ydoc_updates", [], |row| {
                row.get::<_, i64>(0)
            })
        })
        .expect("count applied updates")
}

/// A captured head, a replicated base, and one update parked behind a live
/// lease — the state a crashed session leaves for a later drain to apply.
async fn seed_parked_update(scratch: &ScratchDir) -> DocKey {
    seed_parked_update_kind(scratch, false).await
}

async fn seed_parked_update_kind(scratch: &ScratchDir, markdown: bool) -> DocKey {
    let source = if markdown {
        "Imported source\n"
    } else {
        "before"
    };
    let db = engine_db_path(scratch).expect("db");
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 1).expect("open actor").actor;
    let written = handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text: source.to_owned(),
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: Some("drain-windows-seed".to_owned()),
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture");
    let object_id = written.snapshot.object_id.clone();
    supervisor.close(&db).expect("close actor");
    std::fs::create_dir_all(scratch.path().join("notes")).expect("notes dir");
    std::fs::write(scratch.path().join(PATH), source).expect("disk preimage");

    let key = DocKey::new(WS, "main", &object_id).expect("key");
    let mut store = EngineStore::open(&db, 100).expect("open store");
    let doc = dohc_engine_collab::Ydoc::wire();
    if markdown {
        doc.rewrite_content_to_markdown_preserving_source(
            dohc_engine_collab::ContentKind::Richdoc,
            source,
        )
        .unwrap();
    } else {
        doc.plaintext_insert(0, source);
    }
    let kind = if markdown { "richdoc" } else { "plaintext" };
    let base_bytes = doc.encode_full_state();
    let base_sha = store.put_binary_blob(&base_bytes).expect("base blob");
    let base = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 0,
        relay_seq: Some(0),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": kind,
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
        recorded_at_ms: 110,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("apply verified base");

    let update_bytes = if markdown {
        doc.richdoc_append_paragraph("Accepted parked Markdown edit");
        doc.encode_full_state()
    } else {
        doc.plaintext_insert(6, " parked")
    };
    let blob_sha = store.put_binary_blob(&update_bytes).expect("blob");
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: "peer".to_owned(),
        origin_seq: 1,
        relay_seq: Some(1),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": object_id,
            "path": PATH,
            "contentKind": kind,
            "updateBlobSha256": blob_sha,
            "lineageClaimId": base_sha,
            "isBaseState": false
        }),
        recorded_at_ms: 120,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("park");
    drop(store);
    assert_eq!(deferred_rows(&db), 1, "the envelope starts parked");
    key
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn markdown_hold_open_resync_and_close_keep_the_file_and_consume_only_parked_rows() {
    use dohc_engine_collab::{ContentKind, Ydoc, markdown_write_obligations};
    use dohc_engine_storage::hex_sha256;
    for operation in ["open", "resync", "close"] {
        let scratch = ScratchDir::new().unwrap();
        let db = engine_db_path(&scratch).unwrap();
        let key = seed_parked_update_kind(&scratch, true).await;
        let path = scratch.path().join(PATH);
        let bytes = std::fs::read(&path).unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let (claim, counts) = {
            let store = EngineStore::open_read_only(&db).unwrap();
            let claim = dohc_engine_collab::read_marker(&store, &key)
                .unwrap()
                .unwrap()
                .lineage_claim_id;
            let counts = ["moments", "materialization_jobs", "live_device_settlements"]
                .map(|table| store.table_row_count(table).unwrap());
            (claim, counts)
        };
        let supervisor = WorkspaceSupervisor::new();
        let actor = supervisor.open(&db, 200).unwrap().actor;
        actor
            .configure_reader_resolver(Arc::new(
                dohc_engine_collab::reader_resolver::ReaderResolver::new(Arc::new(
                    dohc_engine_reader::Reader::new(Some(markdown_witness_reader(&scratch))),
                )),
            ))
            .await
            .unwrap();
        let update = match operation {
            "open" => {
                actor
                    .ydoc_open_state(
                        WS.into(),
                        201,
                        true,
                        Some(key.clone()),
                        "main".into(),
                        PATH.into(),
                        Some(ContentKind::Richdoc),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap()
                    .initial_update
            }
            "resync" => {
                actor
                    .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
                    .await
                    .unwrap()
                    .initial_update
            }
            _ => {
                actor
                    .ydoc_close_session_materialized(
                        scratch.path().to_owned(),
                        key.clone(),
                        Arc::new(()),
                        201,
                        Arc::new(NoFaults),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap();
                actor
                    .ydoc_open_state(
                        WS.into(),
                        202,
                        true,
                        Some(key.clone()),
                        "main".into(),
                        PATH.into(),
                        Some(ContentKind::Richdoc),
                        CancellationToken::new(),
                    )
                    .await
                    .unwrap()
                    .initial_update
            }
        };
        let doc = Ydoc::wire();
        doc.apply(&update).unwrap();
        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .matches("Accepted parked Markdown edit")
                .count(),
            1
        );
        assert!(doc.has_markdown_witness());
        assert_eq!(deferred_rows(&db), 0);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        supervisor.close(&db).unwrap();
        let actor = supervisor.open(&db, 203).unwrap().actor;
        let reopened = actor
            .ydoc_resync(key.clone(), claim, CancellationToken::new(), None)
            .await
            .unwrap();
        assert_eq!(
            reopened.head_blob_sha256.as_deref(),
            Some(hex_sha256(&bytes).as_str())
        );
        let doc = Ydoc::wire();
        doc.apply(&reopened.initial_update).unwrap();
        assert_eq!(
            doc.project(ContentKind::Richdoc)
                .unwrap()
                .content
                .matches("Accepted parked Markdown edit")
                .count(),
            1
        );
        {
            let store = EngineStore::open_read_only(&db).unwrap();
            assert_eq!(
                ["moments", "materialization_jobs", "live_device_settlements"]
                    .map(|table| store.table_row_count(table).unwrap()),
                counts
            );
            assert!(
                !store
                    .read_with(|conn| markdown_write_obligations::pending_in(conn, WS))
                    .unwrap()
                    .is_empty()
            );
            assert!(
                dohc_engine_sync::list_refusal_notices(&store, WS)
                    .unwrap()
                    .iter()
                    .any(|notice| notice.reason == "markdown-write-held")
            );
        }
        supervisor.close(&db).unwrap();
    }
}

fn markdown_witness_reader(root: &ScratchDir) -> dohc_engine_reader::Config {
    use dohc_engine_storage::hex_sha256;
    let node = std::env::var_os("DOHC_READER_TEST_NODE").unwrap_or_else(|| "node".into());
    let output = std::process::Command::new(node).args(["-p", "JSON.stringify({path:process.execPath,version:process.versions.node,platform:process.platform,arch:process.arch,unicode:process.versions.unicode,icu:process.versions.icu})"]).output().unwrap();
    assert!(output.status.success());
    let mut runtime: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let node = std::path::PathBuf::from(
        runtime
            .as_object_mut()
            .unwrap()
            .remove("path")
            .unwrap()
            .as_str()
            .unwrap(),
    );
    runtime["sha256"] = hex_sha256(&std::fs::read(&node).unwrap()).into();
    let mut manifest = serde_json::json!({"version":1,"runtime":runtime,"buildSha256":"test","parentCwd":std::env::current_dir().unwrap()});
    let script = include_str!("../../dohc-engine-reader/src/fake.cjs")
        .replace("MANIFEST", &manifest.to_string())
        .replace("MODE", "\"witness-unsafe\"");
    let bundle = root.path().join("reader.cjs");
    std::fs::write(&bundle, &script).unwrap();
    manifest["bundleSha256"] = hex_sha256(script.as_bytes()).into();
    manifest["sources"] = serde_json::json!([]);
    let manifest_path = root.path().join("reader-manifest.json");
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    dohc_engine_reader::Config {
        node,
        bundle,
        manifest: manifest_path,
    }
}

/// #1009 (open window): the post-lease open runs its conflict freeze before
/// its deferred drain. A refused open has no event route, so draining first
/// would consume the parked rows with nothing left for the reopen after
/// resolution to drain and emit.
///
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_open_refused_by_a_sync_conflict_keeps_the_parked_queue_for_the_retry() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;

    // An open sync conflict on the object, in the shape
    // `open_sync_conflict_for_object` matches. Seeded directly; only the
    // freeze-vs-drain ordering is under test, not the conflict lifecycle.
    let mut store = EngineStore::open(&db, 200).expect("open conflict seed store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO conflicts (workspace_id, conflict_id, path, target_version_id, \
                 source_version_id, created_at_ms, updated_at_ms, status, chosen_from, \
                 metadata_origin, base_exists, base_path, current_exists, current_path, \
                 incoming_exists, incoming_path, incoming_object_id) \
                 VALUES (?1, 'sync-conflict-parked', ?2, 'main', 'main', 500, 500, \
                 'open', 'none', 'sync', 1, ?2, 1, ?2, 1, ?2, ?3)",
                rusqlite::params![WS, PATH, key.object_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed open sync conflict");
    drop(store);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let refused = handle
        .ydoc_open_state(
            WS.to_owned(),
            200,
            true,
            Some(key.clone()),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect_err("an open sync conflict must freeze the post-lease open");
    assert!(
        format!("{refused:?}").contains("ydoc-conflict-open"),
        "the freeze carries the settle's reason: {refused:?}"
    );
    assert_eq!(
        deferred_rows(&db),
        1,
        "the refused open must not consume the parked queue row"
    );

    // Resolution lifts the freeze; the reopen drains the parked update.
    let mut store = EngineStore::open(&db, 201).expect("open conflict resolve store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE conflicts SET status='resolved' \
                 WHERE workspace_id=?1 AND conflict_id='sync-conflict-parked'",
                [WS],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("resolve conflict");
    drop(store);
    handle
        .ydoc_open_state(
            WS.to_owned(),
            300,
            true,
            Some(key),
            "main".to_owned(),
            PATH.to_owned(),
            None,
            CancellationToken::new(),
        )
        .await
        .expect("reopen after resolution");
    supervisor.close(&db).expect("close actor");
    assert_eq!(deferred_rows(&db), 0, "the reopen drains the parked update");
    assert_eq!(
        applied_update_rows(&db),
        1,
        "the drained update lands exactly once"
    );
}

/// #1009 (close window): a close whose drain-materialization fails must keep
/// the parked queue rows so the retried close can drain again
/// (content-deduped, no duplicated history) and surface their facts.
///
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_that_fails_to_materialize_keeps_the_parked_queue_for_the_retry() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&db, 2).expect("reopen actor").actor;
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterTempWrite);
    handle
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key.clone(),
            Arc::new(()),
            200,
            faults.clone(),
            CancellationToken::new(),
        )
        .await
        .expect_err("the close must report the failed drain materialization");
    assert!(
        faults.fired(),
        "the close drain must reach the injected materialization fault"
    );
    // The drained coordinate is applied and projected, but its queue row —
    // carrying the persisted record facts — survives the failed close.
    assert_eq!(
        deferred_rows(&db),
        1,
        "a close that fails after its drain must keep the parked queue rows"
    );
    let applied_after_failure = applied_update_rows(&db);

    // The retry re-drains content-deduped, materializes, and only then
    // consumes the queue.
    handle
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key,
            Arc::new(()),
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retried close");
    supervisor.close(&db).expect("close actor");
    assert_eq!(
        deferred_rows(&db),
        0,
        "the retried close consumes the queue"
    );
    assert_eq!(
        applied_update_rows(&db),
        applied_after_failure,
        "the retried drain replays content-deduped, never duplicating history"
    );
    assert_eq!(
        std::fs::read_to_string(scratch.path().join(PATH)).expect("materialized head"),
        "before parked",
        "the retried close materializes the drained projection"
    );
}

fn lineage_claim(db: &std::path::Path, key: &DocKey) -> Option<String> {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    dohc_engine_collab::read_marker(&store, key)
        .expect("read marker")
        .expect("marker")
        .lineage_claim_id
}

/// Park one `ydoc.update` from `origin` behind a live session. A base names
/// itself as its lineage. Returns the lineage it parked under.
fn park(
    db: &std::path::Path,
    key: &DocKey,
    (origin, origin_seq, relay_seq): (&str, i64, i64),
    lineage: Option<&str>,
    bytes: &[u8],
) -> String {
    let mut store = EngineStore::open(db, 100).expect("open store");
    let blob_sha = store.put_binary_blob(bytes).expect("blob");
    let lineage = lineage.map_or_else(|| blob_sha.clone(), str::to_owned);
    let envelope = ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.to_owned(),
        origin_id: origin.to_owned(),
        origin_seq,
        relay_seq: Some(relay_seq),
        op_kind: "ydoc.update".to_owned(),
        payload: serde_json::json!({
            "versionId": "main",
            "objectId": key.object_id,
            "path": PATH,
            "contentKind": "plaintext",
            "updateBlobSha256": blob_sha.clone(),
            "lineageClaimId": lineage.clone(),
            "isBaseState": lineage == blob_sha
        }),
        recorded_at_ms: 100 + relay_seq,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &envelope,
        &NoFaults,
        &AlwaysLive,
    )
    .expect("park");
    lineage
}

/// File writes that have not landed: pending, or stopped by a conflict.
fn unfinished_writes(db: &std::path::Path) -> i64 {
    let store = EngineStore::open_read_only(db).expect("open probe store");
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM materialization_jobs \
                 WHERE job_id GLOB 'ydoc-mat_*' AND status IN ('pending','conflict')",
                [],
                |row| row.get::<_, i64>(0),
            )
        })
        .expect("count unfinished writes")
}

fn head_text(db: &std::path::Path) -> String {
    let mut store = EngineStore::open_read_only(db).expect("open probe store");
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .read_text(WS, "main", PATH)
        .expect("read head")
        .expect("head")
        .text
}

fn conflict_files(scratch: &ScratchDir) -> Vec<String> {
    std::fs::read_dir(scratch.path().join("notes"))
        .expect("notes dir")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".conflict"))
        .collect()
}

/// #2813. A resync applies a parked edit without writing the file. Another
/// edit on the same lineage then parks behind the session, and the close
/// applies it. Its write expects the file to hold the resync's edit, so the
/// close must write both pending edits in order, leaving the file equal to
/// the note.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_after_a_resync_brings_the_file_up_to_the_note() {
    use dohc_engine_collab::Ydoc;
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 200).expect("open actor").actor;
    let resynced = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("resync");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before",
        "the resync applies the edit without writing the file"
    );
    assert_eq!(unfinished_writes(&db), 1);
    supervisor.close(&db).expect("close actor");

    let peer = Ydoc::wire();
    peer.apply(&resynced.initial_update).expect("peer state");
    let end = u32::try_from(peer.plaintext_string().encode_utf16().count()).expect("length");
    let again = peer.plaintext_insert(end, " again");
    park(
        &db,
        &key,
        ("peer", 2, 2),
        Some(claim.as_deref().expect("lineage")),
        &again,
    );

    let actor = supervisor.open(&db, 300).expect("reopen actor").actor;
    actor
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key,
            Arc::new(()),
            301,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the close writes every pending edit");
    assert_eq!(deferred_rows(&db), 0);
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before parked again",
        "the file matches the note"
    );
    assert_eq!(head_text(&db), "before parked again");
    assert_eq!(unfinished_writes(&db), 0);
    assert_eq!(conflict_files(&scratch), Vec::<String>::new());
    supervisor.close(&db).expect("close actor");
}

/// The issue's own order: after a resync, a rival version and an edit on it
/// park behind the session. The close replaces the lineage and writes the
/// rival's text over the resync's pending write.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_close_after_a_resync_and_a_rival_version_writes_the_rival() {
    use dohc_engine_collab::Ydoc;
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 200).expect("open actor").actor;
    actor
        .ydoc_resync(key.clone(), claim, CancellationToken::new(), None)
        .await
        .expect("resync");
    supervisor.close(&db).expect("close actor");

    let rival = Ydoc::wire();
    rival.plaintext_insert(0, "rival");
    let rival_base = rival.encode_full_state();
    let rival_edit = rival.plaintext_insert(5, " edit");
    let rival_claim = park(&db, &key, ("rival", 0, 2), None, &rival_base);
    park(&db, &key, ("rival", 1, 3), Some(&rival_claim), &rival_edit);
    assert_eq!(deferred_rows(&db), 2, "the rival's base and edit park");

    let actor = supervisor.open(&db, 300).expect("reopen actor").actor;
    actor
        .ydoc_close_session_materialized(
            scratch.path().to_path_buf(),
            key,
            Arc::new(()),
            301,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("the close writes the rival");
    assert_eq!(deferred_rows(&db), 0);
    assert_eq!(head_text(&db), "rival edit", "the rival is the head");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        head_text(&db),
        "the file matches the note"
    );
    assert_eq!(unfinished_writes(&db), 0);
    assert_eq!(conflict_files(&scratch), Vec::<String>::new());
    supervisor.close(&db).expect("close actor");
}

/// Two resyncs each apply a parked edit without writing the file, and a
/// settle follows with no close between. The head's write expects the file
/// to hold the first resync's edit, so the settle must write both in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settle_after_two_resyncs_writes_both_edits() {
    use dohc_engine_collab::{ContentKind, Ydoc};
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 200).expect("open actor").actor;
    let first = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("first resync");
    supervisor.close(&db).expect("close actor");

    let peer = Ydoc::wire();
    peer.apply(&first.initial_update).expect("peer state");
    let end = u32::try_from(peer.plaintext_string().encode_utf16().count()).expect("length");
    let again = peer.plaintext_insert(end, " again");
    park(
        &db,
        &key,
        ("peer", 2, 2),
        Some(claim.as_deref().expect("lineage")),
        &again,
    );

    let actor = supervisor.open(&db, 300).expect("reopen actor").actor;
    let second = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("second resync");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before",
        "neither resync writes the file"
    );
    assert_eq!(unfinished_writes(&db), 2);
    actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key,
            PATH.into(),
            ContentKind::Plaintext,
            claim,
            second.head_blob_sha256.clone(),
            "two-resyncs".into(),
            Arc::new(()),
            301,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect("the settle writes the file");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before parked again"
    );
    assert_eq!(unfinished_writes(&db), 0);
    supervisor.close(&db).expect("close actor");
}

/// When an older write fails for a passing reason, the settle stops before
/// the head's write, which expects the file to hold the older one. Both stay
/// owed, and a retried settle lands them in order.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settle_whose_older_write_fails_keeps_the_head_for_the_retry() {
    use dohc_engine_collab::{ContentKind, Ydoc};
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 200).expect("open actor").actor;
    let first = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("first resync");
    supervisor.close(&db).expect("close actor");

    let peer = Ydoc::wire();
    peer.apply(&first.initial_update).expect("peer state");
    let end = u32::try_from(peer.plaintext_string().encode_utf16().count()).expect("length");
    let again = peer.plaintext_insert(end, " again");
    park(
        &db,
        &key,
        ("peer", 2, 2),
        Some(claim.as_deref().expect("lineage")),
        &again,
    );

    let actor = supervisor.open(&db, 300).expect("reopen actor").actor;
    let second = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("second resync");
    assert_eq!(unfinished_writes(&db), 2);
    let settle = |faults: Arc<dyn dohc_engine_storage::FaultInjector>, now| {
        actor.ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.into(),
            ContentKind::Plaintext,
            claim.clone(),
            second.head_blob_sha256.clone(),
            "older-write-fails".into(),
            Arc::new(()),
            now,
            faults,
            CancellationToken::new(),
            None,
            None,
        )
    };
    let faults = ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit);
    let refused = settle(faults.clone(), 301)
        .await
        .expect_err("the older write fails, so the settle stops");
    assert!(
        matches!(
            refused,
            dohc_engine_runtime::RuntimeError::Sync(dohc_engine_sync::SyncError::RetryableState {
                reason: "settlement-materialization-pending"
            })
        ),
        "a passing failure asks the caller to retry: {refused:?}"
    );
    assert!(faults.fired(), "the older write reaches the injected fault");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before",
        "nothing is written"
    );
    assert_eq!(unfinished_writes(&db), 2, "both writes stay owed");
    assert_eq!(conflict_files(&scratch), Vec::<String>::new());

    settle(Arc::new(NoFaults), 302)
        .await
        .expect("the retried settle writes the file");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before parked again"
    );
    assert_eq!(unfinished_writes(&db), 0);
    supervisor.close(&db).expect("close actor");
}

/// When an older write fails for a reason that won't pass on its own, here a
/// link in the file's place, the settle stops with that reason rather than
/// asking the caller to retry forever. Once the file is back, a settle lands
/// both writes.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settle_whose_older_write_is_blocked_says_why() {
    use dohc_engine_collab::{ContentKind, Ydoc};
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 200).expect("open actor").actor;
    let first = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("first resync");
    supervisor.close(&db).expect("close actor");

    let peer = Ydoc::wire();
    peer.apply(&first.initial_update).expect("peer state");
    let end = u32::try_from(peer.plaintext_string().encode_utf16().count()).expect("length");
    let again = peer.plaintext_insert(end, " again");
    park(
        &db,
        &key,
        ("peer", 2, 2),
        Some(claim.as_deref().expect("lineage")),
        &again,
    );

    let actor = supervisor.open(&db, 300).expect("reopen actor").actor;
    let second = actor
        .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
        .await
        .expect("second resync");
    assert_eq!(unfinished_writes(&db), 2);
    let settle = |now| {
        actor.ydoc_settle(
            scratch.path().to_path_buf(),
            key.clone(),
            PATH.into(),
            ContentKind::Plaintext,
            claim.clone(),
            second.head_blob_sha256.clone(),
            "older-write-blocked".into(),
            Arc::new(()),
            now,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
    };
    let outside = scratch.path().join("outside.md");
    std::fs::write(&outside, "before").expect("outside file");
    std::fs::remove_file(&file).expect("remove file");
    std::os::unix::fs::symlink(&outside, &file).expect("link in the file's place");
    let refused = settle(301)
        .await
        .expect_err("the older write is blocked, so the settle stops");
    assert!(
        matches!(
            refused,
            dohc_engine_runtime::RuntimeError::Materialize(
                dohc_engine_files::MaterializeError::SymlinkTarget
            )
        ),
        "a link won't go away on its own, so the settle says so: {refused:?}"
    );
    assert_eq!(unfinished_writes(&db), 2, "both writes stay owed");
    assert_eq!(
        std::fs::read_to_string(&outside).expect("outside file"),
        "before",
        "nothing is written through the link"
    );

    std::fs::remove_file(&file).expect("remove link");
    std::fs::write(&file, "before").expect("file back");
    settle(302)
        .await
        .expect("once the file is back, the settle writes it");
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before parked again"
    );
    assert_eq!(unfinished_writes(&db), 0);
    supervisor.close(&db).expect("close actor");
}

/// Three resyncs owe three writes, and an outside edit leaves the file holding
/// what the second would write. The first then conflicts and the second stays
/// owed, but the head's write would find the file it expects. The settle must
/// stop rather than write the head past the owed one, and report the file as
/// changed on disk, as the head's own conflict would.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_settle_whose_older_write_conflicts_does_not_pass_it() {
    use dohc_engine_collab::{ContentKind, Ydoc};
    let scratch = ScratchDir::new().expect("scratch");
    let db = engine_db_path(&scratch).expect("db");
    let key = seed_parked_update(&scratch).await;
    let file = scratch.path().join(PATH);
    let claim = lineage_claim(&db, &key);

    let supervisor = WorkspaceSupervisor::new();
    let mut previous = {
        let actor = supervisor.open(&db, 200).expect("open actor").actor;
        actor
            .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
            .await
            .expect("first resync")
    };
    supervisor.close(&db).expect("close actor");
    for (seq, text) in [(2, " again"), (3, " more")] {
        let peer = Ydoc::wire();
        peer.apply(&previous.initial_update).expect("peer state");
        let end = u32::try_from(peer.plaintext_string().encode_utf16().count()).expect("length");
        let edit = peer.plaintext_insert(end, text);
        park(
            &db,
            &key,
            ("peer", seq, seq),
            Some(claim.as_deref().expect("lineage")),
            &edit,
        );
        let actor = supervisor
            .open(&db, 100 + 100 * seq)
            .expect("reopen actor")
            .actor;
        previous = actor
            .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
            .await
            .expect("resync");
        supervisor.close(&db).expect("close actor");
    }
    assert_eq!(unfinished_writes(&db), 3);
    std::fs::write(&file, "before parked again").expect("outside edit");

    let actor = supervisor.open(&db, 400).expect("reopen actor").actor;
    let refused = actor
        .ydoc_settle(
            scratch.path().to_path_buf(),
            key,
            PATH.into(),
            ContentKind::Plaintext,
            claim,
            previous.head_blob_sha256.clone(),
            "older-write-conflicts".into(),
            Arc::new(()),
            401,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
            None,
        )
        .await
        .expect_err("an older write didn't land, so the settle stops");
    assert!(
        matches!(
            refused,
            dohc_engine_runtime::RuntimeError::Domain(
                dohc_engine_domain::DomainError::ConflictStaleTarget
            )
        ),
        "the outside edit makes the file changed on disk: {refused:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&file).expect("file"),
        "before parked again",
        "the head's write does not pass the owed one"
    );
    supervisor.close(&db).expect("close actor");
}
