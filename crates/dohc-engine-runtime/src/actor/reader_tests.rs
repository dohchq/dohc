use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use dohc_engine_collab::{ContentKind, DocKey, Ydoc, reader_resolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_reader::Reader;
use dohc_engine_storage::NoFaults;
use dohc_engine_testkit::{ScratchDir, engine_db_path};

#[tokio::test]
async fn outside_races_dispatch_the_third_observed_proof_before_holding() {
    let data: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/reader-resolver.json"
    ))
    .unwrap();
    let doc = Ydoc::wire();
    doc.apply(
        &STANDARD
            .decode(data["claimedCheckpoint"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let key = DocKey::new("w", "main", "fixture").unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version("w", "main", 1, &NoFaults)
        .unwrap();
    versions
        .write_text(
            &WriteText {
                workspace_id: "w".into(),
                version_id: "main".into(),
                object_id: "fixture".into(),
                path: "note.md".into(),
                text: data["source"].as_str().unwrap().into(),
                moment_id: "initial".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &doc.encode_full_state(),
        &NoFaults,
        3,
    )
    .unwrap();
    store
        .write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET path='note.md'", [])
                .map_err(dohc_engine_storage::StorageError::persist_public)
        })
        .unwrap();
    drop(store);
    let supervisor = crate::WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 4).unwrap().actor;
    let reader = Arc::new(Reader::new(None));
    actor
        .configure_reader_resolver(Arc::new(reader_resolver::ReaderResolver::new(
            reader.clone(),
        )))
        .await
        .unwrap();
    let observations = Arc::new(AtomicU64::new(0));
    let seen = observations.clone();
    let checkpoint = doc.encode_full_state();
    let result = actor
        .run_with_reader_retry(move |store, cache| {
            // Each fresh observation sees a snapshot race after the preceding wait.
            let observation = seen.fetch_add(1, Ordering::SeqCst);
            store.write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE snapshots SET latest_moment_id=?1",
                    [observation.to_string()],
                )
                .map_err(dohc_engine_storage::StorageError::persist_public)
            })?;
            let doc = Ydoc::wire();
            doc.apply(&checkpoint)?;
            store
                .read_with(|conn| {
                    reader_resolver::resolve(
                        conn,
                        &key,
                        &doc,
                        None,
                        cache.reader_resolver.as_deref(),
                    )
                })
                .map_err(RuntimeError::from)
        })
        .await;
    assert!(
        matches!(
            result,
            Err(RuntimeError::Collab(
                dohc_engine_collab::CollabError::MarkdownReaderPending(_)
            ))
        ),
        "{result:?}"
    );
    assert_eq!(observations.load(Ordering::SeqCst), 3);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while reader.dispatch_count() != 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("every miss must dispatch, including the held third observation");
    supervisor.close(&db).unwrap();
}
