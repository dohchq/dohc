use super::*;
use dohc_engine_collab::ydoc::{reading_body_sequence_here, writing_new_notes_in_format_two_here};
use dohc_engine_collab::{LeaseRegistry, LocalAppend, MarkerCreation, record_local_update};
use dohc_engine_domain::WriteText;
use dohc_engine_testkit::ScratchDir;

fn settled_local_note(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    (object_id, path): (&str, &str),
    text: &str,
) -> DocKey {
    let mut versions = VersionedTextStore::new(store);
    versions
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    versions
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: format!("moment-{object_id}"),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 10,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    let key = DocKey::new("ws", "main", object_id).unwrap();
    let base = Ydoc::wire();
    base.rewrite_content_to_markdown(ContentKind::Richdoc, text)
        .unwrap();
    record_local_update(
        store,
        cache,
        &key,
        &base.encode_full_state(),
        LocalAppend {
            marker: Some(MarkerCreation {
                path: Some(path),
                content_kind: ContentKind::Richdoc,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        12,
        |_, _, _| Ok(()),
    )
    .unwrap();
    let projected = base.project(ContentKind::Richdoc).unwrap().content;
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE ydoc_docs SET last_settled_sha=?1, pending_authors_json='[]' \
                 WHERE object_id=?2",
                params![hex_sha256(projected.as_bytes()), object_id],
            )
            .map_err(StorageError::persist_public)
        })
        .unwrap();
    key
}

#[test]
fn converting_a_note_forgets_only_its_writer_cache_entry() {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let mut cache = WriterDocCache::new();
    let converted = settled_local_note(&mut store, &mut cache, ("object-a", "a.md"), "A note.\n");
    let open = settled_local_note(
        &mut store,
        &mut cache,
        ("object-b", "b.md"),
        "Another note.\n",
    );
    assert!(cache.contains_for_test(&converted));
    assert!(cache.contains_for_test(&open));
    let here = LeaseRegistry::new().scoped(scratch.path());
    let _editor = here.acquire(&open).unwrap();
    let pass = writing_new_notes_in_format_two_here(|| {
        reading_body_sequence_here(|| {
            convert_notes_on_store(
                &mut store,
                &mut cache,
                "ws",
                None,
                None,
                10,
                &here,
                Some(&HashSet::new()),
                scratch.path(),
                21,
            )
        })
    })
    .unwrap();
    assert_eq!(pass.converted, vec![converted.clone()]);
    assert_eq!(
        pass.skipped,
        vec![(open.clone(), "b.md".to_owned(), "open-here")]
    );
    assert!(!cache.contains_for_test(&converted));
    assert!(cache.contains_for_test(&open));
}

#[test]
fn a_replicating_workspace_without_a_relay_check_is_refused() {
    let scratch = ScratchDir::new().unwrap();
    let mut store = EngineStore::open(&scratch.path().join("engine.db"), 0).unwrap();
    let mut cache = WriterDocCache::new();
    settled_local_note(&mut store, &mut cache, ("object-a", "a.md"), "A note.\n");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(
                "INSERT INTO sync_identity(workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES('ws','local','epoch','stream',1);
                 INSERT INTO sync_relay_push_state(workspace_id,origin_id,pushed_seq) VALUES('ws','local',0);",
            )
            .map_err(StorageError::corrupt_public)
        })
        .unwrap();
    let changes = |store: &EngineStore| {
        store
            .read_with(|conn| Ok::<_, StorageError>(conn.total_changes()))
            .unwrap()
    };
    let before = changes(&store);
    let here = LeaseRegistry::new().scoped(scratch.path());
    let pass = reading_body_sequence_here(|| {
        convert_notes_on_store(
            &mut store,
            &mut cache,
            "ws",
            None,
            None,
            10,
            &here,
            None,
            scratch.path(),
            21,
        )
    });
    assert!(matches!(
        pass,
        Err(RuntimeError::NoteConversionRelayUnchecked)
    ));
    assert_eq!(changes(&store), before);
}
