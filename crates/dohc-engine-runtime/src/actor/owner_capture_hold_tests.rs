//! On the owner's own computer a shared note is live through its owner
//! binding, with no relay activation. Capture holds a file that changed
//! outside dohc there: no moment and one held row. While the binding stays,
//! the same bytes are not read again (#4003's D1 rule).
//! Keep a copy's write of the recorded bytes ends the hold and leaves the
//! owner's draft as it was (#4003, #2756).
use crate::{CancellationToken, CaptureIngest, RuntimeError, WorkspaceSupervisor};
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::owner_outbox::{
    OwnerOutboxLimits, OwnerOutboxQuarantineInput,
    draft::{ObservedOwnerBinding, append_draft_in_tx, install_observed_binding_in_tx},
};
use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Ydoc};
use dohc_engine_storage::{EngineStore, NoFaults, TxnOutcome, hex_sha256};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::OpenFlags;
use std::path::Path;
use std::sync::Arc;

const PATH: &str = "owner.md";
const OUTSIDE: &str = "Changed outside dohc.\n";

/// The desktop's shape: `owner.md` recorded, its lineage claimed, and the
/// owner's binding installed, with no activation. With `quarantined`, the
/// owner typed and the draft holding that typing was quarantined. Returns
/// the recorded text.
fn bound_owner(db: &Path, quarantined: bool) -> String {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let markdown = fixture["markdown"].as_str().unwrap().to_owned();
    let mut store = EngineStore::open(db, 1_000).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: PATH.into(),
                text: markdown.clone(),
                moment_id: "owned".into(),
                metadata_origin: "test".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    dohc_engine_sync::adopt_join_identity(
        &mut store, "ws", "local", "epoch", "stream", 1, &NoFaults,
    )
    .unwrap();
    let key = DocKey::new("ws", "main", "object").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        ContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    store.read_with(|conn| conn.execute("UPDATE ydoc_docs SET path=?1", [PATH])).unwrap();
    let checkpoint = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap()
        .encode_full_state();
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: hex_sha256(&original),
        current_path: PATH.into(),
        selector_paths: vec![PATH.into()],
        restore_fence_generation: 0,
    };
    let observed = ObservedOwnerBinding {
        binding: binding.clone(),
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: store
            .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
        })
        .unwrap();
    if quarantined {
        let typed = Ydoc::wire();
        typed.apply(&checkpoint).unwrap();
        let update = typed.richdoc_append_paragraph("OWNER-1");
        let TxnOutcome::Committed(draft) = store
            .write_with(&NoFaults, |tx| {
                append_draft_in_tx(tx, "ws", &binding, 1, "typed".into(), update, 3)
            })
            .unwrap()
        else {
            panic!("draft must commit")
        };
        dohc_engine_collab::owner_outbox::quarantine(
            &mut store,
            "ws",
            OwnerOutboxQuarantineInput {
                outbox_id: draft.outbox_id,
                reason: "binding-changed".into(),
                observed_binding: None,
            },
            4,
        )
        .unwrap();
    }
    markdown
}

/// Moments, held rows, owner rows and activations, as one comparable value.
type Observed = (i64, Vec<(String, String, i64)>, Vec<String>, i64);

fn observe(db: &Path) -> Observed {
    let conn = rusqlite::Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
    let held = conn
        .prepare(
            "SELECT path,observed_sha256,observed_at_ms FROM held_outside_changes ORDER BY path",
        )
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let owner = conn
        .prepare(
            "SELECT json_array(o.outbox_id,o.state,o.pending_bytes,o.quarantine_reason,b.binding_revision,b.accepted_cursor) \
             FROM ydoc_owner_bindings b LEFT JOIN owner_ydoc_outboxes o ON o.workspace_id=b.workspace_id \
             AND o.main_version_id=b.main_version_id AND o.object_id=b.object_id ORDER BY 1",
        )
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    (
        count("SELECT COUNT(*) FROM moments"),
        held,
        owner,
        count("SELECT COUNT(*) FROM live_owner_activations"),
    )
}

async fn held_then_kept(quarantined: bool) {
    let scratch = ScratchDir::new().unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let recorded = bound_owner(&db, quarantined);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 5).unwrap().actor;
    let capture = |text: &str, now_ms: i64| {
        let actor = actor.clone();
        let text = text.to_owned();
        async move {
            actor
                .capture_ingest(
                    CaptureIngest {
                        workspace_id: "ws".into(),
                        version_id: "main".into(),
                        path: PATH.into(),
                        text,
                        metadata_origin: "capture".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms,
                        request_id: None,
                        claim_foreign_head: true,
                    },
                    LeaseRegistry::new(),
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await
        }
    };
    let (moments, held, owner, activations) = observe(&db);
    assert_eq!((held.len(), activations), (0, 0), "the desktop's shape");
    assert_eq!(owner.len(), 1, "one binding: {owner:?}");
    assert_eq!(owner[0].contains("quarantined"), quarantined, "the draft: {owner:?}");

    for now_ms in [10, 11] {
        let error = capture(OUTSIDE, now_ms).await.unwrap_err();
        assert!(
            matches!(error, RuntimeError::CaptureFileHeld { .. }),
            "an outside change to a bound note is held, not refused: {error:?}"
        );
    }
    assert_eq!(
        observe(&db),
        (
            moments,
            vec![(PATH.to_owned(), hex_sha256(OUTSIDE.as_bytes()), 10)],
            owner.clone(),
            0
        ),
        "no moment, the owner's rows as they were, and the second read stopped at the hold"
    );

    // Keep a copy writes the recorded bytes back over the file.
    capture(&recorded, 12).await.expect("the file holds the recorded bytes again");
    assert_eq!(
        observe(&db),
        (moments, vec![], owner, 0),
        "the hold ends with no moment and the draft as it was"
    );
    supervisor.close(&db).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_outside_change_to_a_bound_note_is_held_until_kept() {
    held_then_kept(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quarantined_draft_holds_and_keeps_its_recovery_row() {
    held_then_kept(true).await;
}
