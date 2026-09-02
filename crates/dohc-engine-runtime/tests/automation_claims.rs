//! The origin-device automation trigger (ADR 0008) through the real local
//! apply path: a committed `ydoc_record_update` with a registered
//! subscription inserts exactly one pending claim, in the append's own
//! transaction, keyed by the journaled replication coordinate. A replay of
//! the same update dedupes into no second claim, and a peer applying the
//! same ops by replication claims nothing at all — the non-origin device's
//! half of the two-device exactly-once rule.

use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc};
use dohc_engine_domain::{
    AutomationClaimState, AutomationTrigger, ChangeActorKind, ChangeAttribution,
    VersionedTextStore, WriteText, subscribe_automation,
};
use dohc_engine_runtime::{CancellationToken, NoFaults, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_sync::{NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::ScratchDir;
use std::path::Path;
use std::sync::Arc;

const WS: &str = "ws-automation-claims";
const PATH: &str = "tasks/alpha.md";
const OBJECT: &str = "automation-claim-record-object";
const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const AUTOMATION: &str = "plugin:triage";

fn seed_identity(db: &Path, workspace_id: &str) {
    let mut store = EngineStore::open(db, 9_103).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed identity");
}

/// Sync is genuinely on: identity plus a durable relay position.
fn enable_sync(db: &Path, workspace_id: &str) {
    seed_identity(db, workspace_id);
    let mut store = EngineStore::open(db, 9_106).expect("open store");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO sync_relay_push_state \
                 (workspace_id, origin_id, pushed_seq) VALUES (?1, 'origin-local', 0)",
                rusqlite::params![workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enable sync");
}

fn seed_collection_replica(db: &Path, workspace_id: &str, object_id: &str, path: &str, text: &str) {
    let mut store = EngineStore::open(db, 9_110).expect("open collection replica");
    let mut versions = VersionedTextStore::new(&mut store);
    versions
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("collection main version");
    versions
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "collection-schema-object".to_owned(),
                path: "tasks/collection.yaml".to_owned(),
                text: "fields:\n  status:\n    type: text\n".to_owned(),
                moment_id: "collection-schema-moment".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection schema");
    versions
        .write_text(
            &WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: "collection-record-moment".to_owned(),
                metadata_origin: "test".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("seed collection record");
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, workspace_id, "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx,
                workspace_id,
                "main",
                path,
                RECORD,
                "adopted",
            )
        })
        .expect("bind adopted collection record");
}

#[derive(Debug, Clone)]
struct LoggedOp {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

fn local_ydoc_ops(db: &Path) -> Vec<LoggedOp> {
    let store = EngineStore::open(db, 9_100).expect("open store");
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT origin_id, origin_seq, op_kind, payload_json, recorded_at_ms \
                 FROM replication_log WHERE imported = 0 AND op_kind = 'ydoc.update' \
                 ORDER BY origin_id, origin_seq",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    let payload: String = row.get(3)?;
                    Ok(LoggedOp {
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload).expect("payload json"),
                        recorded_at_ms: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read local ops")
}

fn blob_bytes(db: &Path, sha: &str) -> Vec<u8> {
    let store = EngineStore::open(db, 9_104).expect("open store");
    store
        .get_binary_blob(sha)
        .expect("read blob")
        .expect("the journaled blob exists locally")
}

fn claim_rows(db: &Path, workspace_id: &str) -> Vec<(String, String, Option<String>, Option<i64>)> {
    let store = EngineStore::open(db, 9_120).expect("open store");
    store
        .read_with(|conn| {
            let mut stmt = conn.prepare(
                "SELECT automation_id, state, trigger_origin_id, trigger_origin_seq \
                 FROM automation_claims WHERE workspace_id = ?1 \
                 ORDER BY created_at_ms, claim_id",
            )?;
            let rows = stmt
                .query_map([workspace_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok::<_, rusqlite::Error>(rows)
        })
        .expect("read claims")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_local_apply_claims_exactly_once_and_a_synced_apply_never_claims() {
    let initial = format!("---\nid: {RECORD}\nstatus: open\n---\n\nAlpha");
    let source_scratch = ScratchDir::new().expect("source scratch");
    let source_db = source_scratch.engine_db_path().expect("source db");
    let peer_scratch = ScratchDir::new().expect("peer scratch");
    let peer_db = peer_scratch.engine_db_path().expect("peer db");
    seed_collection_replica(&source_db, WS, OBJECT, PATH, &initial);
    seed_collection_replica(&peer_db, WS, OBJECT, PATH, &initial);
    enable_sync(&source_db, WS);

    let supervisor = WorkspaceSupervisor::new();
    let handle = supervisor
        .open(&source_db, 10)
        .expect("open source actor")
        .actor;
    let key = DocKey::new(WS, "main", OBJECT).expect("collection document key");
    let doc = Ydoc::wire();
    doc.rewrite_content_to_markdown(ContentKind::Richdoc, &initial)
        .expect("seed collection rich document");
    let base = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            doc.encode_full_state(),
            None,
            None,
            None,
            true,
            None,
            None,
            100,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("originate collection base");
    assert!(
        base.automation_claims.is_empty(),
        "nothing is subscribed yet, so the seed claims nothing"
    );

    handle
        .automation_subscribe(
            WS.to_owned(),
            AUTOMATION.to_owned(),
            "tasks".to_owned(),
            150,
        )
        .await
        .expect("subscribe automation");

    let edit = doc.frontmatter_set("status", "done");
    let append = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            edit.clone(),
            Some("agent-editor".to_owned()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Agent,
                on_behalf_of: Some("user:ice".to_owned()),
                depth: 0,
            }),
            base.lineage_claim_id.clone(),
            false,
            None,
            None,
            200,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("apply status edit");
    assert!(
        append.outcome.record_facts.is_some(),
        "the status edit derives record facts"
    );
    assert_eq!(
        append.automation_claims.len(),
        1,
        "one subscription, one committed change, exactly one claim"
    );
    let claim = &append.automation_claims[0];
    assert_eq!(claim.automation_id, AUTOMATION);
    assert_eq!(claim.state, AutomationClaimState::Pending);
    assert_eq!(claim.collection_path, "tasks");
    assert_eq!(claim.record_id, RECORD);
    let facts = append
        .outcome
        .record_facts
        .as_ref()
        .expect("the edit derives record facts");
    let (origin_id, origin_seq) = facts
        .source
        .clone()
        .expect("a journaled local apply carries its own coordinate");
    assert_eq!(
        claim.trigger,
        AutomationTrigger::Coordinate {
            origin_id,
            origin_seq,
        },
        "the claim key is the same coordinate every peer derives"
    );

    // The identical update again: the append dedupes, derives no facts, and
    // therefore claims nothing — one durable claim per change, ever.
    let replay = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            edit,
            Some("agent-editor".to_owned()),
            None,
            append.lineage_claim_id.clone(),
            false,
            None,
            None,
            300,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("replay the same update");
    assert!(
        replay.automation_claims.is_empty(),
        "a deduped replay inserts no second claim"
    );

    // A change already at the chain depth cap triggers nothing.
    let capped = doc.frontmatter_set("status", "capped");
    let at_cap = handle
        .ydoc_record_update(
            key.clone(),
            PATH.to_owned(),
            ContentKind::Richdoc,
            Regime::LocalOnly,
            capped,
            Some("agent-editor".to_owned()),
            Some(ChangeAttribution {
                actor_kind: ChangeActorKind::Automation,
                on_behalf_of: Some("user:ice".to_owned()),
                depth: dohc_engine_domain::AUTOMATION_CHAIN_DEPTH_CAP,
            }),
            replay.lineage_claim_id.clone(),
            false,
            None,
            None,
            400,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("apply depth-capped edit");
    assert!(
        at_cap.outcome.record_facts.is_some(),
        "the capped change itself commits"
    );
    assert!(
        at_cap.automation_claims.is_empty(),
        "the chain stops at the depth cap"
    );
    supervisor.close(&source_db).expect("close source actor");

    let source_claims = claim_rows(&source_db, WS);
    assert_eq!(
        source_claims.len(),
        1,
        "the origin device holds exactly one claim for the change: {source_claims:?}"
    );

    // The peer applies the same ops by replication, with the same
    // subscription registered — and claims nothing: the sync apply path has
    // no claim hook (ADR 0008's origin test is structural).
    let mut peer = EngineStore::open(&peer_db, 300).expect("open peer store");
    subscribe_automation(&mut peer, WS, AUTOMATION, "tasks", 310, &NoFaults)
        .expect("peer subscribes the same automation");
    let ops = local_ydoc_ops(&source_db);
    assert!(ops.len() >= 2, "base plus edits journaled: {}", ops.len());
    let first_origin_seq = ops[0].origin_seq;
    for op in &ops {
        let sha = op.payload["updateBlobSha256"]
            .as_str()
            .expect("every ydoc.update names its blob")
            .to_owned();
        let bytes = blob_bytes(&source_db, &sha);
        peer.put_binary_blob(&bytes).expect("copy Y.Doc blob");
        let envelope = ReplicationEnvelope {
            workspace_id: WS.to_owned(),
            origin_id: op.origin_id.clone(),
            origin_seq: op.origin_seq - first_origin_seq,
            relay_seq: Some(op.origin_seq - first_origin_seq),
            op_kind: op.op_kind.clone(),
            payload: op.payload.clone(),
            recorded_at_ms: op.recorded_at_ms,
        };
        apply_ydoc_envelope(&mut peer, &envelope, &NoFaults, &NoLiveLeases)
            .expect("peer applies replicated collection edit");
    }
    drop(peer);
    let peer_claims = claim_rows(&peer_db, WS);
    assert!(
        peer_claims.is_empty(),
        "the non-origin device never claims: {peer_claims:?}"
    );
}
