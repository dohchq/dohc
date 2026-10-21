//! Build skew at first open. The relay and the owner's desktop each build the
//! first base of one untouched note from the same head, under the same Yjs
//! client, with different constructions: the table-fix parent's (c900b9ee3,
//! frozen in `table-fix-parent.json`) and today's (`candidates.json`). The two
//! bases hold the same document; only the projection digest their witness
//! names differs, so the parent's settles to the engine's canonical text and
//! today's to the file.
//!
//! The first base on the relay wins. In both arrival orders, with the
//! desktop's document closed or open, every device ends on that one lineage,
//! every relayed op is answered for good, what the owner typed survives, and
//! a capture of the settled file completes. An untouched seed adopts a winner
//! whose bytes are the file's quietly; the parent's base, which settles to
//! other bytes, opens a conflict beside the file.
//!
//! Mutation checks: drop the untouched-seed rule in `preserve_base_sides_in_tx`
//! and a desktop whose untouched seed lost writes its own projection over the
//! file as a local moment and opens a conflict. Admit a write on a replaced
//! claim and the edit typed after takeover lands in the winner.

use base64::Engine as _;
use dohc_engine_collab::{ContentKind, DocKey, LeaseRegistry, Regime, WriterDocCache, Ydoc};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, CaptureIngest, NoFaults, RuntimeError, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_sync::{
    AlwaysLive, ApplyDisposition, LeaseProbe, NoLiveLeases, ReplicationEnvelope,
    apply_ydoc_envelope, drain_deferred_ydoc_for_key,
};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use std::path::Path;
use std::sync::Arc;
use yrs::updates::decoder::Decode;

/// The document identity `firstOpenBase.test.ts` builds its candidates under.
const WS: &str = "workspace";
const OBJECT: &str = "object";
const HEAD_MOMENT: &str = "head-moment";
const PATH: &str = "docs/a.md";
const RELAY_ORIGIN: &str = "relay-first-open";
const TYPED_BEFORE: &str = "Typed before adoption";
const TYPED_AFTER: &str = "Typed after adoption";
const TYPED_STALE: &str = "Typed on the seeded claim after takeover";

#[derive(serde::Deserialize)]
struct Candidate {
    name: String,
    markdown: String,
    candidate: String,
}

/// The table note's file and the first base one construction builds for it.
fn table_note(fixture: &str) -> (String, Vec<u8>) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../dohc-engine-collab/tests/first-open-base")
        .join(fixture);
    let rows: Vec<Candidate> =
        serde_json::from_slice(&std::fs::read(path).expect("read fixture")).expect("parse fixture");
    let row = rows
        .into_iter()
        .find(|row| row.name == "table-inline-code")
        .expect("the table note");
    let base = base64::engine::general_purpose::STANDARD
        .decode(row.candidate)
        .expect("base64 candidate");
    (row.markdown, base)
}

fn canonical(base: &[u8]) -> String {
    let doc = Ydoc::wire();
    doc.apply(base).expect("apply base");
    doc.project(ContentKind::Richdoc).expect("project").content
}

/// The one Yjs client that wrote `base`.
fn only_client(base: &[u8]) -> yrs::StateVector {
    let doc = Ydoc::wire();
    doc.apply(base).expect("apply base");
    let clients = yrs::StateVector::decode_v1(&doc.encode_state_vector()).expect("state vector");
    assert_eq!(clients.len(), 1, "a seed has one client");
    clients
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Typing {
    Untouched,
    BeforeAdoption,
    /// The editor reopens on the active lineage, then types.
    AfterAdoption,
    /// The editor keeps the document and claim it seeded and types into them
    /// after the relay's base arrived.
    AfterTakeover,
}

#[derive(Clone, Copy, Debug)]
struct Case {
    desktop_builds_parent: bool,
    relay_base_first: bool,
    desktop_open: bool,
    typing: Typing,
}

/// A synced desktop holding the note at its head, or an empty peer.
fn prepare(db: &Path, head: Option<&str>) {
    let mut store = EngineStore::open(db, 9_300).expect("open store");
    if head.is_some() {
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "INSERT INTO sync_identity \
                     (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                     VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                    [WS],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                     VALUES (?1, 'origin-local', 0)",
                    [WS],
                )
                .map_err(StorageError::persist_public)?;
                Ok::<_, StorageError>(())
            })
            .expect("enable sync");
    }
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .expect("main version");
    if let Some(text) = head {
        versions
            .write_text(
                &WriteText {
                    workspace_id: WS.to_owned(),
                    version_id: "main".to_owned(),
                    object_id: OBJECT.to_owned(),
                    path: PATH.to_owned(),
                    text: text.to_owned(),
                    moment_id: HEAD_MOMENT.to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("write the note");
    }
}

/// Record `update` as the desktop editor's next write, made on `lineage`.
async fn record(
    handle: &ActorHandle,
    key: &DocKey,
    update: Vec<u8>,
    lineage: Option<String>,
    seed: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
) -> Result<Option<String>, RuntimeError> {
    handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            update,
            None,
            None,
            lineage,
            seed.is_some(),
            seed,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
            None,
        )
        .await
        .map(|append| append.lineage_claim_id)
}

async fn open_note(
    handle: &ActorHandle,
) -> Result<dohc_engine_runtime::YdocOpenState, RuntimeError> {
    handle
        .ydoc_open_state(
            WS.to_owned(),
            150,
            true,
            None,
            "main".to_owned(),
            PATH.to_owned(),
            Some(ContentKind::Richdoc),
            CancellationToken::new(),
        )
        .await
}

/// The Y.Doc ops `store` journaled, each with its blob.
fn journaled(store: &EngineStore) -> Vec<(ReplicationEnvelope, Vec<u8>)> {
    let rows: Vec<(String, i64, String, i64)> =
        store
            .read_with(|conn| {
                conn.prepare(
                "SELECT origin_id, origin_seq, payload_json, recorded_at_ms FROM replication_log \
                 WHERE imported = 0 AND op_kind = 'ydoc.update' ORDER BY origin_seq",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
            .collect::<Result<_, _>>()
            })
            .expect("read journaled ops");
    rows.into_iter()
        .map(|(origin_id, origin_seq, payload, recorded_at_ms)| {
            let payload: serde_json::Value = serde_json::from_str(&payload).expect("payload");
            let blob = store
                .get_binary_blob(payload["updateBlobSha256"].as_str().expect("blob"))
                .expect("read blob")
                .expect("journaled blob");
            let envelope = ReplicationEnvelope {
                settlement_admission: None,
                admitted_author_snapshot: None,
                workspace_id: WS.to_owned(),
                origin_id,
                origin_seq,
                relay_seq: None,
                op_kind: "ydoc.update".to_owned(),
                payload,
                recorded_at_ms,
            };
            (envelope, blob)
        })
        .collect()
}

fn is_base(envelope: &ReplicationEnvelope) -> bool {
    envelope.payload["isBaseState"] == serde_json::Value::Bool(true)
}

/// The relay's first-open base, shaped like the desktop's.
fn relay_base(desktop_base: &ReplicationEnvelope, bytes: &[u8]) -> (ReplicationEnvelope, Vec<u8>) {
    let claim = hex_sha256(bytes);
    let mut payload = desktop_base.payload.clone();
    payload["updateBlobSha256"] = claim.clone().into();
    payload["lineageClaimId"] = claim.into();
    let envelope = ReplicationEnvelope {
        origin_id: RELAY_ORIGIN.to_owned(),
        origin_seq: 0,
        payload,
        recorded_at_ms: 300,
        ..desktop_base.clone()
    };
    (envelope, bytes.to_vec())
}

/// What the pull's repair does before it applies a page: learn where this
/// device's own base landed.
fn learn_own_base_position(store: &mut EngineStore, key: &DocKey, own: &ReplicationEnvelope) {
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_collab::record_base_coordinate_in_tx(
                tx,
                dohc_engine_collab::BaseCoordinateRecord {
                    key,
                    lineage_claim_id: own.payload["lineageClaimId"].as_str().expect("claim"),
                    origin_id: &own.origin_id,
                    origin_seq: own.origin_seq,
                    relay_seq: own.relay_seq,
                    now_ms: 450,
                },
            )?;
            tx.execute(
                "DELETE FROM ydoc_base_relay_candidates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                rusqlite::params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(|error| {
                dohc_engine_collab::CollabError::Storage(StorageError::persist_public(error))
            })?;
            Ok::<_, dohc_engine_collab::CollabError>(())
        })
        .expect("learn own base position");
}

/// Apply relayed ops in order. Each must be answered for good: applied,
/// skipped or, while the document is open, parked and then drained.
fn deliver(
    store: &mut EngineStore,
    key: &DocKey,
    ops: &[(ReplicationEnvelope, Vec<u8>)],
    open: bool,
    case: Case,
) {
    let leases: &dyn LeaseProbe = if open { &AlwaysLive } else { &NoLiveLeases };
    for (envelope, blob) in ops {
        store.put_binary_blob(blob).expect("copy blob");
        let outcome = apply_ydoc_envelope(
            store,
            &mut WriterDocCache::new(),
            envelope,
            &NoFaults,
            leases,
        )
        .unwrap_or_else(|error| panic!("{case:?}: {error:?}"));
        match outcome.primary {
            ApplyDisposition::Applied(result) => {
                assert!(
                    open || !result.deferred,
                    "{case:?}: a closed note parks nothing"
                )
            }
            ApplyDisposition::Skipped => {}
            other => panic!(
                "{case:?}: {:?} was not answered: {other:?}",
                envelope.relay_seq
            ),
        }
    }
    if open {
        let drained =
            drain_deferred_ydoc_for_key(store, &mut WriterDocCache::new(), key, &NoFaults)
                .unwrap_or_else(|error| panic!("{case:?}: drain {error:?}"));
        assert!(
            drained.refusals.is_empty(),
            "{case:?}: {:?}",
            drained.refusals
        );
    }
    assert_eq!(
        count(store, "SELECT COUNT(*) FROM ydoc_deferred_updates"),
        0,
        "{case:?}"
    );
}

fn count(store: &EngineStore, sql: &str) -> i64 {
    store
        .read_with(|conn| conn.query_row(sql, [], |row| row.get(0)))
        .expect("count")
}

fn active_lineage(store: &EngineStore) -> (Option<String>, String) {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT lineage_claim_id, lineage_claim_status FROM ydoc_docs WHERE object_id=?1",
                [OBJECT],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
        })
        .expect("read lineage")
}

fn document(store: &EngineStore, key: &DocKey) -> String {
    dohc_engine_collab::load_persisted(store, key)
        .expect("load")
        .expect("lineage")
        .doc
        .project(ContentKind::Richdoc)
        .expect("project")
        .content
}

fn head(store: &EngineStore) -> String {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT b.text FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id = a.workspace_id AND s.object_id = a.object_id \
                 JOIN blobs b ON b.sha256 = s.blob_sha256 \
                 WHERE a.workspace_id = ?1 AND a.version_id = 'main' AND a.path = ?2",
                [WS, PATH],
                |row| row.get(0),
            )
        })
        .expect("read head")
}

async fn race(case: Case, parent: &(String, Vec<u8>), current: &(String, Vec<u8>)) {
    let markdown = current.0.as_str();
    let (desktop_seed, relay_bytes) = if case.desktop_builds_parent {
        (&parent.1, &current.1)
    } else {
        (&current.1, &parent.1)
    };
    let (d_scratch, p_scratch) = (
        ScratchDir::new().expect("scratch"),
        ScratchDir::new().expect("scratch"),
    );
    let d = engine_db_path(&d_scratch).expect("desktop db");
    let p = engine_db_path(&p_scratch).expect("peer db");
    prepare(&d, Some(markdown));
    prepare(&p, None);

    // The desktop opens the note and seeds it under the client the engine names.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&d, 1).expect("open actor").actor;
    let state = open_note(&handle).await.expect("open the note");
    let client = yrs::ClientID::new(u64::from(state.seed_client_id.expect("seed client")));
    assert!(only_client(desktop_seed).get(&client) > 0, "{case:?}");
    let key = state.key.clone();
    let claim = record(
        &handle,
        &key,
        desktop_seed.clone(),
        None,
        state.owner_seed_source,
    )
    .await
    .expect("record the seed");
    // The editor's document, which it keeps until a resync replaces it.
    let editor = Ydoc::wire();
    editor.apply(desktop_seed).expect("apply seed");
    if case.typing == Typing::BeforeAdoption {
        record(
            &handle,
            &key,
            editor.richdoc_append_paragraph(TYPED_BEFORE),
            claim.clone(),
            None,
        )
        .await
        .expect("record the typing");
    }
    supervisor.close(&d).expect("close actor");

    // The relay log, in one of the two arrival orders.
    let mut d_store = EngineStore::open(&d, 9_301).expect("open desktop");
    let desktop_ops = journaled(&d_store);
    assert!(
        is_base(&desktop_ops[0].0),
        "{case:?}: the desktop originated its base"
    );
    let relayed = relay_base(&desktop_ops[0].0, relay_bytes);
    let mut log = if case.relay_base_first {
        [vec![relayed], desktop_ops.clone()].concat()
    } else {
        [desktop_ops.clone(), vec![relayed]].concat()
    };
    for (seq, (envelope, _)) in log.iter_mut().enumerate() {
        envelope.relay_seq = Some(seq as i64 + 1);
    }
    let winner = log[0].0.payload["lineageClaimId"]
        .as_str()
        .expect("claim")
        .to_owned();
    let desktop_lost = case.relay_base_first;
    // Only a winner whose bytes are the file's is adopted quietly. The
    // parent's base settles to the canonical text, so winning over today's
    // seed it opens a conflict beside the file.
    let conflict_opens = desktop_lost && !case.desktop_builds_parent;

    // The desktop pushed, then pulls: it learns where its base landed and
    // applies the relay's base. Its own ops are not delivered back.
    let own_base = log
        .iter()
        .find(|(op, _)| op.origin_id != RELAY_ORIGIN && is_base(op))
        .expect("own base");
    learn_own_base_position(&mut d_store, &key, &own_base.0);
    let from_relay: Vec<_> = log
        .iter()
        .filter(|(op, _)| op.origin_id == RELAY_ORIGIN)
        .cloned()
        .collect();
    deliver(&mut d_store, &key, &from_relay, case.desktop_open, case);
    assert_eq!(
        journaled(&d_store).len(),
        desktop_ops.len(),
        "{case:?}: adoption publishes nothing"
    );
    drop(d_store);

    // After adoption the editor binds to the active lineage and types. An
    // open conflict holds the note until the person chooses a side.
    if case.typing == Typing::AfterAdoption {
        let supervisor = WorkspaceSupervisor::new();
        let handle = supervisor.open(&d, 1).expect("open actor").actor;
        let opened = open_note(&handle).await;
        if conflict_opens {
            assert!(
                matches!(
                    opened,
                    Err(RuntimeError::Domain(
                        dohc_engine_domain::DomainError::InvalidInput {
                            reason: "ydoc-conflict-open"
                        }
                    ))
                ),
                "{case:?}: {opened:?}"
            );
        } else {
            let state = opened.expect("open the note");
            assert_eq!(
                state.lineage_claim_id.as_deref(),
                Some(winner.as_str()),
                "{case:?}"
            );
            let doc = Ydoc::wire();
            doc.apply(&state.initial_update).expect("apply open state");
            record(
                &handle,
                &key,
                doc.richdoc_append_paragraph(TYPED_AFTER),
                state.lineage_claim_id,
                None,
            )
            .await
            .expect("record the typing");
        }
        supervisor.close(&d).expect("close actor");
    }

    // The editor still holds the document and claim it seeded and types into
    // them. A losing claim is refused by name, and the resync hands over the
    // winner as another device's lineage, so the editor keeps its document
    // with the unsent edit and never replays it into the winner.
    if case.typing == Typing::AfterTakeover {
        let supervisor = WorkspaceSupervisor::new();
        let handle = supervisor.open(&d, 1).expect("open actor").actor;
        let written = record(
            &handle,
            &key,
            editor.richdoc_append_paragraph(TYPED_STALE),
            claim.clone(),
            None,
        )
        .await;
        if desktop_lost {
            match written {
                Err(RuntimeError::Collab(dohc_engine_collab::CollabError::LineageWriteStale {
                    expected,
                    observed,
                })) => {
                    assert_eq!(expected, claim, "{case:?}");
                    assert_eq!(observed.as_deref(), Some(winner.as_str()), "{case:?}");
                }
                other => panic!("{case:?}: a losing claim's write landed: {other:?}"),
            }
            let resynced = handle
                .ydoc_resync(key.clone(), claim.clone(), CancellationToken::new(), None)
                .await
                .unwrap_or_else(|error| panic!("{case:?}: resync {error:?}"));
            assert_eq!(
                resynced.lineage_claim_id.as_deref(),
                Some(winner.as_str()),
                "{case:?}"
            );
            assert!(!resynced.lineage_originated_here, "{case:?}");
            assert!(
                !canonical(&resynced.initial_update).contains(TYPED_STALE),
                "{case:?}"
            );
            assert!(
                editor
                    .project(ContentKind::Richdoc)
                    .expect("project")
                    .content
                    .contains(TYPED_STALE),
                "{case:?}: the editor keeps the unsent edit"
            );
        } else {
            assert_eq!(
                written.unwrap_or_else(|error| panic!("{case:?}: {error:?}")),
                Some(winner.clone()),
                "{case:?}: the winning claim takes the edit"
            );
        }
        supervisor.close(&d).expect("close actor");
    }
    let mut typed = journaled(&EngineStore::open(&d, 9_302).expect("open desktop"))
        [desktop_ops.len()..]
        .to_vec();
    // What the owner typed that the winning lineage takes.
    let typed_on_winner = match case.typing {
        Typing::Untouched => None,
        Typing::BeforeAdoption => (!desktop_lost).then_some(TYPED_BEFORE),
        Typing::AfterAdoption => (!conflict_opens).then_some(TYPED_AFTER),
        Typing::AfterTakeover => (!desktop_lost).then_some(TYPED_STALE),
    };
    assert_eq!(
        typed.len(),
        usize::from(typed_on_winner.is_some() && case.typing != Typing::BeforeAdoption),
        "{case:?}: only an edit on the winner is journaled after delivery, once"
    );
    for (envelope, _) in &mut typed {
        envelope.relay_seq = Some(log.len() as i64 + 1);
    }
    log.extend(typed);

    // A peer with no copy of the note pulls the whole log.
    let mut p_store = EngineStore::open(&p, 9_303).expect("open peer");
    deliver(&mut p_store, &key, &log, false, case);

    let d_store = EngineStore::open(&d, 9_304).expect("open desktop");
    for store in [&d_store, &p_store] {
        assert_eq!(
            active_lineage(store),
            (Some(winner.clone()), "exact".to_owned()),
            "{case:?}: one lineage"
        );
    }
    assert_eq!(
        document(&d_store, &key),
        document(&p_store, &key),
        "{case:?}: one document"
    );
    let conflicts = count(
        &d_store,
        "SELECT COUNT(*) FROM conflicts WHERE status='open'",
    );
    for store in [&d_store, &p_store] {
        assert!(
            !document(store, &key).contains(TYPED_STALE) || typed_on_winner == Some(TYPED_STALE),
            "{case:?}: a losing claim's edit enters no device's winning document"
        );
    }
    match (case.typing, typed_on_winner) {
        (Typing::BeforeAdoption, None) => {
            // The losing edit stays the desktop's side of the conflict and
            // enters no device's winning document.
            assert_eq!(conflicts, 1, "{case:?}");
            let kept = d_store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT c.text FROM conflicts f JOIN blobs c ON c.sha256=f.current_blob_sha256 \
                         WHERE f.status='open'",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                })
                .expect("read the desktop's side");
            assert!(kept.contains(TYPED_BEFORE), "{case:?}: {kept:?}");
            assert!(!document(&p_store, &key).contains(TYPED_BEFORE), "{case:?}");
        }
        (_, Some(typed)) => {
            assert_eq!(conflicts, 0, "{case:?}");
            assert!(document(&p_store, &key).contains(typed), "{case:?}");
        }
        // The engine holds nothing the owner typed, only the desktop's seed.
        (_, None) => {
            assert_eq!(
                count(
                    &d_store,
                    "SELECT COUNT(*) FROM moments WHERE moment_id LIKE '%-local'"
                ),
                0,
                "{case:?}: an untouched seed writes no local moment"
            );
            assert_eq!(
                count(&d_store, "SELECT COUNT(*) FROM ydoc_recovery_decisions"),
                0,
                "{case:?}"
            );
            assert_eq!(
                head(&d_store),
                markdown,
                "{case:?}: the file keeps the note"
            );
            if conflict_opens {
                assert_eq!(conflicts, 1, "{case:?}");
                let sides = d_store
                    .read_with(|conn| {
                        conn.query_row(
                            "SELECT c.text, i.text FROM conflicts f \
                             JOIN blobs c ON c.sha256=f.current_blob_sha256 \
                             JOIN blobs i ON i.sha256=f.incoming_blob_sha256 \
                             WHERE f.status='open'",
                            [],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        )
                    })
                    .expect("read the conflict");
                assert_eq!(
                    sides,
                    (markdown.to_owned(), canonical(relay_bytes)),
                    "{case:?}"
                );
            } else {
                assert_eq!(
                    conflicts, 0,
                    "{case:?}: an untouched seed of the file's bytes opens no conflict"
                );
            }
        }
    }
    drop((d_store, p_store));

    // Capture sees the settled file land on disk; it completes and leaves the
    // lineage in place.
    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor.open(&d, 1).expect("open actor").actor;
    let text = head(&EngineStore::open(&d, 9_305).expect("open desktop"));
    handle
        .capture_ingest(
            CaptureIngest {
                workspace_id: WS.to_owned(),
                version_id: "main".to_owned(),
                path: PATH.to_owned(),
                text,
                metadata_origin: "capture".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 900,
                request_id: None,
                claim_foreign_head: true,
            },
            LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("{case:?}: capture {error:?}"));
    supervisor.close(&d).expect("close actor");
    let d_store = EngineStore::open(&d, 9_306).expect("open desktop");
    assert_eq!(
        active_lineage(&d_store).0.as_deref(),
        Some(winner.as_str()),
        "{case:?}"
    );
    assert_eq!(
        count(
            &d_store,
            "SELECT COUNT(*) FROM conflicts WHERE status='open'"
        ),
        conflicts,
        "{case:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn first_open_build_skew_keeps_one_lineage_in_both_arrival_orders() {
    let parent = table_note("table-fix-parent.json");
    let current = table_note("candidates.json");
    assert_eq!(
        parent.0, current.0,
        "both constructions build the same note"
    );
    assert_ne!(parent.1, current.1, "the constructions differ");
    assert_eq!(
        canonical(&parent.1),
        canonical(&current.1),
        "into one document"
    );
    assert_ne!(
        canonical(&current.1),
        current.0,
        "whose canonical text is not the file"
    );
    assert_eq!(
        only_client(&parent.1),
        only_client(&current.1),
        "under one client"
    );
    let notes = Arc::new((parent, current));
    let mut races = tokio::task::JoinSet::new();
    for desktop_builds_parent in [true, false] {
        for relay_base_first in [true, false] {
            // Only a losing desktop parks the relay's base while it is open.
            for desktop_open in [false, true]
                .into_iter()
                .filter(|open| relay_base_first || !open)
            {
                for typing in [
                    Typing::Untouched,
                    Typing::BeforeAdoption,
                    Typing::AfterAdoption,
                    Typing::AfterTakeover,
                ] {
                    let case = Case {
                        desktop_builds_parent,
                        relay_base_first,
                        desktop_open,
                        typing,
                    };
                    let notes = Arc::clone(&notes);
                    races.spawn(async move { race(case, &notes.0, &notes.1).await });
                }
            }
        }
    }
    while let Some(raced) = races.join_next().await {
        raced.expect("race");
    }
}
